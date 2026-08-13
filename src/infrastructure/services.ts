/**
 * Composition root — assembles the activation-scoped service graph from four
 * focused factories and returns an immutable container.
 *
 * Responsibilities are split so no single function owns every dependency:
 *   `createApiServices`     — stores, secrets, credential boundary, transport
 *   `createPricingServices` — pricing views and pricing workflows
 *   `createUsageServices`   — usage views and the usage workflow
 *   `createCommandServices` — the command map registered with VS Code
 *
 * Ownership of disposal is explicit: every factory registers what it creates
 * with `RuntimeDisposables`, and `ServiceContainer.dispose` releases that
 * record once, in reverse creation order. Consumers depend on the narrow
 * contracts in `composition/contracts.ts` instead of this whole graph.
 */

import type * as vscode from "vscode";
import type { IPricingCache } from "../api/cache/pricingStore";
import type { SecretStorageService } from "../api/secretStorageService";
import type { StatusBarView } from "../ui/status/statusBarView";
import type { UsageStatusBarView } from "../ui/status/usageStatusBarView";
import type { UsageDashboardProvider } from "../ui/webviews/usageDashboard";
import type { ModelPickerEnhancer } from "../ui/model-browser/modelPickerEnhancer";
import type { RefreshUseCase } from "../use-cases/refreshUseCase";
import type { StatusBarUpdateUseCase } from "../use-cases/statusBarUpdateUseCase";
import type { UsageRefreshIntent, UsageRefreshUseCase } from "../use-cases/usageRefreshUseCase";
import { log } from "./logger";
import { EventBus } from "./eventBus";
import { FeatureRegistry } from "./featureRegistry";
import type { ICommand } from "./commands";
import { ConfigService } from "./config";
import { RefreshCoordinator } from "./refreshCoordinator";
import type { RefreshReason } from "./refreshContext";
import type { RuntimeDiagnostics } from "./runtimeDiagnostics";
import { RuntimeDisposables } from "./composition/runtimeDisposables";
import { createApiServices } from "./composition/apiServices";
import { createPricingServices } from "./composition/pricingServices";
import { createUsageServices } from "./composition/usageServices";
import { createCommandServices } from "./composition/commandServices";

export type {
	CommandGate,
	CommandServices,
	CredentialProbe,
	ModelDiscoveryCache,
	RuntimeServices,
	StatusBarRefresh,
	ToggleableView,
	UsageDetailRefresh,
} from "./composition/contracts";
export { RuntimeDisposables } from "./composition/runtimeDisposables";

/**
 * The complete activation graph. Every field is readonly: the container is a
 * composed result, not a mutable service bag that consumers can reassign.
 */
export interface ServiceContainer extends vscode.Disposable {
	readonly cache: IPricingCache;
	readonly statusBar: StatusBarView;
	readonly usageStatusBar: UsageStatusBarView;
	readonly usageDashboard: UsageDashboardProvider;
	readonly secrets: SecretStorageService;
	readonly modelPicker: ModelPickerEnhancer;
	readonly refreshUseCase: RefreshUseCase;
	readonly statusBarUseCase: StatusBarUpdateUseCase;
	readonly usageRefreshUseCase: UsageRefreshUseCase;
	readonly eventBus: EventBus;
	readonly features: FeatureRegistry;
	readonly commands: ReadonlyMap<string, ICommand>;
	/** Serializes outbound API refreshes across use cases. */
	readonly refreshCoordinator: RefreshCoordinator;
	/** Trigger a full pricing refresh, then update the status bar. */
	readonly doRefresh: () => Promise<void>;
	/** Trigger a usage refresh. */
	readonly doUsageRefresh: (_reason?: RefreshReason, _intent?: UsageRefreshIntent) => Promise<void>;
	/** Show a loading indicator in the status bar (idempotent). */
	readonly showLoading: () => void;
	/** Clear the loading indicator on the status bar. */
	readonly clearLoading: () => void;
	readonly diagnostics: RuntimeDiagnostics;
}

export function createServices(context: vscode.ExtensionContext): ServiceContainer {
	const disposables = new RuntimeDisposables();
	try {
		const config = ConfigService.instance;
		const eventBus = disposables.add(new EventBus());

		const api = createApiServices(context, disposables);
		const pricing = createPricingServices({
			cache: api.cache,
			config,
			httpClient: api.httpPipeline,
			eventBus,
			diagnostics: api.diagnostics,
			disposables,
		});
		const usage = createUsageServices({
			usageCache: api.usageCache,
			secrets: api.secrets,
			pricingIndex: api.cache,
			config,
			httpClient: api.httpPipeline,
			eventBus,
			logger: log,
			diagnostics: api.diagnostics,
			disposables,
		});

		const features = disposables.add(new FeatureRegistry());
		const refreshCoordinator = disposables.add(new RefreshCoordinator(api.diagnostics));

		const doRefresh = async () => {
			await refreshCoordinator.acquire("pricing", "user", async (ctx) => {
				pricing.statusBar.showLoading();
				eventBus.emit("refreshStarted", undefined);
				try {
					await pricing.refreshUseCase.execute(ctx);
					if (ctx.isCancelled()) return;
					const cachedData = api.cache.get();
					if (cachedData) {
						eventBus.emit("pricingRefreshed", cachedData);
					}
					await pricing.statusBarUseCase.execute();
				} finally {
					pricing.statusBar.clearLoading();
				}
			});
		};

		const doUsageRefresh = async (
			reason: RefreshReason = "user",
			intent: UsageRefreshIntent = "detailed",
		) => {
			await refreshCoordinator.acquire("usage", reason, (ctx) =>
				usage.usageRefreshUseCase.execute(undefined, ctx, intent),
			);
		};

		const commands = createCommandServices({
			cache: api.cache,
			usageCache: api.usageCache,
			secrets: api.secrets,
			statusBar: pricing.statusBar,
			modelPicker: pricing.modelPicker,
			usageRefreshUseCase: usage.usageRefreshUseCase,
			eventBus,
			diagnostics: api.diagnostics,
			httpClient: api.httpPipeline,
			features,
			doRefresh,
			doUsageRefresh: () => doUsageRefresh(),
			loadUsageDetails: () => doUsageRefresh("user", "detailed"),
			openExpandedDashboard: () => usage.usageDashboard.openExpandedPanel(),
		});

		log.info("ServiceContainer: registered", commands.size, "commands");

		return Object.freeze({
			cache: api.cache,
			statusBar: pricing.statusBar,
			usageStatusBar: usage.usageStatusBar,
			usageDashboard: usage.usageDashboard,
			secrets: api.secrets,
			modelPicker: pricing.modelPicker,
			refreshUseCase: pricing.refreshUseCase,
			statusBarUseCase: pricing.statusBarUseCase,
			usageRefreshUseCase: usage.usageRefreshUseCase,
			eventBus,
			features,
			commands,
			refreshCoordinator,
			doRefresh,
			doUsageRefresh,
			showLoading: () => pricing.statusBar.showLoading(),
			clearLoading: () => pricing.statusBar.clearLoading(),
			diagnostics: api.diagnostics,
			dispose: () => disposables.dispose(),
		});
	} catch (error) {
		disposables.dispose();
		throw error;
	}
}
