/**
 * Services / CompositionRoot — bundles all singletons created during
 * activation into a single object that can be passed to consumers.
 *
 * Implements vscode.Disposable with proper reverse-creation-order cleanup.
 * Wires: PricingCache, Logger, EventBus, FeatureRegistry, StatusBarView,
 * UsageStatusBarView, UsageDashboardProvider, ModelPickerEnhancer,
 * RefreshUseCase, StatusBarUpdateUseCase, UsageRefreshUseCase, and all
 * commands (via the command pattern — see commands.ts and usageCommands.ts).
 *
 * Adding a new component just means adding one field here — no closure sprawl.
 */

import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";
import { PricingCache } from "../api/cache/pricingCache";
import type { IPricingCache } from "../api/cache/pricingStore";
import { UsageCache } from "../api/cache/usageStore";
import { SecretStorageService } from "../api/secretStorageService";
import { StatusBarView } from "../ui/status/statusBarView";
import { UsageStatusBarView } from "../ui/status/usageStatusBarView";
import { UsageDashboardProvider } from "../ui/webviews/usageDashboard";
import { ModelPickerEnhancer } from "../ui/model-browser/modelPickerEnhancer";
import { RefreshUseCase } from "../use-cases/refreshUseCase";
import { StatusBarUpdateUseCase } from "../use-cases/statusBarUpdateUseCase";
import { UsageRefreshUseCase } from "../use-cases/usageRefreshUseCase";
import { log } from "./logger";
import { EventBus } from "./eventBus";
import { FeatureRegistry } from "./featureRegistry";
import type { ICommand } from "./commands";
import {
	RefreshPricingCommand,
	BrowseModelsCommand,
	CompareModelsCommand,
	SetModelOverrideCommand,
	ShowLogsCommand,
	ToggleStatusBarCommand,
	ExportCsvCommand,
	ExportJsonCommand,
	AddToFavoritesCommand,
	RemoveFromFavoritesCommand,
	CopyModelIdCommand,
	OpenOnOpenRouterCommand,
	ShowQuickActionsCommand,
	ClearCacheCommand,
	ShowCacheInfoCommand,
	ViewModelDetailCommand,
	ClearSelectedModelCommand,
	ShowRuntimeDiagnosticsCommand,
} from "./commands";
import {
	SetApiKeyCommand,
	RemoveApiKeyCommand,
	RefreshUsageCommand,
	LoadUsageDetailsCommand,
	OpenUsageDashboardCommand,
	OpenExpandedDashboardCommand,
	SelectUsageKeyCommand,
	CreateApiKeyCommand,
	RenameApiKeyCommand,
	ToggleApiKeyCommand,
	SetKeyLimitCommand,
	DeleteApiKeyCommand,
} from "./usageCommands";
import { ConfigService } from "./config";
import { RefreshCoordinator } from "./refreshCoordinator";
import type { RefreshReason } from "./refreshContext";
import { PricingFetcher } from "../api/clients/pricingService";
import { defaultHttpClient } from "../api/transport/httpClient";
import { HttpPipeline, withEndpointPolicy, withLogging } from "../api/transport/httpPipeline";
import { RuntimeDiagnostics } from "./runtimeDiagnostics";
import { configureStateDbDiagnostics } from "../models/stateDbReader";
import { setCredentialGeneration, clearAnalyticsCache } from "../api/clients/analyticsService";

export interface RuntimeServices {
	readonly cache: IPricingCache;
	readonly statusBar: StatusBarView;
	readonly usageStatusBar: UsageStatusBarView;
	readonly usageDashboard: UsageDashboardProvider;
	readonly secrets: SecretStorageService;
	readonly modelPicker: ModelPickerEnhancer;
	readonly statusBarUseCase: StatusBarUpdateUseCase;
	readonly usageRefreshUseCase: UsageRefreshUseCase;
	readonly eventBus: EventBus;
	readonly refreshCoordinator: RefreshCoordinator;
	readonly doRefresh: () => Promise<void>;
	readonly doUsageRefresh: (_reason?: RefreshReason) => Promise<void>;
	readonly diagnostics: RuntimeDiagnostics;
}

