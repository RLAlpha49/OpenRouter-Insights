import { describe, expect, it } from "vitest";
import {
	PALETTE,
	buildComparisonDocument,
	buildDashboardDocument,
	designSystemCss,
} from "../../ui/webviewAssets";
import { buildDashboardBody } from "../../ui/webviews/usageDashboard";
import type { UsageStats } from "../../types-usage";

function makeUsage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		mode: "management",
		isManagementKey: true,
		capabilities: {
			keys: "available",
			credits: "available",
			activity: "unavailable",
			perKeyActivity: "unavailable",
			analytics: "unavailable",
			keyManagement: "available",
		},
		totalUsed: 1,
		dailyUsage: 0.1,
		weeklyUsage: 0.5,
		monthlyUsage: 1,
		limit: null,
		limitRemaining: null,
		limitReset: null,
		isFreeTier: false,
		usagePercent: null,
		allKeys: [],
		selectedKeyHash: null,
		accountCredits: null,
		fetchedAt: new Date().toISOString(),
		dailyUsageHistory: null,
		perKeyActivityHistory: null,
		analytics: null,
		analyticsUnavailableReason: "disabled",
		...overrides,
	};
}

describe("webview theme", () => {
	it("defines the required palette entries", () => {
		expect(PALETTE.amber).toBeDefined();
		expect(PALETTE.teal).toBeDefined();
		expect(PALETTE.red).toBeDefined();
		expect(PALETTE.green).toBeDefined();
		expect(PALETTE.bg).toBeDefined();
		expect(PALETTE.surface).toBeDefined();
	});
	it("generates CSS with the design tokens", () => {
		const css = designSystemCss();
		expect(css.length).toBeGreaterThan(100);
		expect(css).toContain("<style>");
		expect(css).toContain("--or-bg:");
		expect(css).toContain("--or-surface:");
	});
});

describe("dashboard document security", () => {
	it("uses a unique nonce for each bridge script", () => {
		const first = buildDashboardDocument("<p>one</p>");
		const second = buildDashboardDocument("<p>two</p>");
		const firstNonce = first.match(/script-src 'nonce-([^']+)'/)?.[1];
		const secondNonce = second.match(/script-src 'nonce-([^']+)'/)?.[1];
		expect(firstNonce).toBeTruthy();
		expect(secondNonce).toBeTruthy();
		expect(firstNonce).not.toBe(secondNonce);
		expect(first).toContain(`nonce="${firstNonce}"`);
		expect(first).not.toContain("script-src 'unsafe-inline'");
	});

	it("preserves dashboard interaction state in the bridge", () => {
		const html = buildDashboardDocument("<p>one</p>");
		expect(html).toContain("handleUpdateHtml");
		expect(html).toContain("data-key-focus");
		expect(html).toContain("data-model-extra");
		expect(html).toContain("activeElement");
		expect(html).toContain("focus()");
	});

	it("keeps static command actions as keyboard-native links", () => {
		const html = buildComparisonDocument(
			'<a href="command:openrouter-insights.refreshPricing">Refresh</a>',
		);
		expect(html).not.toContain('role="button"');
		expect(html).not.toContain("script-src");
	});
});

describe("usage dashboard disabled states", () => {
	it("explains disabled analytics and activity in separate cards", () => {
		const html = buildDashboardBody(makeUsage(), false);
		expect(html).toContain("Spend by Model");
		expect(html).toContain("openrouterInsights.usage.analytics.enabled");
		expect(html).toContain("Usage Activity");
		expect(html).toContain("openrouterInsights.usage.backgroundPolling.enabled");
		expect(html).toContain("or-card");
	});
});
