/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { KRONOS_K2_API_KEY_SETTING } from './k2Configuration.js';
import {
	ChatAgentLocation,
} from '../../common/constants.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatMessagePart,
	IChatResponsePart,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatMetadata,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
} from '../../common/languageModels.js';
import { k2AdaptiveRoute } from './k2AdaptiveRouter.js';

export const K2_VENDOR_ID = 'k2';
export const K2_API_BASE_URL = 'https://api.moonshot.cn/v1';

export const K2_MODEL_HIGHSPEED = 'kimi-k2.7-code-highspeed';
export const K2_MODEL_CODE = 'kimi-k2.7-code';
export const K2_MODEL_K26 = 'kimi-k2.6';
export const K2_MODEL_K25 = 'kimi-k2.5';
export const K2_MODEL_ADAPTIVE = 'k2-adaptive';

export const K2_IDENTIFIER_HIGHSPEED = `${K2_VENDOR_ID}/${K2_MODEL_HIGHSPEED}`;
export const K2_IDENTIFIER_CODE = `${K2_VENDOR_ID}/${K2_MODEL_CODE}`;
export const K2_IDENTIFIER_K26 = `${K2_VENDOR_ID}/${K2_MODEL_K26}`;
export const K2_IDENTIFIER_K25 = `${K2_VENDOR_ID}/${K2_MODEL_K25}`;
export const K2_IDENTIFIER_ADAPTIVE = `${K2_VENDOR_ID}/${K2_MODEL_ADAPTIVE}`;

export function getK2ApiKey(configurationService: IConfigurationService): string {
	// Primary: Settings UI (kronosCode.k2ApiKey). Fallback: K2_API_KEY environment variable.
	const fromSettings = configurationService.getValue<string>(KRONOS_K2_API_KEY_SETTING);
	if (fromSettings) {
		return fromSettings;
	}
	return (typeof process !== 'undefined' && process.env?.K2_API_KEY) || '';
}

function buildModelMetadata(id: string, name: string, maxInputTokens: number, maxOutputTokens: number, isDefault: boolean): ILanguageModelChatMetadata {
	return {
		extension: new ExtensionIdentifier('kronos.k2'),
		name,
		id,
		vendor: K2_VENDOR_ID,
		version: '1.0.0',
		family: 'k2',
		maxInputTokens,
		maxOutputTokens,
		isDefaultForLocation: isDefault ? {
			[ChatAgentLocation.Chat]: true,
			[ChatAgentLocation.Terminal]: true,
			[ChatAgentLocation.Notebook]: true,
			[ChatAgentLocation.EditorInline]: true,
		} : {},
		isUserSelectable: true,
		capabilities: {
			vision: false,
			toolCalling: true,
			agentMode: true,
		},
	};
}

interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | Array<{ type: string; text?: string; tool_call_id?: string }>;
	name?: string;
	tool_call_id?: string;
}

interface OpenAIRequestBody {
	model: string;
	messages: OpenAIMessage[];
	temperature: number;
	top_p: number;
	presence_penalty: number;
	frequency_penalty: number;
	n: number;
	stream: boolean;
	thinking: { type: 'enabled' };
	tool_choice?: 'auto' | 'none';
	tools?: unknown[];
}

function chatMessageRoleToOpenAI(role: ChatMessageRole): 'system' | 'user' | 'assistant' {
	switch (role) {
		case ChatMessageRole.System: return 'system';
		case ChatMessageRole.User: return 'user';
		case ChatMessageRole.Assistant: return 'assistant';
		default: return 'user';
	}
}

function partsToText(parts: IChatMessagePart[]): string {
	let text = '';
	for (const part of parts) {
		if (part.type === 'text') {
			text += part.value;
		} else if (part.type === 'thinking') {
			// Include thinking content as text
			text += Array.isArray(part.value) ? part.value.join('') : part.value;
		}
	}
	return text;
}

function convertMessages(messages: IChatMessage[]): OpenAIMessage[] {
	return messages.map(msg => ({
		role: chatMessageRoleToOpenAI(msg.role),
		content: partsToText(msg.content),
		...(msg.name ? { name: msg.name } : {}),
	}));
}

function estimateTokenCount(text: string): number {
	// Simple heuristic: ~4 characters per token on average
	return Math.ceil(text.length / 4);
}

