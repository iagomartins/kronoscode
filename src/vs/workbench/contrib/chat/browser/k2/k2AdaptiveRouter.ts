/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { K2_MODEL_HIGHSPEED, K2_MODEL_CODE } from './k2LanguageModelProvider.js';

/**
 * Adaptive routing threshold in tokens.
 * Prompts below this size are routed to K2.7-Code-Highspeed (low latency, fast UX).
 * Prompts at or above this size are routed to K2.7-Code (heavier reasoning, larger context).
 */
const ADAPTIVE_TOKEN_THRESHOLD = 8000;

/**
 * Keywords in the prompt that imply a heavy, large-scale code generation task,
 * which should step up to K2.7-Code even if the token count is still small.
 */
const HEAVY_TASK_KEYWORDS = [
	'entire codebase',
	'whole codebase',
	'refactor the whole',
	'generate the full',
	'implement the full',
	'rewrite the whole',
];

/**
 * Given an estimated token count for the full prompt context (and optionally
 * the raw prompt text, to detect heavy-task keywords), returns the model id
 * to route to. Defaults to K2.7-Code-Highspeed for the vast majority of
 * standard chat queries and inline edits, and only steps up to K2.7-Code
 * when the context is large or the task implies massive code generation.
 */
export function k2AdaptiveRoute(estimatedTokens: number, promptText?: string): string {
	if (estimatedTokens >= ADAPTIVE_TOKEN_THRESHOLD) {
		return K2_MODEL_CODE;
	}
	if (promptText) {
		const lower = promptText.toLowerCase();
		if (HEAVY_TASK_KEYWORDS.some(keyword => lower.includes(keyword))) {
			return K2_MODEL_CODE;
		}
	}
	return K2_MODEL_HIGHSPEED;
}
