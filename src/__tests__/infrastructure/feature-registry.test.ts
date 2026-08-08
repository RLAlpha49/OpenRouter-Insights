/**
 * Unit tests for FeatureRegistry — feature flag gating and command filtering.
 *
 * Covers: isEnabled, getDisabledCommandIds, shouldRegisterCommand,
 * feature caching, always-enabled commands, and disposal.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FeatureRegistry, FEATURE_IDS, type FeatureId } from "../../infrastructure/featureRegistry";
import { ConfigService } from "../../infrastructure/config";

// ── vscode mock utilities ────────────────────────────────────

// ConfigService reads the feature settings through the mocked VS Code
// configuration object, so tests can mutate the mock values directly.

import * as vscodeMock from "vscode";

/** Set up the vscode mock to return specific feature flag values. */
function setMockFeatures(enabled: Partial<Record<FeatureId, boolean>>): void {
	const configValues: Record<string, boolean> = {};
	for (const [feature, value] of Object.entries(enabled)) {
		if (value !== undefined) configValues[`features.${feature}.enabled`] = value;
	}
	(vscodeMock.workspace as any)._configValues = configValues;
}

describe("FeatureRegistry", () => {
	beforeEach(() => {
		ConfigService.instance.dispose();
		// Default: all features enabled
		setMockFeatures({});
	});

	it("reports all features as enabled by default", () => {
		const reg = new FeatureRegistry();
		for (const feature of FEATURE_IDS) {
			expect(reg.isEnabled(feature)).toBe(true);
		}
		reg.dispose();
	});

	it("reports a disabled feature correctly", () => {
		setMockFeatures({ statusBar: false });
		const reg = new FeatureRegistry();

		expect(reg.isEnabled("statusBar")).toBe(false);
		expect(reg.isEnabled("modelBrowser")).toBe(true);
		reg.dispose();
	});

	it("caches feature values after first read", () => {
		const reg = new FeatureRegistry();
		expect(reg.isEnabled("statusBar")).toBe(true);

		// Mutate the mock — but cached value should remain
		setMockFeatures({ statusBar: false });
		expect(reg.isEnabled("statusBar")).toBe(true); // cached
		reg.dispose();
	});

	it("refreshes cached feature values after a VS Code configuration change", () => {
		const reg = new FeatureRegistry();
		expect(reg.isEnabled("export")).toBe(true);

		setMockFeatures({ export: false });
		for (const listener of (vscodeMock.workspace as any)._createConfigListeners) {
			listener({
				affectsConfiguration: (key: string) =>
					key === "openrouterInsights" || key === "openrouterInsights.features.export.enabled",
			});
		}

		expect(reg.isEnabled("export")).toBe(false);
		reg.dispose();
	});

	it("getDisabledCommandIds returns nothing when all features enabled", () => {
		const reg = new FeatureRegistry();
		const disabled = reg.getDisabledCommandIds();
		expect(disabled.size).toBe(0);
		reg.dispose();
	});

	it("getDisabledCommandIds includes commands for disabled features", () => {
		setMockFeatures({ statusBar: false, modelBrowser: false });
		const reg = new FeatureRegistry();
		const disabled = reg.getDisabledCommandIds();

		// statusBar commands should be disabled
		expect(disabled.has("openrouter-insights.toggleStatusBar")).toBe(true);
		// modelBrowser commands should be disabled
		expect(disabled.has("openrouter-insights.browseModels")).toBe(true);
		expect(disabled.has("openrouter-insights.setModelOverride")).toBe(true);
		// export commands should still be enabled
		expect(disabled.has("openrouter-insights.exportCsv")).toBe(false);
		reg.dispose();
	});

	it("shouldRegisterCommand returns false for disabled feature commands", () => {
		setMockFeatures({ export: false });
		const reg = new FeatureRegistry();

		expect(reg.shouldRegisterCommand("openrouter-insights.exportCsv")).toBe(false);
		expect(reg.shouldRegisterCommand("openrouter-insights.exportJson")).toBe(false);
		reg.dispose();
	});

	it("shouldRegisterCommand returns true for always-enabled commands", () => {
		setMockFeatures({
			statusBar: false,
			modelBrowser: false,
			comparison: false,
			export: false,
			favorites: false,
		});
		const reg = new FeatureRegistry();

		// Even when all features are off, these commands are always registered
		expect(reg.shouldRegisterCommand("openrouter-insights.refreshPricing")).toBe(true);
		expect(reg.shouldRegisterCommand("openrouter-insights.showLogs")).toBe(true);
		expect(reg.shouldRegisterCommand("openrouter-insights.showQuickActions")).toBe(true);
		expect(reg.shouldRegisterCommand("openrouter-insights.copyModelId")).toBe(true);
		expect(reg.shouldRegisterCommand("openrouter-insights.openOnOpenRouter")).toBe(true);
		expect(reg.shouldRegisterCommand("openrouter-insights.clearCache")).toBe(true);
		expect(reg.shouldRegisterCommand("openrouter-insights.showCacheInfo")).toBe(true);
		reg.dispose();
	});

	it("handles all feature IDs", () => {
		const reg = new FeatureRegistry();
		for (const feature of FEATURE_IDS) {
			expect(typeof reg.isEnabled(feature)).toBe("boolean");
		}
		reg.dispose();
	});

	it("dispose cleans up configuration listener", () => {
		const reg = new FeatureRegistry();
		expect(() => reg.dispose()).not.toThrow();
		// Double-dispose should be safe
		expect(() => reg.dispose()).not.toThrow();
	});

	it("usage feature disables usage commands when off", () => {
		setMockFeatures({ usage: false });
		const reg = new FeatureRegistry();
		const disabled = reg.getDisabledCommandIds();

		expect(disabled.has("openrouter-insights.setApiKey")).toBe(true);
		expect(disabled.has("openrouter-insights.refreshUsage")).toBe(true);
		expect(disabled.has("openrouter-insights.openUsageDashboard")).toBe(true);
		expect(disabled.has("openrouter-insights.openExpandedDashboard")).toBe(true);
		reg.dispose();
	});

	it("hides dashboard commands when dashboard visibility is disabled", () => {
		(vscodeMock.workspace as any)._configValues = { "usage.showDashboard": false };
		const reg = new FeatureRegistry();

		expect(reg.shouldRegisterCommand("openrouter-insights.openUsageDashboard")).toBe(false);
		expect(reg.shouldRegisterCommand("openrouter-insights.openExpandedDashboard")).toBe(false);
		expect(reg.shouldRegisterCommand("openrouter-insights.refreshUsage")).toBe(true);
		reg.dispose();
	});
});
