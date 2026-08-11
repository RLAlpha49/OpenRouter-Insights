/**
 * Application output ports — the contracts application use cases publish
 * through instead of calling VS Code views or notifications directly.
 *
 * Use cases own orchestration and produce typed states; the host adapters in
 * `src/ui/` and `src/infrastructure/` translate those states into status-bar
 * items, webview renders, and `vscode.window.show*Message` calls. Keeping the
 * boundary here means a workflow can be exercised with in-memory presenters
 * and the VS Code presentation policy stays replaceable.
 */

import type { CachedPricingData, ModelPricingInfo } from "../types";
import type { UsageStats } from "../types-usage";

/** Host notification surface (information, warning, and error messages). */
export interface StatusNotifier {
	info(_message: string): void;
	warning(_message: string): void;
	error(_message: string): void;
}

/** Terminal outcomes of a pricing refresh, published for the host to present. */
export interface PricingRefreshPresenter {
	/** A refresh completed and replaced the cached catalog. */
	pricingUpdated(_modelCount: number): void;
	/** A refresh failed but usable cached pricing remains available. */
	pricingStale(_cacheAge: string, _error: string): void;
	/** A refresh failed and no usable pricing is available. */
	pricingUnavailable(_error: string): void;
}

/** Resolved pricing state for the model shown in the pricing status bar. */
export interface StatusBarPricingState {
	readonly displayName: string | undefined;
	readonly pricing: ModelPricingInfo | undefined;
	readonly data: CachedPricingData | undefined;
}

/** Pricing status-bar output port. */
export interface StatusBarPresenter {
	setEnabled(_enabled: boolean): void;
	setCommand(_command: string): void;
	showPricing(_state: StatusBarPricingState): void;
}

/** Narrow model-picker port: drop caches derived from the resolved model. */
export interface ModelSelectionCache {
	invalidateConfiguredIdsCache(): void;
}

/** Usage status-bar output port. */
export interface UsageStatusPresenter {
	setCommand(_command: string): void;
	showNoKey(): void;
	showLoading(): void;
	showUsage(_usage: UsageStats, _lowBalanceThreshold: number): void;
	showError(_message: string): void;
}

/** Usage dashboard output port. */
export interface UsageDashboardPresenter {
	renderNoKey(): void;
	renderLoading(): void;
	renderUsage(_usage: UsageStats): void;
	renderError(_message: string): void;
	sendLoadingProgress(_progressText: string): void;
}
