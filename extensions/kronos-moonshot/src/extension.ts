/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const PARTICIPANT_ID = 'kronos-ai';
const CONFIG_SECTION = 'kronos.moonshot';
const SET_API_KEY_COMMAND = 'kronos.moonshot.setApiKey';
const OPEN_SETTINGS_COMMAND = 'kronos.moonshot.openSettings';
const API_KEY_SECRET = 'kronos.moonshot.apiKey';
const DEFAULT_MODEL = 'moonshot-v1-8k';
const BASE_URL = 'https://api.moonshot.cn/v1';
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
const MAX_REFERENCE_CHARS = 30_000;
const SYSTEM_PROMPT = 'You are K2 Moonshot, the Kronos Code AI assistant. Answer concisely, use Markdown, and use fenced code blocks with a language tag for code.';

interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

interface SseDelta {
	content?: string;
	finishReason?: string;
}

interface SseChunk {
	choices?: ReadonlyArray<{
		delta?: {
			content?: unknown;
		};
		finish_reason?: unknown;
	}>;
}

interface StreamMoonshotCompletionOptions {
	apiKey: string;
	baseUrl: string;
	model: string;
	messages: ChatMessage[];
	token: vscode.CancellationToken;
	onDelta: (text: string) => void;
	log: vscode.LogOutputChannel;
}

class MoonshotApiError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'MoonshotApiError';
	}
}

class MoonshotLanguageModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly log: vscode.LogOutputChannel
	) { }

	provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
		const configuredModel = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('defaultModel');
		const defaultModel = configuredModel === 'moonshot-v1-32k' || configuredModel === 'moonshot-v1-128k' || configuredModel === DEFAULT_MODEL
			? configuredModel
			: DEFAULT_MODEL;
		return [
			this.createModel('moonshot-v1-8k', 'Moonshot v1 8K', 8192, defaultModel),
			this.createModel('moonshot-v1-32k', 'Moonshot v1 32K', 32768, defaultModel),
			this.createModel('moonshot-v1-128k', 'Moonshot v1 128K', 131072, defaultModel),
		];
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const apiKey = await getApiKey(this.secrets);
		if (!apiKey) {
			throw vscode.LanguageModelError.NoPermissions('Run "K2 Moonshot: Set Moonshot API Key" to use Moonshot models.');
		}

		const chatMessages: ChatMessage[] = [];
		for (const message of messages) {
			const content = message.content
				.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
				.map(part => part.value)
				.join('');
			if (!content) {
				continue;
			}
			if (message.role === vscode.LanguageModelChatMessageRole.User) {
				chatMessages.push({ role: 'user', content });
			}
			else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
				chatMessages.push({ role: 'assistant', content });
			}
		}

		await streamMoonshotCompletion({
			apiKey,
			baseUrl: (config.get<string>('baseUrl') || BASE_URL).replace(/\/+$/, ''),
			model: model.id,
			messages: chatMessages,
			token,
			onDelta: delta => progress.report(new vscode.LanguageModelTextPart(delta)),
			log: this.log,
		});
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const value = typeof text === 'string'
			? text
			: text.content
				.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
				.map(part => part.value)
				.join('');
		return Math.ceil(value.length / 4);
	}

	dispose(): void {
		this._onDidChangeLanguageModelChatInformation.dispose();
	}

	fireModelChange(): void {
		this._onDidChangeLanguageModelChatInformation.fire();
	}

	private createModel(id: string, name: string, maxInputTokens: number, defaultModel: string): vscode.LanguageModelChatInformation {
		return {
			id,
			name,
			family: 'moonshot',
			version: '1.0.0',
			maxInputTokens,
			maxOutputTokens: 4096,
			capabilities: {
				toolCalling: false,
				imageInput: false,
			},
			isDefault: id === defaultModel,
		};
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('K2 Moonshot', { log: true });
	const setApiKey = vscode.commands.registerCommand(SET_API_KEY_COMMAND, async () => {
		const value = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			password: true,
			placeHolder: 'sk-...',
			prompt: 'Enter your Moonshot API key',
		});
		if (value !== undefined) {
			await context.secrets.store(API_KEY_SECRET, value);
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			if (config.inspect<string>('apiKey')?.globalValue !== undefined) {
				await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
			}
			vscode.window.showInformationMessage('Moonshot API key saved.');
		}
	});
	const openSettings = vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND, () =>
		vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION)
	);
	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, (request, chatContext, stream, token) =>
		handleRequest(request, chatContext, stream, token, context.secrets, log)
	);
	participant.iconPath = new vscode.ThemeIcon('sparkle');
	const provider = new MoonshotLanguageModelProvider(context.secrets, log);
	const configurationChange = vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(`${CONFIG_SECTION}.defaultModel`)) {
			provider.fireModelChange();
		}
	});
	context.subscriptions.push(participant, provider, configurationChange, log, setApiKey, openSettings);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('moonshot', provider));
}

