/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const PARTICIPANT_ID = 'kronos-ai';
const CONFIG_SECTION = 'kronos.moonshot';
const SET_API_KEY_COMMAND = 'kronos.moonshot.setApiKey';
const OPEN_SETTINGS_COMMAND = 'kronos.moonshot.openSettings';
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
			await vscode.workspace.getConfiguration(CONFIG_SECTION).update('apiKey', value, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage('Moonshot API key saved.');
		}
	});
	const openSettings = vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND, () =>
		vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION)
	);
	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, (request, chatContext, stream, token) =>
		handleRequest(request, chatContext, stream, token, log)
	);
	participant.iconPath = new vscode.ThemeIcon('sparkle');
	context.subscriptions.push(participant, log, setApiKey, openSettings);
}

async function handleRequest(
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	log: vscode.LogOutputChannel
): Promise<vscode.ChatResult> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const apiKey = config.get<string>('apiKey')?.trim();
	if (!apiKey) {
		const markdown = new vscode.MarkdownString(
			'**K2 Moonshot needs a Moonshot API key.**\n\nSet `kronos.moonshot.apiKey` to get started:\n\n- [Set API key](command:kronos.moonshot.setApiKey)\n- [Open settings](command:workbench.action.openSettings)\n\nYou can create a key at https://platform.moonshot.cn/console/api-keys.'
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
			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(reference.value));
			messages.push({ role: 'user', content: formatReference(reference.value, text) });
		} else if (reference.value instanceof vscode.Location) {
			const document = await vscode.workspace.openTextDocument(reference.value.uri);
			messages.push({ role: 'user', content: formatReference(reference.value.uri, document.getText(reference.value.range)) });
		}
	}
	messages.push({ role: 'user', content: request.prompt });

	const model = config.get<string>('defaultModel') || 'moonshot-v1-8k';
	const baseUrl = (config.get<string>('baseUrl') || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
	const controller = new AbortController();
	const cancellation = token.onCancellationRequested(() => controller.abort());
	log.info(`Starting request with model ${model} (${messages.length} messages)`);

	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages,
				stream: true,
				temperature: 0.3,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await response.text();
			const message = response.status === 401
				? 'The Moonshot API key is invalid. Please set a valid API key.'
				: response.status === 429
					? 'Moonshot API rate limit or quota exceeded.'
					: `Moonshot API error (${response.status}): ${getErrorMessage(body)}`;
			log.error(`Moonshot request failed with status ${response.status}: ${message}`);
			stream.markdown(message);
			if (response.status === 401) {
				stream.button({ command: SET_API_KEY_COMMAND, title: 'Set Moonshot API Key' });
			}
			return { errorDetails: { message } };
		}

		let truncated = false;
		if (!response.body) {
			const message = 'Moonshot API returned an empty response.';
			log.error(message);
			stream.markdown(message);
			return { errorDetails: { message } };
		}
		for await (const delta of readSseDeltas(response.body)) {
			if (token.isCancellationRequested) {
				return {};
			}
			if (delta.content) {
				stream.markdown(delta.content);
			}
			if (delta.finishReason === 'length') {
				truncated = true;
			}
		}
		if (truncated) {
			stream.markdown('\n\n_Response truncated: model output limit reached. Try a larger context model in `kronos.moonshot.defaultModel`._');
		}
		return { metadata: { model } };
	} catch (error) {
		if (token.isCancellationRequested || (error instanceof Error && error.name === 'AbortError')) {
			return {};
		}
		const message = error instanceof Error ? error.message : String(error);
		log.error(`Moonshot request failed: ${message}`);
		stream.markdown(`Unable to reach Moonshot API: ${message}`);
		return { errorDetails: { message } };
	} finally {
		cancellation.dispose();
	}
}

function formatReference(uri: vscode.Uri, text: string): string {
	return `Reference \`${uri.path}\`:\n\`\`\`\n${text.slice(0, 30_000)}\n\`\`\``;
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
