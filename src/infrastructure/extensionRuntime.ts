/* eslint-disable @typescript-eslint/no-floating-promises */
import * as vscode from "vscode";
import { observeConfiguration } from "./configurationObserver";
import { ConfigService, type FeatureId } from "./config";
import { ModelPollingService } from "./modelPollingService";
import { RefreshScheduler } from "./refreshScheduler";
import { createStateDbWatcher } from "./stateDbWatcher";
import { UsagePollingService } from "./usagePollingService";
import { formatErrorBrief, log } from "./logger";
import { registerCommands } from "./commandRegistrar";
import { observeRefresh } from "./refreshObservation";
import { FeatureReconciler, ToggledResource, type FeatureLifecycle } from "./featureReconciler";
import type { CommandServices, RuntimeServices } from "./composition/contracts";
import { registerModelHoverProvider } from "../ui/webviews/modelHoverProvider";
import { computeBlendedRate } from "../api/clients/pricingService";
import { RuntimeDiagnostics } from "./runtimeDiagnostics";

/**
 * Owns every activation-scoped registration and converges feature state
 * through one reconciliation entry point.
 *
 * The runtime does not own the service graph: `ExtensionActivation` disposes
 * the container, the refresh coordinator, and configuration after the runtime
 * has released its own timers, watchers, and registrations.
 */