async function handleRequest(
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	secrets: vscode.SecretStorage,
	log: vscode.LogOutputChannel
): Promise<vscode.ChatResult> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const apiKey = await getApiKey(secrets);
	if (!apiKey) {
		const markdown = new vscode.MarkdownString(
			'**K2 Moonshot needs a Moonshot API key.**\n\nRun **K2 Moonshot: Set Moonshot API Key** to store your key securely (it is kept in the OS keychain via SecretStorage, never in settings.json):\n\n- [Set API key](command:kronos.moonshot.setApiKey)\n- [Open settings](command:kronos.moonshot.openSettings)\n\nYou can create a key at https://platform.moonshot.cn/console/api-keys.'
		);
		markdown.isTrusted = { enabledCommands: [SET_API_KEY_COMMAND, OPEN_SETTINGS_COMMAND] };
		stream.markdown(markdown);
		stream.button({ command: SET_API_KEY_COMMAND, title: 'Set Moonshot API Key' });
		return {};
	}

	const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
	for (const turn of chatContext.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			messages.push({ role: 'user', content: turn.prompt });
		} else if (turn instanceof vscode.ChatResponseTurn && turn.participant === PARTICIPANT_ID) {
			const content = turn.response
				.filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
				.map(part => part.value.value)
				.join('');
			if (content) {
				messages.push({ role: 'assistant', content });
			}
		}
	}

	for (const reference of request.references) {
		if (reference.value instanceof vscode.Uri) {
			try {
				const stat = await vscode.workspace.fs.stat(reference.value);
				if (stat.size > MAX_REFERENCE_BYTES) {
					messages.push({ role: 'user', content: `Reference \`${reference.value.path}\`: [File ignored: size exceeds 2MB limit]` });
					log.info(`Skipping reference ${reference.value.path} (${stat.size} bytes > 2MB)`);
					continue;
				}
				const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(reference.value));
				messages.push({ role: 'user', content: formatReference(reference.value, text) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`Could not read reference ${reference.value.path}: ${message}`);
				messages.push({ role: 'user', content: `Reference \`${reference.value.path}\`: [File could not be read]` });
			}
		} else if (reference.value instanceof vscode.Location) {
			try {
				const document = await vscode.workspace.openTextDocument(reference.value.uri);
				messages.push({ role: 'user', content: formatReference(reference.value.uri, document.getText(reference.value.range)) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`Could not read reference ${reference.value.uri.path}: ${message}`);
				messages.push({ role: 'user', content: `Reference \`${reference.value.uri.path}\`: [File could not be read]` });
			}
		}
	}
	messages.push({ role: 'user', content: request.prompt });

	const model = config.get<string>('defaultModel') || DEFAULT_MODEL;
	try {
		const result = await streamMoonshotCompletion({
			apiKey,
			baseUrl: (config.get<string>('baseUrl') || BASE_URL).replace(/\/+$/, ''),
			model,
			messages,
			token,
			onDelta: delta => stream.markdown(delta),
			log,
		});
		if (token.isCancellationRequested) {
			return {};
		}
		if (result.finishReason === 'length') {
			stream.markdown('\n\n_Response truncated: model output limit reached. Try a larger context model in `kronos.moonshot.defaultModel`._');
		}
		return { metadata: { model } };
	} catch (error) {
		if (token.isCancellationRequested || (error instanceof Error && error.name === 'AbortError')) {
			return {};
		}
		const message = error instanceof MoonshotApiError
			? error.status === 401
				? 'The Moonshot API key is invalid. Please set a valid API key.'
				: error.status === 429
					? 'Moonshot API rate limit or quota exceeded.'
					: `Moonshot API error (${error.status}): ${error.message}`
			: error instanceof Error ? error.message : String(error);
		log.error(error instanceof MoonshotApiError
			? `Moonshot request failed with status ${error.status}: ${message}`
			: `Moonshot request failed: ${message}`);
		stream.markdown(error instanceof MoonshotApiError ? message : `Unable to reach Moonshot API: ${message}`);
		if (error instanceof MoonshotApiError && error.status === 401) {
			stream.button({ command: SET_API_KEY_COMMAND, title: 'Set Moonshot API Key' });
		}
		return { errorDetails: { message } };
	}
}

