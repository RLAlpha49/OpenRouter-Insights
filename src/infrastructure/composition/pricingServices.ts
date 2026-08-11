/**
 * Pricing service composition — the pricing status bar, model picker, and the
 * two pricing workflows that publish through presenter ports.
 */

import type { IPricingCache } from "../../api/cache/pricingStore";
import { PricingFetcher } from "../../api/clients/pricingService";
import type { HttpClient } from "../../api/transport/httpClient";
import { StatusBarView } from "../../ui/status/statusBarView";
import { createStatusBarPresenter } from "../../ui/status/statusBarPresenter";
import { ModelPickerEnhancer } from "../../ui/model-browser/modelPickerEnhancer";
import { RefreshUseCase } from "../../use-cases/refreshUseCase";
import { StatusBarUpdateUseCase } from "../../use-cases/statusBarUpdateUseCase";
import type { PricingRefreshPresenter } from "../../use-cases/ports";
import type { ReadonlyConfig } from "../config";
import type { EventBus } from "../eventBus";
import { createPricingRefreshPresenter } from "../hostNotifications";
import { log } from "../logger";
import type { RuntimeDiagnostics } from "../runtimeDiagnostics";
import type { RuntimeDisposables } from "./runtimeDisposables";

export interface PricingServices {
	readonly statusBar: StatusBarView;
	readonly modelPicker: ModelPickerEnhancer;
	readonly refreshUseCase: RefreshUseCase;
	readonly statusBarUseCase: StatusBarUpdateUseCase;
}

export interface PricingServiceDependencies {
	readonly cache: IPricingCache;
	readonly config: ReadonlyConfig;
	readonly httpClient: HttpClient;
	readonly eventBus: EventBus;
	readonly diagnostics: RuntimeDiagnostics;
	readonly disposables: RuntimeDisposables;
	/** Host presenter for refresh outcomes; overridable in tests. */
	readonly refreshPresenter?: PricingRefreshPresenter;
}

/** Create the pricing views and workflows and register their disposal. */
export function createPricingServices(deps: PricingServiceDependencies): PricingServices {
	const statusBar = new StatusBarView();
	// Clear any loading indicator before the item itself is released.
	deps.disposables.addCallback(() => {
		statusBar.clearLoading();
		statusBar.dispose();
	});
	const modelPicker = deps.disposables.add(new ModelPickerEnhancer());

	const refreshUseCase = new RefreshUseCase(
		deps.cache,
		deps.config,
		new PricingFetcher(log, deps.diagnostics),
		deps.httpClient,
		deps.eventBus,
		deps.diagnostics,
		deps.refreshPresenter ?? createPricingRefreshPresenter(),
	);
	const statusBarUseCase = new StatusBarUpdateUseCase(
		deps.cache,
		createStatusBarPresenter(statusBar),
		modelPicker,
		deps.config,
		deps.eventBus,
	);

	return { statusBar, modelPicker, refreshUseCase, statusBarUseCase };
}
