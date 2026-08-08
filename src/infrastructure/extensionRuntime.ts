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
import type { RuntimeServices, ServiceContainer } from "./services";
import { registerModelHoverProvider } from "../ui/webviews/modelHoverProvider";
import { computeBlendedRate } from "../api/clients/pricingService";
import { RuntimeDiagnostics } from "./runtimeDiagnostics";

/** Owns every activation-scoped resource and converges feature state safely. */
export class ExtensionRuntime implements vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _featureResources = new Map<FeatureId, vscode.Disposable>();
	private disposed = false;
	private readonly refreshScheduler: RefreshScheduler;
	private readonly modelPolling: ModelPollingService;
	private usagePolling: UsagePollingService | undefined;
	private usageDashboardRegistration: vscode.Disposable | undefined;
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
		private readonly _services: RuntimeServices &
			Pick<ServiceContainer, "features" | "commands" | "dispose" | "showLoading" | "clearLoading">,
	) {
		this.config = ConfigService.instance;
		this.diagnostics = _services.diagnostics ?? new RuntimeDiagnostics();
		this.refreshScheduler = new RefreshScheduler(
			() => void this._services.doRefresh(),
			this.config,
		);
		this.modelPolling = new ModelPollingService(
			() => this.runInBackground("status bar", () => this._services.statusBarUseCase.execute()),
			this.config,
		);
		this.reconcileFeature("statusBar");
		this.reconcileFeature("hoverProvider");
		this.reconcileFeature("usage");
		this._services.modelPicker.warmConfiguredModelDiscovery();
		this._disposables.push(
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
						if (!this.disposed && ConfigService.instance.isFeatureEnabled("usage")) {
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
									blendedRate: computeBlendedRate(
										model.perMillion,
										ConfigService.instance.blendWeights,
									),
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
			this.config.onFeatureChanged((feature) => this.reconcileFeature(feature)),
			this.config.onAnyConfigChanged(() => this.reconcileUsage()),
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
			(ConfigService.instance.usageStatusBarEnabled || ConfigService.instance.usageShowDashboard)
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

	private reconcileFeature(feature: FeatureId): void {
		if (this.disposed) return;
		if (feature === "usage") {
			this.reconcileUsage();
			return;
		}
		if (feature !== "hoverProvider" && feature !== "statusBar") return;

		this._featureResources.get(feature)?.dispose();
		this._featureResources.delete(feature);
		if (feature === "statusBar") {
			this._services.statusBar.setEnabled(
				this.config.isFeatureEnabled("statusBar") && this.config.showInStatusBar,
			);
			return;
		}
		if (!this.config.isFeatureEnabled(feature)) return;

		try {
			if (feature === "hoverProvider") {
				this._featureResources.set(
					feature,
					registerModelHoverProvider(this._services.cache, () => this._services.cache.age()),
				);
				log.info("Model hover provider registered");
			}
		} catch (error) {
			this.diagnostics.recordFailure("config", error);
			log.errorFields(
				{ boundary: "configuration", feature },
				`Feature registration failed for ${feature}:`,
				error,
			);
		}
	}

	private reconcileUsage(): void {
		if (this.disposed || !this.config.isFeatureEnabled("usage")) {
			this.usageDashboardRegistration?.dispose();
			this.usageDashboardRegistration = undefined;
			this._featureResources.get("usage")?.dispose();
			this._featureResources.delete("usage");
			return;
		}
		if (this._featureResources.has("usage")) {
			this.reconcileUsageDashboard();
			return;
		}

		this.usagePolling = new UsagePollingService(() =>
			this.runInBackground("usage refresh", () => this._services.doUsageRefresh()),
		);
		const usageResource = vscode.Disposable.from(
			this.usagePolling,
			ConfigService.instance.onAnyConfigChanged(() => {
				if (!this.disposed && ConfigService.instance.isFeatureEnabled("usage")) {
					this.reconcileUsageDashboard();
					this.usagePolling?.schedule();
					this._services.usageStatusBar.setEnabled(ConfigService.instance.usageStatusBarEnabled);
				}
			}),
		);
		this._featureResources.set("usage", usageResource);
		this.reconcileUsageDashboard();
		this._services.usageStatusBar.setEnabled(ConfigService.instance.usageStatusBarEnabled);
		if (
			this.started &&
			(ConfigService.instance.usageStatusBarEnabled || ConfigService.instance.usageShowDashboard)
		)
			this.runInBackground("usage refresh", () => this._services.doUsageRefresh());
	}

	private reconcileUsageDashboard(): void {
		const shouldShow = this.config.usageShowDashboard;
		if (shouldShow && !this.usageDashboardRegistration) {
			this.usageDashboardRegistration = vscode.window.registerWebviewViewProvider(
				"openrouter-insights.usageDashboard",
				this._services.usageDashboard,
			);
			return;
		}
		if (!shouldShow && this.usageDashboardRegistration) {
			this.usageDashboardRegistration.dispose();
			this.usageDashboardRegistration = undefined;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const resource of [...this._featureResources.values()].reverse()) resource.dispose();
		this._featureResources.clear();
		for (const disposable of [...this._disposables].reverse()) disposable.dispose();
		this._disposables.length = 0;
		this.usageDashboardRegistration?.dispose();
		this.usageDashboardRegistration = undefined;
		this._services.refreshCoordinator.dispose();
		this._services.dispose();
		ConfigService.instance.dispose();
	}
}