export class K2LanguageModelProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IRequestService private readonly _requestService: IRequestService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		return [
			{
				metadata: buildModelMetadata(K2_MODEL_ADAPTIVE, 'Adaptive', 128000, 8192, true),
				identifier: K2_IDENTIFIER_ADAPTIVE,
			},
			{
				metadata: buildModelMetadata(K2_MODEL_HIGHSPEED, 'K2.7 Code (Highspeed)', 128000, 8192, false),
				identifier: K2_IDENTIFIER_HIGHSPEED,
			},
			{
				metadata: buildModelMetadata(K2_MODEL_CODE, 'K2.7 Code', 128000, 8192, false),
				identifier: K2_IDENTIFIER_CODE,
			},
			{
				metadata: buildModelMetadata(K2_MODEL_K26, 'K2.6', 128000, 8192, false),
				identifier: K2_IDENTIFIER_K26,
			},
			{
				metadata: buildModelMetadata(K2_MODEL_K25, 'K2.5', 128000, 8192, false),
				identifier: K2_IDENTIFIER_K25,
			},
		];
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const apiKey = getK2ApiKey(this._configurationService);
		if (!apiKey) {
			throw new Error('K2 API key is not configured. Set kronosCode.k2ApiKey in Settings, or the K2_API_KEY environment variable.');
		}

		// Resolve model: if adaptive, route based on context size
		let resolvedModel: string;
		if (modelId === K2_IDENTIFIER_ADAPTIVE || modelId === K2_MODEL_ADAPTIVE) {
			const totalText = messages.map(m => partsToText(m.content)).join('');
			resolvedModel = k2AdaptiveRoute(estimateTokenCount(totalText), totalText);
		} else if (modelId === K2_IDENTIFIER_CODE || modelId === K2_MODEL_CODE) {
			resolvedModel = K2_MODEL_CODE;
		} else if (modelId === K2_IDENTIFIER_K26 || modelId === K2_MODEL_K26) {
			resolvedModel = K2_MODEL_K26;
		} else if (modelId === K2_IDENTIFIER_K25 || modelId === K2_MODEL_K25) {
			resolvedModel = K2_MODEL_K25;
		} else {
			resolvedModel = K2_MODEL_HIGHSPEED;
		}

		const openAIMessages = convertMessages(messages);

		// Enforce K2 parameter constraints
		let toolChoice: 'auto' | 'none' | undefined;
		if (options.modelOptions?.['tool_choice']) {
			const tc = options.modelOptions['tool_choice'];
			if (tc === 'auto' || tc === 'none') {
				toolChoice = tc;
			} else {
				toolChoice = 'auto';
			}
		}

		const body: OpenAIRequestBody = {
			model: resolvedModel,
			messages: openAIMessages,
			temperature: 1.0,
			top_p: 0.95,
			presence_penalty: 0.0,
			frequency_penalty: 0.0,
			n: 1,
			stream: true,
			thinking: { type: 'enabled' },
			...(toolChoice ? { tool_choice: toolChoice } : {}),
			...(options.modelOptions?.['tools'] ? { tools: options.modelOptions['tools'] as unknown[] } : {}),
		};

		this._logService.trace('[K2] Sending chat request', resolvedModel, messages.length, 'messages');

		const url = `${K2_API_BASE_URL}/chat/completions`;
		const requestBody = JSON.stringify(body);

		const response = await this._requestService.request({
			type: 'POST',
			url,
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			data: requestBody,
			callSite: 'k2LanguageModelProvider',
		}, token);

		if (response.res.statusCode && (response.res.statusCode < 200 || response.res.statusCode >= 300)) {
			// Try to read the error body
			const chunks: string[] = [];
			await new Promise<void>((resolve) => {
				response.stream.on('data', (chunk) => { chunks.push(chunk.toString()); });
				response.stream.on('end', () => resolve());
				response.stream.on('error', () => resolve());
			});
			const errorBody = chunks.join('');
			throw new Error(`K2 API error (${response.res.statusCode}): ${errorBody}`);
		}

		// Parse SSE stream into async iterable
		const { stream, completionPromise } = this._createResponseStream(response);

		return { stream, result: completionPromise };
	}

	private _createResponseStream(response: { res: { headers: import('../../../../../base/parts/request/common/request.js').IHeaders; statusCode?: number }; stream: import('../../../../../base/common/buffer.js').VSBufferReadableStream }): { stream: AsyncIterable<IChatResponsePart | IChatResponsePart[]>; completionPromise: Promise<void> } {
		const logService = this._logService;
		const parts: IChatResponsePart[] = [];
		let streamDone = false;
		let resolveDataAvailable: (() => void) | undefined;
		let resolveCompletion: () => void;
		let rejectCompletion: (err: unknown) => void;
		const completionPromise = new Promise<void>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});

		// Eagerly consume the VSBufferReadableStream and parse SSE
		const fullTextPromise = new Promise<string>((resolve, reject) => {
			const chunks: string[] = [];
			response.stream.on('data', (chunk) => {
				chunks.push(chunk.toString());
				if (resolveDataAvailable) {
					resolveDataAvailable();
					resolveDataAvailable = undefined;
				}
			});
			response.stream.on('end', () => {
				resolve(chunks.join(''));
			});
			response.stream.on('error', (err) => {
				reject(err);
			});
		});

		// Process the full response once complete
		fullTextPromise.then(fullText => {
			const lines = fullText.split('\n');
			for (const line of lines) {
				if (!line.startsWith('data: ')) {
					continue;
				}
				const data = line.slice(6).trim();
				if (data === '[DONE]') {
					break;
				}
				try {
					const parsed = JSON.parse(data);
					const delta = parsed.choices?.[0]?.delta;
					if (delta?.content) {
						parts.push({ type: 'text', value: delta.content });
					}
					if (delta?.reasoning_content) {
						parts.push({ type: 'thinking', value: delta.reasoning_content });
					}
				} catch {
					logService.trace('[K2] Skipped malformed SSE line:', line);
				}
			}
			streamDone = true;
			if (resolveDataAvailable) {
				resolveDataAvailable();
				resolveDataAvailable = undefined;
			}
			resolveCompletion!();
		}).catch((err) => {
			streamDone = true;
			if (resolveDataAvailable) {
				resolveDataAvailable();
				resolveDataAvailable = undefined;
			}
			rejectCompletion!(err);
		});

		const stream: AsyncIterable<IChatResponsePart | IChatResponsePart[]> = {
			[Symbol.asyncIterator](): AsyncIterator<IChatResponsePart | IChatResponsePart[]> {
				let index = 0;
				return {
					async next(): Promise<IteratorResult<IChatResponsePart | IChatResponsePart[]>> {
						while (index >= parts.length && !streamDone) {
							await new Promise<void>(r => { resolveDataAvailable = r; });
						}
						if (index < parts.length) {
							return { value: parts[index++], done: false };
						}
						return { value: undefined as unknown as IChatResponsePart, done: true };
					}
				};
			}
		};

		return { stream, completionPromise };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		if (typeof message === 'string') {
			return estimateTokenCount(message);
		}
		return estimateTokenCount(partsToText(message.content));
	}
}
