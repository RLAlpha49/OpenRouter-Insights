/**
 * Shared test helpers for creating fake ReadonlyConfig instances.
 * Used by use-case and cache tests to inject configuration without
 * depending on vscode.workspace.getConfiguration.
 */

import type { ReadonlyConfig } from "../../infrastructure/config";

/**
 * Create a fully populated fake ReadonlyConfig with sensible defaults.
 * All values are identical to the extension's package.json defaults,
 * so tests stay in sync with production default behavior.
 */
export function createFakeReadonlyConfig(overrides?: Partial<ReadonlyConfig>): ReadonlyConfig {
	return {
		features: {
			statusBar: true,
			modelBrowser: true,
			comparison: true,
			export: true,
			hoverProvider: true,
			usage: true,
		},
		cacheTtlHours: 24,
		autoRefreshInterval: 3600,
		showInStatusBar: true,
		statusBarMaxWidth: 0,
		selectedModelId: "",
		providerFilter: "openrouterOnly",
		modelPollInterval: 30,
		statusBarClickAction: "browseModels",
		showFreeModelsOnly: false,

		modelBrowserSort: "blendedRate",
		logLevel: "info",
		favoriteModels: [],
		showDeprecatedModels: false,
		apiBaseUrl: "https://openrouter.ai/api/v1/models",
		apiOrigin: "https://openrouter.ai",
		statusBarTemplate: "${modelName} ${priceText}${deprecation}",
		currency: "USD",
		currencyRate: 1,
		usageAutoRefreshInterval: 300,
		usageBackgroundPollingEnabled: true,
		usageAnalyticsEnabled: true,
		usageAnalyticsLookbackDays: 30,
		usageLowBalanceThreshold: 5,
		usageStatusBarEnabled: true,
		usageShowDashboard: false,
		usageStatusBarClickAction: "fullDashboard",
		blendWeights: { cacheRead: 0.8, cacheWrite: 0.05, prompt: 0.1, completion: 0.05 },
		...overrides,
	};
}
