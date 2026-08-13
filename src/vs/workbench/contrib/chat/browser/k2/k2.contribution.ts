/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { IChatAgentService } from '../../common/participants/chatAgents.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatEntitlementContextKeys } from '../../../../services/chat/common/chatEntitlementService.js';
import { K2LanguageModelProvider, K2_VENDOR_ID } from './k2LanguageModelProvider.js';
import { buildKronosAgentData, K2ChatAgentImplementation } from './k2ChatAgent.js';
import './k2Configuration.js';

/**
 * Workbench contribution that registers the K2 language model provider and
 * the `@kronos` default chat agent at startup. This makes K2 models
 * (Highspeed, Code, K2.6, K2.5, Adaptive) available in the model picker, and
 * makes `@kronos` the default chat participant — all without requiring any
 * GitHub/Microsoft sign-in or extension installation.
 */
export class K2LanguageModelContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.k2LanguageModel';

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IChatAgentService private readonly _chatAgentService: IChatAgentService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
	) {
		super();
		this._bypassAuthForK2();
		this._registerK2Provider();
		this._registerKronosAgent();
	}

	/**
	 * Set context keys so the chat UI treats the user as fully entitled
	 * without requiring GitHub/Microsoft sign-in. This only affects the
	 * AI chat/completions path — other auth (Settings Sync, etc.) is untouched.
	 */
	private _bypassAuthForK2(): void {
		// Mark setup as completed and installed
		ChatEntitlementContextKeys.Setup.completed.bindTo(this._contextKeyService).set(true);
		ChatEntitlementContextKeys.Setup.installed.bindTo(this._contextKeyService).set(true);
		ChatEntitlementContextKeys.Setup.registered.bindTo(this._contextKeyService).set(true);
		// Hide GitHub Copilot's own setup/sign-in welcome UI entirely — Kronos
		// registers its own default agent below, so no Copilot setup flow is needed.
		ChatEntitlementContextKeys.Setup.hidden.bindTo(this._contextKeyService).set(true);
		ChatEntitlementContextKeys.Setup.disabled.bindTo(this._contextKeyService).set(false);
		ChatEntitlementContextKeys.Setup.untrusted.bindTo(this._contextKeyService).set(false);

		// Set entitlement to Pro level so quota checks pass
		ChatEntitlementContextKeys.Entitlement.planPro.bindTo(this._contextKeyService).set(true);
		ChatEntitlementContextKeys.Entitlement.signedOut.bindTo(this._contextKeyService).set(false);
		ChatEntitlementContextKeys.Entitlement.canSignUp.bindTo(this._contextKeyService).set(false);

		this._logService.info('[K2] Auth bypass: context keys set for zero-login AI access');
	}

	private _registerK2Provider(): void {
		try {
			// First, add the K2 vendor descriptor so the service accepts our provider
			this._languageModelsService.deltaLanguageModelChatProviderDescriptors(
				[{ vendor: K2_VENDOR_ID, displayName: 'Kronos K2', configuration: undefined, managementCommand: undefined, when: undefined }],
				[]
			);

			// Instantiate and register the K2 provider
			const provider = this._instantiationService.createInstance(K2LanguageModelProvider);
			const registration = this._languageModelsService.registerLanguageModelProvider(K2_VENDOR_ID, provider);
			this._register(registration);

			this._logService.info('[K2] Language model provider registered successfully');
		} catch (err) {
			this._logService.error('[K2] Failed to register language model provider:', err);
		}
	}

	private _registerKronosAgent(): void {
		try {
			const agentData = buildKronosAgentData();
			const agentImpl = this._instantiationService.createInstance(K2ChatAgentImplementation);
			this._register(this._chatAgentService.registerDynamicAgent(agentData, agentImpl));

			this._logService.info('[Kronos] @kronos default chat agent registered successfully');
		} catch (err) {
			this._logService.error('[Kronos] Failed to register @kronos chat agent:', err);
		}
	}
}