async function streamMoonshotCompletion(options: StreamMoonshotCompletionOptions): Promise<{ finishReason?: string }> {
	const controller = new AbortController();
	const cancellation = options.token.onCancellationRequested(() => controller.abort());
	options.log.info(`Starting request with model ${options.model} (${options.messages.length} messages)`);

	try {
		if (options.token.isCancellationRequested) {
			return {};
		}
		const response = await fetch(`${options.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${options.apiKey}`,
			},
			body: JSON.stringify({
				model: options.model,
				messages: options.messages,
				stream: true,
				temperature: 0.3,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new MoonshotApiError(response.status, getErrorMessage(await response.text()));
		}
		if (!response.body) {
			throw new Error('Moonshot API returned an empty response.');
		}

		let finishReason: string | undefined;
		for await (const delta of readSseDeltas(response.body)) {
			if (options.token.isCancellationRequested) {
				return {};
			}
			if (delta.content) {
				options.onDelta(delta.content);
			}
			if (delta.finishReason) {
				finishReason = delta.finishReason;
			}
		}
		return { finishReason };
	} finally {
		cancellation.dispose();
	}
}

function formatReference(uri: vscode.Uri, text: string): string {
	const truncated = text.length > MAX_REFERENCE_CHARS;
	return `Reference \`${uri.path}\`:\n\`\`\`\n${text.slice(0, MAX_REFERENCE_CHARS)}${truncated ? '\n[truncated to 30,000 characters]' : ''}\n\`\`\``;
}

async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
	const stored = (await secrets.get(API_KEY_SECRET))?.trim();
	if (stored) {
		return stored;
	}

	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.inspect<string>('apiKey')?.globalValue?.trim();
	if (value) {
		await secrets.store(API_KEY_SECRET, value);
		await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
		return value;
	}
	return undefined;
}

function getErrorMessage(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === 'object' && parsed !== null) {
			const error = (parsed as { error?: unknown }).error;
			if (typeof error === 'object' && error !== null) {
				const message = (error as { message?: unknown }).message;
				if (typeof message === 'string') {
					return message.slice(0, 500);
				}
			}
		}
	} catch {
		// Fall through to the response text.
	}
	return body.slice(0, 500) || 'Unknown error';
}

async function* readSseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<SseDelta> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const delta = parseSseLine(line);
				if (delta === 'done') {
					return;
				}
				if (delta) {
					yield delta;
				}
			}
		}
		buffer += decoder.decode();
		const delta = parseSseLine(buffer);
		if (delta && delta !== 'done') {
			yield delta;
		}
	} finally {
		reader.releaseLock();
	}
}

function parseSseLine(line: string): SseDelta | 'done' | undefined {
	const trimmed = line.trim().replace(/\r$/, '');
	if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
		return undefined;
	}
	const payload = trimmed.slice(5).trim();
	if (payload === '[DONE]') {
		return 'done';
	}
	try {
		const chunk = JSON.parse(payload) as SseChunk;
		const choice = chunk.choices?.[0];
		const content = typeof choice?.delta?.content === 'string' ? choice.delta.content : undefined;
		const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
		return content || finishReason ? { content, finishReason } : undefined;
	} catch {
		return undefined;
	}
}
