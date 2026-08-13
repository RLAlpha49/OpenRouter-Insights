/**
 * FeatureRegistry — feature-flag architecture (implementing the
 * "group features with on/off switch" requirement).
 *
 * Each independently-toggleable feature has a namespace under
 * `openrouterInsights.features.<name>.enabled`. The registry
 * provides a single point of truth for feature gating:
 *   - Command registration (disabled features skip their commands)
 *   - UI activation (status bar, model picker, export)
 *   - File watcher (only needed when statusBar is enabled)
 *
 * Features:
 *   statusBar     — pricing in VS Code status bar
 *   modelBrowser  — QuickPick model browsers and switcher (includes model favorites/pinning)
 *   comparison    — webview side-by-side comparison
 *   export        — CSV/JSON export
 *
 * Settings live under:
 *   "openrouterInsights.features.statusBar.enabled": boolean (default true)
 *   "openrouterInsights.features.modelBrowser.enabled": boolean (default true)
 *   "openrouterInsights.features.comparison.enabled": boolean (default true)
 *   "openrouterInsights.features.export.enabled": boolean (default true)
 */

import * as vscode from "vscode";
import { ConfigService, FEATURE_IDS, type FeatureId } from "./config";

export { FEATURE_IDS } from "./config";
export type { FeatureId } from "./config";

/** CLI flags that are gated by features. */
const FEATURE_COMMAND_PREFIXES: Record<FeatureId, string[]> = {
	statusBar: ["openrouter-insights.toggleStatusBar"],
	modelBrowser: [
		"openrouter-insights.browseModels",
		"openrouter-insights.setModelOverride",
		"openrouter-insights.showFavorites",
		"openrouter-insights.addToFavorites",
		"openrouter-insights.removeFromFavorites",
	],
	comparison: ["openrouter-insights.compareModels"],
	export: ["openrouter-insights.exportCsv", "openrouter-insights.exportJson"],
	hoverProvider: [],
	usage: [
		"openrouter-insights.setApiKey",
		"openrouter-insights.removeApiKey",
		"openrouter-insights.refreshUsage",
		"openrouter-insights.loadUsageDetails",
		"openrouter-insights.openUsageDashboard",
		"openrouter-insights.openExpandedDashboard",
		"openrouter-insights.selectUsageKey",
		"openrouter-insights.createApiKey",
		"openrouter-insights.renameApiKey",
		"openrouter-insights.toggleApiKey",
		"openrouter-insights.setKeyLimit",
		"openrouter-insights.deleteApiKey",
	],
};

/** Commands that are always registered regardless of feature flags. */
const ALWAYS_ENABLED_COMMANDS = new Set([
	"openrouter-insights.refreshPricing",
	"openrouter-insights.showLogs",
	"openrouter-insights.showQuickActions",
	"openrouter-insights.copyModelId",
	"openrouter-insights.openOnOpenRouter",
	"openrouter-insights.viewModelDetail",
	"openrouter-insights.clearSelectedModel",
	"openrouter-insights.clearCache",
	"openrouter-insights.showCacheInfo",
]);

export class FeatureRegistry implements vscode.Disposable {
	private readonly _cache = new Map<FeatureId, boolean>();
	private readonly _disposables: vscode.Disposable[];

	constructor() {
		this._disposables = [
			ConfigService.instance.onFeatureChanged((feature) => {
				this._cache.delete(feature);
			}),
		];
	}

	/** Publish feature state for manifest `when` and `enablement` expressions. */
	syncContextKeys(showDashboard: boolean): void {
		for (const feature of FEATURE_IDS) {
			void vscode.commands.executeCommand(
				"setContext",
				`openrouter-insights:feature.${feature}.enabled`,
				this.isEnabled(feature),
			);
		}
		void vscode.commands.executeCommand(
			"setContext",
			"openrouter-insights:usageDashboardEnabled",
			showDashboard && this.isEnabled("usage"),
		);
	}

	dispose(): void {
		for (const disposable of this._disposables) disposable.dispose();
		this._disposables.length = 0;
		this._cache.clear();
	}

	/** Check if a feature is enabled (cached). */
	isEnabled(feature: FeatureId): boolean {
		if (this._cache.has(feature)) return this._cache.get(feature)!;
		const enabled = ConfigService.instance.isFeatureEnabled(feature);
		this._cache.set(feature, enabled);
		return enabled;
	}

	/** Returns a set of disabled command IDs based on current feature flags. */
	getDisabledCommandIds(): Set<string> {
		const disabled = new Set<string>();
		for (const feature of FEATURE_IDS) {
			if (!this.isEnabled(feature)) {
				for (const cmd of FEATURE_COMMAND_PREFIXES[feature]) {
					disabled.add(cmd);
				}
			}
		}
		return disabled;
	}

	/** Returns true if the given command should be registered. */
	shouldRegisterCommand(commandId: string): boolean {
		if (ALWAYS_ENABLED_COMMANDS.has(commandId)) return true;
		if (
			(commandId === "openrouter-insights.openUsageDashboard" ||
				commandId === "openrouter-insights.openExpandedDashboard") &&
			!ConfigService.instance.usageShowDashboard
		) {
			return false;
		}
		const disabled = this.getDisabledCommandIds();
		return !disabled.has(commandId);
	}
}
