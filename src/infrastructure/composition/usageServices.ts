/**
 * Usage service composition — the usage status bar, dashboard provider, and
 * the usage refresh workflow that publishes through presenter ports.
 */

import type { IPricingIndex } from "../../api/cache/pricingStore";
import type { IUsageStore } from "../../api/cache/usageStore";
import type { SecretStorageService } from "../../api/secretStorageService";
import type { HttpClient } from "../../api/transport/httpClient";
import type { ApiLogger } from "../../api/logger";
import { UsageStatusBarView } from "../../ui/status/usageStatusBarView";
import { UsageDashboardProvider } from "../../ui/webviews/usageDashboard";
import { UsageRefreshUseCase } from "../../use-cases/usageRefreshUseCase";
import type { ReadonlyConfig } from "../config";
import type { EventBus } from "../eventBus";
import type { RuntimeDiagnostics } from "../runtimeDiagnostics";
import type { RuntimeDisposables } from "./runtimeDisposables";

export interface UsageServices {
	readonly usageStatusBar: UsageStatusBarView;
	readonly usageDashboard: UsageDashboardProvider;
	readonly usageRefreshUseCase: UsageRefreshUseCase;
}

export interface UsageServiceDependencies {
	readonly usageCache: IUsageStore;
	readonly secrets: SecretStorageService;
	readonly pricingIndex: IPricingIndex;
	readonly config: ReadonlyConfig;
	readonly httpClient: HttpClient;
	readonly eventBus: EventBus;
	readonly logger: ApiLogger;
	readonly diagnostics: RuntimeDiagnostics;
	readonly disposables: RuntimeDisposables;
}

/** Create the usage views and workflow and register their disposal. */
export function createUsageServices(deps: UsageServiceDependencies): UsageServices {
	const usageStatusBar = deps.disposables.add(new UsageStatusBarView());
	const usageDashboard = new UsageDashboardProvider(deps.pricingIndex);
	const usageRefreshUseCase = new UsageRefreshUseCase(
		deps.usageCache,
		deps.secrets,
		usageStatusBar,
		usageDashboard,
		deps.config,
		deps.httpClient,
		deps.eventBus,
		deps.logger,
		deps.diagnostics,
	);

	return { usageStatusBar, usageDashboard, usageRefreshUseCase };
}