export interface CommandServices {
	readonly commands: ReadonlyMap<string, ICommand>;
	readonly features: FeatureRegistry;
	readonly diagnostics: RuntimeDiagnostics;
}

export interface ServiceContainer extends RuntimeServices, CommandServices, vscode.Disposable {
	cache: IPricingCache;
	statusBar: StatusBarView;
	usageStatusBar: UsageStatusBarView;
	usageDashboard: UsageDashboardProvider;
	secrets: SecretStorageService;
	modelPicker: ModelPickerEnhancer;
	refreshUseCase: RefreshUseCase;
	statusBarUseCase: StatusBarUpdateUseCase;
	usageRefreshUseCase: UsageRefreshUseCase;
	eventBus: EventBus;
	features: FeatureRegistry;
	commands: ReadonlyMap<string, ICommand>;
	/** Serializes outbound API refreshes across use cases. */
	refreshCoordinator: RefreshCoordinator;
	/** Trigger a full pricing refresh, then update the status bar. */
	doRefresh: () => Promise<void>;
	/** Trigger a usage refresh. */
	doUsageRefresh: (_reason?: RefreshReason) => Promise<void>;
	/** Show a loading indicator in the status bar (idempotent). */
	showLoading: () => void;
	/** Clear the loading indicator on the status bar. */
	clearLoading: () => void;
	diagnostics: RuntimeDiagnostics;
}

