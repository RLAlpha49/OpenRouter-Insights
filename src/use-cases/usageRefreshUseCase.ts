/**
 * UsageRefreshUseCase — orchestrates the usage data refresh workflow.
 *
 * Flow:
 *   1. Check if API key exists
 *   2. Fetch usage from OpenRouter
 *   3. Persist to UsageCache
 *   4. Notify status bar + dashboard to re-render
 *
 * Guards against concurrent refresh calls.
 */

import type { IUsageStore } from "../api/cache/usageStore";
import type { SecretStorageService } from "../api/secretStorageService";
import type { UsageStatusBarView } from "../ui/status/usageStatusBarView";
import type { UsageDashboardProvider } from "../ui/webviews/usageDashboard";
import { fetchUsageDetails, fetchUsageStats } from "../api/clients/usageService";
import { log, formatError, formatErrorBrief } from "../infrastructure/logger";
import type { ReadonlyConfig } from "../infrastructure/config";
import type { RefreshContext } from "../infrastructure/refreshContext";
import type { HttpClient } from "../api/transport/httpClient";
import type { EventBus } from "../infrastructure/eventBus";
import type { ApiLogger } from "../api/logger";
import type { UsageStats } from "../types-usage";
import type { RuntimeDiagnostics } from "../infrastructure/runtimeDiagnostics";

export class UsageRefreshUseCase {
	private _pending: Promise<void> | undefined;
	private _pendingContext: RefreshContext | undefined;
	private _detailsPending: Promise<void> | undefined;
	private _selectedKeyHash: string | undefined;
	private _detailContext: RefreshContext | undefined;
	private _generation = 0;

	// eslint-disable-next-line max-params
	constructor(
		private readonly _cache: IUsageStore,
		private readonly _secrets: SecretStorageService,
		private readonly _statusBar: UsageStatusBarView,
		private readonly _dashboard: UsageDashboardProvider,
		private readonly _config: ReadonlyConfig,
		private readonly _client?: HttpClient,
		private readonly _eventBus?: EventBus,
		private readonly _logger?: ApiLogger,
		private readonly _diagnostics?: RuntimeDiagnostics,
	) {}

	private _sendProgress(text: string): void {
		this._dashboard.sendLoadingProgress(text);
	}

	get isInProgress(): boolean {
		return this._pending !== undefined;
	}

	/**
	 * Fetch latest usage from OpenRouter, persist, and update UI.
	 * Coalesces concurrent calls: if a refresh is already in progress,
	 * subsequent callers await the in-flight promise.
	 * If no API key is set, shows the "no key" state in the UI.
	 * @param keyHash  For management keys: the hash of the key to show usage for.
	 * @param ctx      Optional refresh context — cancellation suppresses publish.
	 */
	async execute(keyHash?: string, ctx?: RefreshContext): Promise<void> {
		if (keyHash !== undefined) {
			this._selectedKeyHash = keyHash;
		}
		const generation = ++this._generation;

		if (this._pending && !this._pendingContext?.isCancelled()) {
			log.info("UsageRefreshUseCase: coalescing into in-flight refresh cycle");
			return this._pending;
		}

		const operation = this._executeInternal(ctx, generation);
		this._pending = operation;
		this._pendingContext = ctx;
		try {
			await operation;
		} finally {
			// A cancelled operation may finish after its replacement. Do not
			// clear the replacement's pending state in that case.
			if (this._pending === operation) {
				this._pending = undefined;
				this._pendingContext = undefined;
			}
		}
	}