export class ExtensionRuntime implements vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _features: FeatureReconciler;
	private disposed = false;
	private readonly refreshScheduler: RefreshScheduler;
	private readonly modelPolling: ModelPollingService;
	private usagePolling: UsagePollingService | undefined;
	private usageDashboardRegistration: ToggledResource | undefined;
	readonly diagnostics: RuntimeDiagnostics;
	private readonly config: ConfigService;
	private started = false;

	private async runInBackground(label: string, work: () => Promise<unknown>): Promise<void> {
		await work().catch((error: unknown) => {
			if ((error as { cancelled?: boolean }).cancelled) return;
			this.diagnostics.recordFailure("background", error);
			log.errorFields(
				{ boundary: "background", operation: label },
				`Background ${label} failed:`,
				error,
			);
			this._services.eventBus.emit("refreshFailed", {
				label: label === "status bar" ? "statusBar" : undefined,
				error: formatErrorBrief(error).slice(0, 240),
			});
		});
	}

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _services: RuntimeServices & CommandServices,
	) {
		this.config = ConfigService.instance;
		this.diagnostics = _services.diagnostics ?? new RuntimeDiagnostics();
		this.refreshScheduler = new RefreshScheduler(
			() =>
				void observeRefresh({ label: "pricing", eventBus: this._services.eventBus }, () =>
					this._services.doRefresh(),
				),
			this.config,
		);
		this.modelPolling = new ModelPollingService(
			() =>
				void observeRefresh({ label: "statusBar", eventBus: this._services.eventBus }, () =>
					this.runInBackground("status bar", () => this._services.statusBarUseCase.execute()),
				),
			this.config,
			() =>
				this._services.eventBus.emit("refreshTerminal", {
					label: "statusBar",
					outcome: "skipped",
					reason: "window not focused",
				}),
		);
		this._features = new FeatureReconciler(this.createFeatureLifecycles(), (feature, error) => {
			this.diagnostics.recordFailure("config", error);
			log.errorFields(
				{ boundary: "configuration", feature },
				`Feature reconciliation failed for ${feature}:`,
				error,
			);
		});
		this._features.reconcileAll();
		this._services.modelPicker.warmConfiguredModelDiscovery();
		this._disposables.push(
			this._features,
			this.refreshScheduler,
			this.modelPolling,
			createStateDbWatcher(() => this.modelPolling.coalescedCheck()),
			observeConfiguration(
				{
					onRefreshIntervalChanged: () => this.refreshScheduler.schedule(),
					onDisplaySettingsChanged: () => {
						this._services.statusBarUseCase.invalidateCache();
						if (!this.disposed)
							this.runInBackground("status bar", () => this._services.statusBarUseCase.execute());
					},
					onPollIntervalChanged: () => this.modelPolling.schedule(),
					onUsageDataSettingsChanged: () => {
						if (!this.disposed && this.config.isFeatureEnabled("usage")) {
							this.runInBackground("usage settings refresh", async () => {
								await this._services.doUsageRefresh();
								await this._services.usageRefreshUseCase.loadDetails();
							});
						}
					},
					onBlendWeightsChanged: () => {
						const cached = this._services.cache.get();
						if (!cached) return;
						this.runInBackground("blend weights", async () => {
							const updated = {
								...cached,
								models: cached.models.map((model) => ({
									...model,
									blendedRate: computeBlendedRate(model.perMillion, this.config.blendWeights),
								})),
							};
							await this._services.cache.set(updated);
							this._services.modelPicker.invalidateSortCache();
							this._services.statusBarUseCase.invalidateCache();
							if (!this.disposed)
								this.runInBackground("status bar", () => this._services.statusBarUseCase.execute());
						});
					},
				},
				this._services.eventBus,
			),
			this.config.onFeatureChanged((feature: FeatureId) => this._features.reconcile(feature)),
			this.config.onAnyConfigChanged(() => this._features.reconcileAll()),
			registerCommands(this._context, this._services),
		);
		this.refreshScheduler.schedule();
	}

	async start(): Promise<void> {
		if (this.disposed || this.started) return;
		this.started = true;
		if (this._services.cache.isStale()) {
			log.info("Cache stale, triggering refresh");
			await this.runInBackground("pricing refresh", () => this._services.doRefresh());
		} else {
			log.info("Cache fresh, skipping initial fetch");
			await this.runInBackground("status bar", () => this._services.statusBarUseCase.execute());
		}
		if (
			this.config.isFeatureEnabled("usage") &&
			(this.config.usageStatusBarEnabled || this.config.usageShowDashboard)
		) {
			await this.runInBackground("usage refresh", () => this._services.doUsageRefresh());
		}
		if (this.config.isFeatureEnabled("usage")) {
			const hasKey = await this._services.secrets.hasKey();
			if (!this.disposed) {
				void vscode.commands.executeCommand("setContext", "openrouter-insights:hasApiKey", hasKey);
			}
		}
	}

	/**
	 * Declarative lifecycle table: enabled predicate, resource factory,
	 * configuration sync, and disable behavior for every runtime feature.
	 */
	private createFeatureLifecycles(): FeatureLifecycle[] {
		return [
			{
				id: "statusBar",
				isEnabled: () => this.config.isFeatureEnabled("statusBar"),
				sync: () => this._services.statusBar.setEnabled(this.config.showInStatusBar),
				deactivated: () => this._services.statusBar.setEnabled(false),
			},
			{
				id: "hoverProvider",
				isEnabled: () => this.config.isFeatureEnabled("hoverProvider"),
				activate: () => {
					const registration = registerModelHoverProvider(this._services.cache, () =>
						this._services.cache.age(),
					);
					log.info("Model hover provider registered");
					return registration;
				},
			},
			{
				id: "usage",
				isEnabled: () => this.config.isFeatureEnabled("usage"),
				activate: () => {
					this.usagePolling = new UsagePollingService(
						() =>
							void observeRefresh({ label: "usage", eventBus: this._services.eventBus }, () =>
								this.runInBackground("usage refresh", () =>
									this._services.doUsageRefresh("scheduled"),
								),
							),
					);
					this.usageDashboardRegistration = new ToggledResource(() =>
						vscode.window.registerWebviewViewProvider(
							"openrouter-insights.usageDashboard",
							this._services.usageDashboard,
						),
					);
					return vscode.Disposable.from(this.usagePolling, this.usageDashboardRegistration);
				},
				sync: () => {
					this.usageDashboardRegistration?.sync(this.config.usageShowDashboard);
					this.usagePolling?.schedule();
					this._services.usageStatusBar.setEnabled(this.config.usageStatusBarEnabled);
				},
				activated: () => {
					if (
						this.started &&
						(this.config.usageStatusBarEnabled || this.config.usageShowDashboard)
					) {
						this.runInBackground("usage refresh", () => this._services.doUsageRefresh());
					}
				},
				deactivated: () => {
					this.usagePolling = undefined;
					this.usageDashboardRegistration = undefined;
				},
			},
		];
	}

	/** Converge one feature against current configuration (test/diagnostics hook). */
	reconcileFeature(feature: FeatureId): void {
		this._features.reconcile(feature);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const disposable of [...this._disposables].reverse()) disposable.dispose();
		this._disposables.length = 0;
		this.usagePolling = undefined;
		this.usageDashboardRegistration = undefined;
	}
}