export function createServices(context: ExtensionContext): ServiceContainer {
	const diagnostics = new RuntimeDiagnostics();
	const cache = new PricingCache(context, ConfigService.instance, diagnostics);
	configureStateDbDiagnostics(diagnostics);
	const usageCache = new UsageCache();
	const secrets = new SecretStorageService(context);
	const authenticatedHttpPipeline = new HttpPipeline(
		defaultHttpClient,
		[
			withLogging(log),
			withEndpointPolicy({
				apiKeyProvider: () => secrets.get(),
				managementKeyProvider: () => secrets.get(),
			}),
		],
		diagnostics,
	);
	const statusBar = new StatusBarView();
	const usageStatusBar = new UsageStatusBarView();
	const modelPicker = new ModelPickerEnhancer();
	const eventBus = new EventBus();
	const refreshUseCase = new RefreshUseCase(
		cache,
		ConfigService.instance,
		new PricingFetcher(log, diagnostics),
		authenticatedHttpPipeline,
		eventBus,
		diagnostics,
	);
	const statusBarUseCase = new StatusBarUpdateUseCase(
		cache,
		statusBar,
		modelPicker,
		ConfigService.instance,
		eventBus,
	);
	const usageDashboard = new UsageDashboardProvider(cache);
	const usageRefreshUseCase = new UsageRefreshUseCase(
		usageCache,
		secrets,
		usageStatusBar,
		usageDashboard,
		ConfigService.instance,
		authenticatedHttpPipeline,
		eventBus,
		log,
		diagnostics,
	);
	const features = new FeatureRegistry();
	const refreshCoordinator = new RefreshCoordinator(diagnostics);

	const doRefresh = async () => {
		await refreshCoordinator.acquire("pricing", "user", async (ctx) => {
			statusBar.showLoading();
			eventBus.emit("refreshStarted", undefined);
			try {
				await refreshUseCase.execute(ctx);
				if (ctx.isCancelled()) return;
				const cachedData = cache.get();
				if (cachedData) {
					eventBus.emit("pricingRefreshed", cachedData);
				}
				await statusBarUseCase.execute();
			} finally {
				statusBar.clearLoading();
			}
		});
	};

	const doUsageRefresh = async (reason: RefreshReason = "user") => {
		await refreshCoordinator.acquire("usage", reason, (ctx) =>
			usageRefreshUseCase.execute(undefined, ctx),
		);
	};

	const showLoading = () => statusBar.showLoading();
	const clearLoading = () => statusBar.clearLoading();

	// Single credential-change invalidation boundary for authenticated derived
	// data. Rotation or removal advances SecretStorageService's generation and
	// clears the process-local analytics cache so results from a previous
	// credential are never served afterwards.
	const credentialChangeSubscription = secrets.onCredentialChange((event) => {
		setCredentialGeneration(event.generation);
		clearAnalyticsCache();
	});

	// ── Command instances ──────────────────────────────────
	const commandMap = new Map<string, ICommand>();

	const addCmd = (cmd: ICommand) => {
		commandMap.set(cmd.id, cmd);
	};

	addCmd(new RefreshPricingCommand(doRefresh));
	addCmd(new BrowseModelsCommand(cache, modelPicker));
	addCmd(new CompareModelsCommand(cache, modelPicker));
	addCmd(new SetModelOverrideCommand(cache, modelPicker));
	addCmd(new ShowLogsCommand());
	addCmd(new ToggleStatusBarCommand(statusBar));
	addCmd(new ExportCsvCommand(cache));
	addCmd(new ExportJsonCommand(cache));
	addCmd(new AddToFavoritesCommand());
	addCmd(new RemoveFromFavoritesCommand());
	addCmd(new CopyModelIdCommand(cache, modelPicker, eventBus));
	addCmd(new OpenOnOpenRouterCommand(cache, modelPicker));
	addCmd(
		new ShowQuickActionsCommand(commandMap, (commandId) =>
			features.shouldRegisterCommand(commandId),
		),
	);
	addCmd(new ClearCacheCommand(cache));
	addCmd(new ShowCacheInfoCommand(cache, diagnostics));
	addCmd(new ShowRuntimeDiagnosticsCommand(diagnostics));
	addCmd(new ViewModelDetailCommand(cache, modelPicker));
	addCmd(new ClearSelectedModelCommand());

	// Usage commands
	addCmd(new SetApiKeyCommand(secrets, doUsageRefresh));
	addCmd(new RemoveApiKeyCommand(secrets, () => usageRefreshUseCase.clear()));
	addCmd(new RefreshUsageCommand(usageRefreshUseCase));
	addCmd(new LoadUsageDetailsCommand(usageRefreshUseCase));
	addCmd(new OpenUsageDashboardCommand());
	addCmd(new OpenExpandedDashboardCommand(() => usageDashboard.openExpandedPanel()));
	addCmd(new SelectUsageKeyCommand((keyHash) => usageRefreshUseCase.executeWithKey(keyHash)));

	addCmd(new CreateApiKeyCommand(secrets, doUsageRefresh, authenticatedHttpPipeline));
	addCmd(new RenameApiKeyCommand(secrets, usageCache, doUsageRefresh, authenticatedHttpPipeline));
	addCmd(new ToggleApiKeyCommand(secrets, usageCache, doUsageRefresh, authenticatedHttpPipeline));
	addCmd(new SetKeyLimitCommand(secrets, usageCache, doUsageRefresh, authenticatedHttpPipeline));
	addCmd(new DeleteApiKeyCommand(secrets, usageCache, doUsageRefresh, authenticatedHttpPipeline));

	log.info("ServiceContainer: registered", commandMap.size, "commands");

	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		credentialChangeSubscription.dispose();
		// ExtensionRuntime owns the coordinator lifetime; the container owns
		// services created here and may be disposed independently in tests.
		features.dispose();
		eventBus.dispose();
		clearLoading();
		statusBar.dispose();
		usageStatusBar.dispose();
		modelPicker.dispose();
		secrets.dispose();
	};

	return {
		cache,
		statusBar,
		usageStatusBar,
		usageDashboard,
		secrets,
		modelPicker,
		refreshUseCase,
		statusBarUseCase,
		usageRefreshUseCase,
		eventBus,
		features,
		commands: commandMap,
		doRefresh,
		doUsageRefresh,
		showLoading,
		clearLoading,
		diagnostics,
		dispose,
		refreshCoordinator,
	};
}
