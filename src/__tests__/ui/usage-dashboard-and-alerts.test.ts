import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConfiguredModelDiscovery } from "../../ui/model-browser/configuredModelDiscovery";
import { buildDashboardBody } from "../../ui/webviews/usageDashboard";
import { ANALYTICS_ROW_BUDGET } from "../../api/clients/analyticsService";
import { getAvailableCredits } from "../../ui/status/usageStatusBarView";
import { ConfigService } from "../../infrastructure/config";
import type { UsageStats } from "../../types-usage";
import type { ModelPricingInfo } from "../../types";

function makeModel(overrides: Partial<ModelPricingInfo> = {}): ModelPricingInfo {
	return {
		id: "openai/gpt-4o",
		name: "GPT-4o",
		blendedRate: 5,
		contextLength: 128000,
		contextLengthFormatted: "128K",
		maxOutputLength: 4096,
		isDeprecated: false,
		deprecationDate: "",
		isFree: false,
		discountToUser: 0,
		quantization: "",
		modality: "text->text",
		inputModalities: ["text"],
		outputModalities: ["text"],
		perMillion: {
			prompt: 2,
			completion: 8,
			image: 0,
			request: 0,
			inputCacheRead: 1,
			inputCacheWrite: 2,
			webSearch: 0,
			internalReasoning: 0,
		},
		topProviderContextLength: 0,
		topProviderMaxCompletionTokens: 0,
		topProviderIsModerated: false,
		topProviderId: "",
		topProviderName: "",
		supportedParameters: [],
		supportedFeatures: [],
		created: 0,
		detailsLink: "",
		description: "",
		...overrides,
	};
}

function makeUsage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		mode: "management",
		isManagementKey: true,
		capabilities: {
			keys: "available",
			credits: "available",
			activity: "available",
			perKeyActivity: "available",
			analytics: "available",
			keyManagement: "available",
		},
		totalUsed: 2,
		dailyUsage: 0.5,
		weeklyUsage: 1,
		monthlyUsage: 2,
		limit: 10,
		limitRemaining: 8,
		limitReset: "2026-08-10",
		isFreeTier: false,
		usagePercent: 20,
		allKeys: [
			{
				hash: "hash-1",
				name: "Production",
				label: "prod",
				disabled: false,
				totalUsed: 2,
				dailyUsage: 0.5,
				weeklyUsage: 1,
				monthlyUsage: 2,
				limit: 10,
				limitRemaining: 8,
				limitReset: "2026-08-10",
				usagePercent: 20,
			},
		],
		selectedKeyHash: "hash-1",
		accountCredits: { totalCredits: 20, totalUsage: 2, remaining: 18, usagePercent: 10 },
		fetchedAt: new Date().toISOString(),
		dailyUsageHistory: [{ date: "2026-08-01", usage: 1, requests: 2 }],
		perKeyActivityHistory: { "hash-1": [{ date: "2026-08-01", usage: 1, requests: 1 }] },
		analytics: {
			modelBreakdown: [
				{
					modelId: "openai/gpt-4o",
					totalUsage: 2,
					percentage: 100,
					requestCount: 2,
					tokensTotal: 1000,
					promptTokens: 500,
					completionTokens: 400,
					cacheHitRate: 0,
				},
			],
			totalRequests: 2,
			totalSpend: 2,
			overallCacheHitRate: 5,
		},
		...overrides,
	};
}

describe("ConfiguredModelDiscovery", () => {
	beforeEach(() => {
		(vscode as any).lm = {
			selectChatModels: vi.fn(async () => [{ id: "openai/gpt-4o" }, { id: "anthropic/claude" }]),
		};
	});

	it("discovers and maps configured model IDs, then caches the result", async () => {
		const discovery = new ConfiguredModelDiscovery();
		const lookup = new Map([["openai/gpt-4o:free", makeModel({ id: "openai/gpt-4o:free" })]]);

		expect(await discovery.discoverModelIds(lookup)).toEqual(
			new Set(["openai/gpt-4o:free", "anthropic/claude"]),
		);
		expect(await discovery.discoverModelIds(lookup)).toEqual(
			new Set(["openai/gpt-4o:free", "anthropic/claude"]),
		);
		expect((vscode as any).lm.selectChatModels).toHaveBeenCalledTimes(1);
	});

	it("returns an empty set when the LM API fails and can invalidate its cache", async () => {
		(vscode as any).lm.selectChatModels = vi.fn(async () => {
			throw new Error("unavailable");
		});
		const discovery = new ConfiguredModelDiscovery();
		expect(await discovery.discoverModelIds()).toEqual(new Set());
		discovery.invalidateCache();
		discovery.warm();
	});

	it("retries after a transient LM API failure instead of caching an empty result", async () => {
		const selectChatModels = vi
			.fn()
			.mockRejectedValueOnce(new Error("temporarily unavailable"))
			.mockResolvedValueOnce([{ id: "openai/gpt-4o" }]);
		(vscode as any).lm.selectChatModels = selectChatModels;
		const discovery = new ConfiguredModelDiscovery();

		expect(await discovery.discoverModelIds()).toEqual(new Set());
		expect(await discovery.discoverModelIds()).toEqual(new Set(["openai/gpt-4o"]));
		expect(selectChatModels).toHaveBeenCalledTimes(2);
	});
});