	private async _executeInternal(
		ctx?: RefreshContext,
		generation = this._generation,
	): Promise<void> {
		try {
			this._applyClickAction();
			ctx?.throwIfCancelled();

			const apiKey = await this._secrets.get();
			ctx?.throwIfCancelled();
			if (!apiKey) {
				log.info("UsageRefreshUseCase: no API key, showing no-key state");
				this._statusBar.showNoKey();
				this._dashboard.renderNoKey();
				return;
			}

			this._statusBar.showLoading();
			this._dashboard.renderLoading();
			this._sendProgress("Connecting to OpenRouter…");

			log.info("UsageRefreshUseCase: fetching usage from OpenRouter");
			this._sendProgress("Fetching API key info…");
			const usage = await fetchUsageStats(
				apiKey,
				this._selectedKeyHash,
				this._client,
				this._config.apiOrigin,
				ctx?.signal,
				(message) => this._sendProgress(message),
				...(this._logger ? [this._logger] : []),
			);
			if (ctx?.isCancelled()) {
				log.info("UsageRefreshUseCase: superseded before publish, discarding result");
				return;
			}
			const publishedUsage = mergeBaselineDetails(usage, this._cache.get());
			const loadingUsage =
				publishedUsage.mode === "management"
					? withDetailLoadingState(publishedUsage)
					: publishedUsage;
			this._cache.set(loadingUsage);
			if (loadingUsage.selectedKeyHash) {
				this._selectedKeyHash = loadingUsage.selectedKeyHash;
			}
			log.info(
				"UsageRefreshUseCase: fetched — total:",
				loadingUsage.totalUsed.toFixed(2),
				"| daily:",
				loadingUsage.dailyUsage.toFixed(4),
				"| limit:",
				loadingUsage.limit !== null ? loadingUsage.limit.toFixed(2) : "none",
				"| mode:",
				loadingUsage.mode,
			);

			this._statusBar.showUsage(loadingUsage, this._config.usageLowBalanceThreshold);
			this._dashboard.renderUsage(loadingUsage);
			if (loadingUsage.mode === "management") {
				// The baseline response does not contain activity or analytics. Load
				// those details after publishing the baseline so every refresh keeps
				// the dashboard's detailed sections populated.
				this._sendProgress("Loading detailed usage data…");
				await this.loadDetails(undefined, ctx, loadingUsage, generation);
			}

			const renderedUsage = this._cache.get() ?? publishedUsage;
			this._dashboard.renderUsage(renderedUsage);
		} catch (err) {
			if (ctx?.isCancelled() || (err as { cancelled?: boolean }).cancelled) {
				log.info("UsageRefreshUseCase: refresh cancelled");
				return;
			}
			log.error("UsageRefreshUseCase: fetch failed:", formatError(err));
			this._diagnostics?.recordFailure("background", err);
			ctx?.markFailed();
			this._eventBus?.emit("refreshFailed", {
				label: "usage",
				error: formatErrorBrief(err).slice(0, 240),
				refreshId: ctx?.refreshId,
			});
			this._statusBar.showError(formatErrorBrief(err));
			this._dashboard.renderError(formatErrorBrief(err));
		}
	}

	/**
	 * Apply the configured click action to the usage status bar item.
	 */
	private _applyClickAction(): void {
		const action = this._config.usageStatusBarClickAction;
		switch (action) {
			case "fullDashboard":
				this._statusBar.setCommand("openrouter-insights.openExpandedDashboard");
				break;
			case "sidebarDashboard":
				this._statusBar.setCommand("openrouter-insights.openUsageDashboard");
				break;
			case "quickActions":
				this._statusBar.setCommand("openrouter-insights.showQuickActions");
				break;
		}
	}

	/**
	 * Refresh with a specific key hash (for management key selection).
	 */
	async executeWithKey(keyHash: string): Promise<void> {
		await this.execute(keyHash);
	}

	/** Load history and optional analytics for the currently selected key. */
	async loadDetails(
		includeAnalytics = this._config.usageAnalyticsEnabled,
		ctx?: RefreshContext,
		baseline?: UsageStats,
		generation = this._generation,
	): Promise<void> {
		if (this._detailsPending) return this._detailsPending;

		this._detailContext?.abort();
		this._detailContext = ctx;
		const operation = this._loadDetailsInternal(includeAnalytics, ctx, baseline, generation);
		this._detailsPending = operation;
		try {
			await operation;
		} finally {
			if (this._detailsPending === operation) this._detailsPending = undefined;
			if (this._detailContext === ctx) this._detailContext = undefined;
		}
	}

