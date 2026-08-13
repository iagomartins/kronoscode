/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const KRONOS_K2_API_KEY_SETTING = 'kronosCode.k2ApiKey';
export const KRONOS_K2_MODEL_SETTING = 'kronosCode.k2Model';

export const KRONOS_K2_MODEL_ADAPTIVE = 'kronos-adaptive';
export const KRONOS_K2_MODEL_HIGHSPEED = 'kimi-k2.7-code-highspeed';
export const KRONOS_K2_MODEL_CODE = 'kimi-k2.7-code';
export const KRONOS_K2_MODEL_K26 = 'kimi-k2.6';
export const KRONOS_K2_MODEL_K25 = 'kimi-k2.5';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kronosCode',
	title: localize('kronosCodeConfigurationTitle', "Kronos Code"),
	type: 'object',
	properties: {
		[KRONOS_K2_API_KEY_SETTING]: {
			type: 'string',
			default: '',
			scope: 1 /* ConfigurationScope.APPLICATION */,
			markdownDescription: localize('kronosCode.k2ApiKey', "API key used by the Kronos `@kronos` chat agent and K2 language models to authenticate with the Moonshot K2 API (`https://api.moonshot.cn/v1/chat/completions`). If left empty, the `K2_API_KEY` environment variable is used as a fallback."),
		},
		[KRONOS_K2_MODEL_SETTING]: {
			type: 'string',
			enum: [
				KRONOS_K2_MODEL_ADAPTIVE,
				KRONOS_K2_MODEL_HIGHSPEED,
				KRONOS_K2_MODEL_CODE,
				KRONOS_K2_MODEL_K26,
				KRONOS_K2_MODEL_K25,
			],
			enumDescriptions: [
				localize('kronosCode.k2Model.adaptive', "Automatically routes between K2.7 Code (Highspeed) and K2.7 Code based on context size and task complexity."),
				localize('kronosCode.k2Model.highspeed', "K2.7 Code (Highspeed) \u2014 180~260 Tokens/s, ideal for standard coding tasks."),
				localize('kronosCode.k2Model.code', "K2.7 Code \u2014 for complex, heavy-reasoning tasks."),
				localize('kronosCode.k2Model.k26', "K2.6 \u2014 legacy/alternative option."),
				localize('kronosCode.k2Model.k25', "K2.5 \u2014 legacy/alternative option."),
			],
			default: KRONOS_K2_MODEL_ADAPTIVE,
			description: localize('kronosCode.k2Model', "The default K2 model used by the `@kronos` chat agent when no model is explicitly selected in the model picker."),
		},
	},
});