describe("usage dashboard and status bar", () => {
	it("renders management dashboard sections and model IDs", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			...(original ?? {}),
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();
		const html = buildDashboardBody(makeUsage(), false, {
			getLookup: () => new Map([["openai/gpt-4o", makeModel()]]),
			getValues: () => [makeModel()],
			getLowercasedIndex: () => new Map([["openai/gpt-4o", "openai/gpt-4o"]]),
		} as any);
		expect(html).toContain("Account Credits");
		expect(html).toContain("Spend by Model");
		expect(html).toContain("Production");
		expect(html).toContain("openai/gpt-4o");
		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("preserves analytics IDs instead of fuzzy-matching similar or dated models", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			...(original ?? {}),
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();
		const breakdown = [
			{
				modelId: "openai/gpt-5-nano-2025-08-07",
				totalUsage: 2,
				percentage: 40,
				requestCount: 2,
				tokensTotal: 1000,
				promptTokens: 500,
				completionTokens: 400,
				cacheHitRate: 0,
			},
			{
				modelId: "deepseek/deepseek-v4-pro-20260423",
				totalUsage: 1,
				percentage: 20,
				requestCount: 1,
				tokensTotal: 500,
				promptTokens: 250,
				completionTokens: 200,
				cacheHitRate: 0,
			},
			{
				modelId: "deepseek/deepseek-v4-flash-20260731",
				totalUsage: 1,
				percentage: 20,
				requestCount: 1,
				tokensTotal: 500,
				promptTokens: 250,
				completionTokens: 200,
				cacheHitRate: 0,
			},
			{
				modelId: "deepseek/deepseek-v4-flash-20260423",
				totalUsage: 1,
				percentage: 20,
				requestCount: 1,
				tokensTotal: 500,
				promptTokens: 250,
				completionTokens: 200,
				cacheHitRate: 0,
			},
		];
		const pricingModels = [
			makeModel({ id: "openai/gpt-5", name: "GPT-5" }),
			makeModel({ id: "openai/gpt-5-nano", name: "GPT-5 Nano" }),
			makeModel({
				id: "deepseek/deepseek-v4-pro",
				name: "DeepSeek: DeepSeek V4 Pro",
			}),
			makeModel({
				id: "deepseek/deepseek-v4-flash-0731",
				name: "DeepSeek: DeepSeek V4 Flash 0731",
			}),
			makeModel({
				id: "deepseek/deepseek-v4-flash-0423",
				name: "DeepSeek: DeepSeek V4 Flash 0423",
			}),
		];
		const html = buildDashboardBody(
			makeUsage({
				analytics: {
					modelBreakdown: breakdown,
					totalRequests: 4,
					totalSpend: 4,
					overallCacheHitRate: 0,
				},
			}),
			false,
			{
				getLookup: () => new Map(pricingModels.map((model) => [model.id, model])),
				getValues: () => pricingModels,
				getLowercasedIndex: () =>
					new Map(pricingModels.map((model) => [model.id.toLowerCase(), model])),
			} as any,
		);

		expect(html).toContain('data-model-id="openai/gpt-5-nano-2025-08-07"');
		expect(html).toContain('href="https://openrouter.ai/models/openai/gpt-5-nano-2025-08-07"');
		expect(html).toContain("GPT-5 Nano");
		expect(html).toContain('<span class="or-model-id">openai/gpt-5-nano</span>');
		expect(html).not.toContain('data-model-id="openai/gpt-5"');
		expect(html).toContain('data-model-id="deepseek/deepseek-v4-pro-20260423"');
		expect(html).toContain('data-model-id="deepseek/deepseek-v4-flash-20260731"');
		expect(html).toContain("DeepSeek: DeepSeek V4 Pro");
		expect(html).toContain("DeepSeek: DeepSeek V4 Flash 0423");
		expect(html).toContain("DeepSeek: DeepSeek V4 Flash 0731");
		expect(html).toContain('<span class="or-model-id">deepseek/deepseek-v4-pro</span>');
		expect(html).toContain('<span class="or-model-id">deepseek/deepseek-v4-flash-0731</span>');
		expect(html).toContain(
			'href="https://openrouter.ai/models/deepseek/deepseek-v4-flash-20260731"',
		);

		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("shows a free badge for used removed free models but not unused rows", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			...(original ?? {}),
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();
		const html = buildDashboardBody(
			makeUsage({
				analytics: {
					modelBreakdown: [
						{
							modelId: "old-provider/old-model",
							totalUsage: 0,
							percentage: 100,
							requestCount: 1,
							tokensTotal: 100,
							promptTokens: 50,
							completionTokens: 40,
							cacheHitRate: 0,
						},
						{
							modelId: "unused-provider/unused-model",
							totalUsage: 0,
							percentage: 0,
							requestCount: 0,
							tokensTotal: 0,
							promptTokens: 0,
							completionTokens: 0,
							cacheHitRate: 0,
						},
					],
					totalRequests: 1,
					totalSpend: 0,
					overallCacheHitRate: 0,
				},
			}),
			false,
			{
				getLookup: () => new Map(),
				getValues: () => [],
				getLowercasedIndex: () => new Map(),
			} as any,
		);

		expect(html).toContain('data-model-id="old-provider/old-model"');
		expect(html).toContain(">Old Model<");
		expect(html).toContain('<span class="or-model-id">old-provider/old-model</span>');
		expect(html).toContain(">FREE<");
		expect(html).toContain('data-model-id="unused-provider/unused-model"');
		expect(html).not.toContain(
			'data-model-id="unused-provider/unused-model"><span class="or-model-free">FREE</span>',
		);

		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("does not render the detail notice on the dashboard", () => {
		const html = buildDashboardBody(makeUsage({ detailState: { status: "stale" } }), false);

		expect(html).not.toContain("Usage details are stale.");
	});

	it("shows section loading indicators while detail data is pending", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			...(original ?? {}),
			"usage.backgroundPolling.enabled": true,
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();

		const html = buildDashboardBody(
			makeUsage({
				dailyUsageHistory: null,
				perKeyActivityHistory: null,
				analytics: null,
				detailState: { status: "loading" },
			}),
			false,
		);

		expect(html).toContain('aria-live="polite"');
		expect(html).toContain("Loading usage activity");
		expect(html).toContain("Loading spend by model");
		expect(html.match(/class="or-spinner"/g)).toHaveLength(2);

		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("renders the account key switcher with keyboard semantics", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			...(original ?? {}),
			"usage.analytics.enabled": false,
		};
		ConfigService.instance.dispose();
		const html = buildDashboardBody(
			makeUsage({
				allKeys: [
					makeUsage().allKeys![0],
					{
						hash: "hash-2",
						name: "Backup",
						label: "backup",
						disabled: false,
						totalUsed: 0,
						dailyUsage: 0,
						weeklyUsage: 0,
						monthlyUsage: 0,
						limit: null,
						limitRemaining: null,
						limitReset: null,
						usagePercent: null,
					},
				],
			}),
			false,
		);
		expect(html).toContain('role="group"');
		expect(html).toContain('data-key-focus="hash-1"');
		expect(html).toContain('data-key-focus="hash-2"');
		expect(html).toContain('aria-pressed="true"');
		expect(html).toContain('tabindex="0"');
		expect(html).toContain('tabindex="-1"');
		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("renders the first model-spend rows before bridge initialization", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			...(original ?? {}),
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();
		const breakdown = ["one", "two", "three"].map((name, index) => ({
			modelId: `openai/${name}`,
			totalUsage: index + 1,
			percentage: 33.3,
			requestCount: index + 1,
			tokensTotal: 100,
			promptTokens: 50,
			completionTokens: 40,
			cacheHitRate: 0,
		}));
		const html = buildDashboardBody(
			makeUsage({
				analytics: {
					modelBreakdown: breakdown,
					totalRequests: 6,
					totalSpend: 6,
					overallCacheHitRate: 0,
				},
			}),
			false,
		);
		expect(html).toContain('data-model-index="0"');
		expect(html).not.toContain('data-model-index="0" style="display:none"');
		expect(html).toContain(
			'data-model-index="2" data-model-id="openai/three" style="display:none"',
		);
		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("renders the selected key as an overview with masked identity and usage metrics", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			...(original ?? {}),
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();

		const html = buildDashboardBody(makeUsage(), true);

		expect(html).toContain('class="or-key-detail-identity"');
		expect(html).not.toContain("or-key-detail-status");
		expect(html).toContain('class="or-key-detail-limit"');
		expect(html).toContain('class="or-key-detail-metrics"');
		expect(html).toContain('data-key-hash="hash-1"');
		expect(html).toContain("<code>hash-1…</code>");
		expect(html).toContain("20.0% used");
		expect(html).toContain("Reset 2026-08-10");

		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("renders disabled activity and analytics explanations", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			"usage.backgroundPolling.enabled": false,
			"usage.analytics.enabled": false,
		};
		ConfigService.instance.dispose();
		const usage = makeUsage({
			dailyUsageHistory: null,
			analytics: null,
			analyticsUnavailableReason: "disabled",
		});
		const html = buildDashboardBody(usage, true);
		expect(html).toContain("background polling is disabled");
		expect(html).toContain("Per-model spend is turned off");
		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("warns when the analytics result is truncated by the row budget", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			...(original ?? {}),
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();
		const usage = makeUsage({
			analytics: {
				modelBreakdown: [
					{
						modelId: "openai/gpt-4o",
						totalUsage: 2,
						percentage: 100,
						requestCount: 2,
						tokensTotal: 1000,
						promptTokens: 500,
						completionTokens: 400,
						cacheHitRate: 0,
					},
				],
				totalRequests: 2,
				totalSpend: 2,
				overallCacheHitRate: 5,
				rowLimit: ANALYTICS_ROW_BUDGET,
				truncated: true,
			},
		});
		const html = buildDashboardBody(usage, true);
		expect(html).toContain('data-analytics-truncated="true"');
		expect(html).toContain("more models than the");
		expect(html).toContain(String(ANALYTICS_ROW_BUDGET));
		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("renders usage variants for regular and management keys", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			"usage.backgroundPolling.enabled": true,
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();
		const regular = makeUsage({
			mode: "regular",
			isManagementKey: false,
			accountCredits: null,
			allKeys: null,
			selectedKeyHash: null,
			perKeyActivityHistory: null,
			dailyUsageHistory: [{ date: "2026-08-01", usage: 0, requests: 0 }],
			analytics: { modelBreakdown: [], totalRequests: 0, totalSpend: 0, overallCacheHitRate: 0 },
			analyticsUnavailableReason: "unavailable",
			isFreeTier: true,
			limit: null,
			limitRemaining: null,
			capabilities: {
				keys: "permissionDenied",
				credits: "unavailable",
				activity: "unavailable",
				perKeyActivity: "unavailable",
				analytics: "unavailable",
				keyManagement: "permissionDenied",
			},
		});
		const html = buildDashboardBody(regular, false);
		expect(html).toContain("Free Tier");
		expect(html).toContain("No model spend was recorded");
		expect(html).toContain("not available for this API key");

		const noLimitKey = {
			hash: "hash-2",
			name: "",
			label: "backup",
			disabled: true,
			totalUsed: 0,
			dailyUsage: 0,
			weeklyUsage: 0,
			monthlyUsage: 0,
			limit: null,
			limitRemaining: null,
			limitReset: null,
			usagePercent: null,
		};
		const management = makeUsage({
			allKeys: [noLimitKey],
			selectedKeyHash: "missing",
			accountCredits: { totalCredits: 0, totalUsage: 0, remaining: 0, usagePercent: 100 },
			dailyUsageHistory: [{ date: "2026-08-02", usage: 0, requests: 0 }],
			perKeyActivityHistory: {},
			analytics: null,
			analyticsUnavailableReason: "managementKeyRequired",
			usagePercent: 100,
		});
		const wide = buildDashboardBody(management, true);
		expect(wide).toContain("No limit");
		expect(wide).toContain('class="or-key-detail-limit or-key-detail-limit--unlimited"');
		expect(wide).toContain("No spending limit");
		expect(wide).toContain("requires a management key");
		(vscode.workspace as any)._configValues = original;
		ConfigService.instance.dispose();
	});

	it("chooses the lowest available balance", () => {
		expect(getAvailableCredits(makeUsage())).toBe(8);
		expect(getAvailableCredits(makeUsage({ limit: null, limitRemaining: null }))).toBe(18);
		expect(
			getAvailableCredits(makeUsage({ limit: null, limitRemaining: null, accountCredits: null })),
		).toBeNull();
	});
});