	private async _loadDetailsInternal(
		includeAnalytics: boolean,
		ctx?: RefreshContext,
		baseline?: UsageStats,
		generation = this._generation,
	): Promise<void> {
		try {
			ctx?.throwIfCancelled();
			const apiKey = await this._secrets.get();
			if (!apiKey) return;
			ctx?.throwIfCancelled();

			this._sendProgress("Fetching usage activity…");
			const details = await fetchUsageDetails(
				apiKey,
				this._selectedKeyHash,
				{
					includeAnalytics,
					lookbackDays: this._config.usageAnalyticsLookbackDays,
					...(baseline ? { baseline } : {}),
				},
				this._client,
				this._config.apiOrigin,
				ctx?.signal,
				(message) => this._sendProgress(message),
				...(this._logger ? [this._logger] : []),
			);
			if (ctx?.isCancelled() || generation !== this._generation) return;
			if (!(await this._secrets.get())) return;
			const publishedDetails = mergeDetailSections(details, this._cache.get());
			this._cache.set(publishedDetails);
			this._dashboard.renderUsage(publishedDetails);
		} catch (err) {
			if (ctx?.isCancelled() || (err as { cancelled?: boolean }).cancelled) return;
			log.warn("UsageRefreshUseCase: optional detail load failed:", formatErrorBrief(err));
			this._diagnostics?.recordFailure("background", err);
			this._publishStaleDetails();
		}
	}

	private _publishStaleDetails(): void {
		const usage = this._cache.get();
		if (!usage) return;
		const hasPriorDetails = Boolean(
			usage.dailyUsageHistory || usage.perKeyActivityHistory || usage.analytics,
		);
		const stale = {
			...usage,
			detailState: {
				status: hasPriorDetails ? ("stale" as const) : ("unavailable" as const),
				lastAttemptAt: new Date().toISOString(),
				lastSuccessAt: usage.detailState?.lastSuccessAt,
				failedSections: ["activity", "per-key-activity", "analytics"],
			},
		};
		this._cache.set(stale);
		this._dashboard.renderUsage(stale);
	}

	/**
	 * Clear usage state (called when API key is removed).
	 */
	async clear(): Promise<void> {
		this._generation++;
		this._detailContext?.abort();
		this._detailContext = undefined;
		this._cache.clear();
		this._selectedKeyHash = undefined;
		this._statusBar.showNoKey();
		this._dashboard.renderNoKey();
	}
}

function withDetailLoadingState(usage: UsageStats): UsageStats {
	return {
		...usage,
		detailState: {
			status: "loading",
			lastAttemptAt: new Date().toISOString(),
			lastSuccessAt: usage.detailState?.lastSuccessAt,
		},
	};
}

function mergeBaselineDetails(usage: UsageStats, previous?: UsageStats): UsageStats {
	if (previous?.mode !== "management" || usage.mode !== "management") return usage;
	return {
		...usage,
		dailyUsageHistory: previous.dailyUsageHistory,
		perKeyActivityHistory: previous.perKeyActivityHistory,
		analytics: previous.analytics,
		analyticsUnavailableReason: previous.analyticsUnavailableReason,
		endpointDiagnostics: previous.endpointDiagnostics,
		detailState: previous.detailState,
	};
}

function mergeDetailSections(details: UsageStats, previous?: UsageStats): UsageStats {
	if (!previous || details.mode !== "management" || previous.mode !== "management") return details;
	const stale =
		details.detailState?.status === "stale" || details.detailState?.status === "unavailable";
	if (!stale) return details;
	return {
		...details,
		dailyUsageHistory: details.dailyUsageHistory ?? previous.dailyUsageHistory,
		perKeyActivityHistory: details.perKeyActivityHistory ?? previous.perKeyActivityHistory,
		analytics: details.analytics ?? previous.analytics,
	};
}
