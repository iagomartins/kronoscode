/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Command } from '../../../../../editor/common/languages.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { isCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import { IChatProgress } from '../../common/chatService/chatService.js';
import {
	IChatAgentData,
	IChatAgentHistoryEntry,
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
} from '../../common/participants/chatAgents.js';
import {
	ChatMessageRole,
	IChatMessage,
	ILanguageModelsService,
} from '../../common/languageModels.js';
import { KRONOS_K2_API_KEY_SETTING, KRONOS_K2_MODEL_ADAPTIVE, KRONOS_K2_MODEL_SETTING } from './k2Configuration.js';
import { getK2ApiKey, K2_IDENTIFIER_ADAPTIVE, K2_IDENTIFIER_CODE, K2_IDENTIFIER_HIGHSPEED, K2_IDENTIFIER_K25, K2_IDENTIFIER_K26 } from './k2LanguageModelProvider.js';

export const KRONOS_AGENT_ID = 'kronos.agent';

/**
 * Maps a `kronosCode.k2Model` setting value to the fully-qualified language
 * model identifier used with {@link ILanguageModelsService.sendChatRequest}.
 */
function resolveModelIdentifier(settingValue: string | undefined): string {
	switch (settingValue) {
		case 'kimi-k2.7-code': return K2_IDENTIFIER_CODE;
		case 'kimi-k2.6': return K2_IDENTIFIER_K26;
		case 'kimi-k2.5': return K2_IDENTIFIER_K25;
		case 'kimi-k2.7-code-highspeed': return K2_IDENTIFIER_HIGHSPEED;
		case KRONOS_K2_MODEL_ADAPTIVE:
		default:
			return K2_IDENTIFIER_ADAPTIVE;
	}
}

export function buildKronosAgentData(): IChatAgentData {
	return {
		id: KRONOS_AGENT_ID,
		name: 'kronos',
		fullName: 'Kronos',
		description: localize('kronosAgent.description', "Kronos Code's built-in AI agent, powered by the Moonshot K2 API."),
		extensionId: new ExtensionIdentifier('kronos.k2'),
		extensionVersion: undefined,
		extensionPublisherId: 'kronos',
		extensionDisplayName: 'Kronos Code',
		isDefault: true,
		isDynamic: true,
		isCore: true,
		metadata: {},
		slashCommands: [],
		locations: [ChatAgentLocation.Chat, ChatAgentLocation.Terminal, ChatAgentLocation.Notebook, ChatAgentLocation.EditorInline],
		modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
		disambiguation: [],
	};
}

/**
 * Implementation of the `@kronos` default chat agent. Talks directly to the
 * K2 language model provider (registered under {@link K2_VENDOR_ID}) via
 * {@link ILanguageModelsService}, so it reuses the existing HTTP/SSE and
 * payload-constraint logic in `k2LanguageModelProvider.ts`.
 */
export class K2ChatAgentImplementation implements IChatAgentImplementation {

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEditorService private readonly _editorService: IEditorService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const apiKey = getK2ApiKey(this._configurationService);
		if (!apiKey) {
			progress([this._buildMissingApiKeyProgress()]);
			return {};
		}

		const messages = this._buildMessages(request, history);
		const modelId = request.userSelectedModelId ?? resolveModelIdentifier(this._configurationService.getValue<string>(KRONOS_K2_MODEL_SETTING));

		try {
			const response = await this._languageModelsService.sendChatRequest(modelId, undefined, messages, {}, token);

			for await (const part of response.stream) {
				const parts = Array.isArray(part) ? part : [part];
				for (const p of parts) {
					if (token.isCancellationRequested) {
						return {};
					}
					if (p.type === 'text' && p.value) {
						progress([{ kind: 'markdownContent', content: new MarkdownString(p.value) }]);
					}
				}
			}

			await response.result;
			return {};
		} catch (err) {
			this._logService.error('[Kronos] Chat agent request failed:', err);
			return {
				errorDetails: {
					message: err instanceof Error ? err.message : String(err),
				},
			};
		}
	}

	private _buildMissingApiKeyProgress(): IChatProgress {
		const command: Command = {
			id: 'workbench.action.openSettings',
			title: localize('kronosAgent.setApiKeyButton', "Set K2 API Key"),
			arguments: [KRONOS_K2_API_KEY_SETTING],
		};
		return {
			kind: 'command',
			command,
		};
	}

	private _buildMessages(request: IChatAgentRequest, history: IChatAgentHistoryEntry[]): IChatMessage[] {
		const messages: IChatMessage[] = [];

		const editorContext = this._getActiveEditorContext();
		if (editorContext) {
			messages.push({ role: ChatMessageRole.System, content: [{ type: 'text', value: editorContext }] });
		}

		for (const entry of history) {
			messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: entry.request.message }] });
			const responseText = entry.response
				.filter((r): r is { kind: 'markdownContent'; content: { value: string } } => (r as { kind?: string }).kind === 'markdownContent')
				.map(r => r.content.value)
				.join('');
			if (responseText) {
				messages.push({ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: responseText }] });
			}
		}

		messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: request.message }] });

		return messages;
	}

	private _getActiveEditorContext(): string | undefined {
		const control = this._editorService.activeTextEditorControl;
		if (!control || !isCodeEditor(control)) {
			return undefined;
		}
		const model = control.getModel();
		if (!model) {
			return undefined;
		}
		const selection = control.getSelection();
		const selectedText = selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined;
		const uri = model.uri.toString();

		if (selectedText) {
			return `Active selection in ${uri}:\n\`\`\`\n${selectedText}\n\`\`\``;
		}

		const fullText = model.getValue();
		if (fullText) {
			return `Active file ${uri}:\n\`\`\`\n${fullText}\n\`\`\``;
		}
		return undefined;
	}
}
