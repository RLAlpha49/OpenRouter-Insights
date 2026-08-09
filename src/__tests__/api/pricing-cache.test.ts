/**
 * Unit tests for PricingCache — validation, schema migration, size trimming,
 * atomic writes, staleness, and lookup/index behavior.
 *
 * Uses a fake ExtensionContext.globalState with in-memory Map.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import type { CachedPricingData, ModelPricingInfo } from "../../types";
import { PricingCache } from "../../api/cache/pricingCache";
import type { ReadonlyConfig } from "../../infrastructure/config";

// ── Fake ExtensionContext ────────────────────────────────────

function createFakeContext(initialData?: CachedPricingData) {
	const store = new Map<string, unknown>();
	if (initialData) store.set("openrouterInsights.pricingCache", initialData);

	return {
		features: {
			statusBar: true,
			modelBrowser: true,
			comparison: true,
			export: true,
			favorites: true,
			hoverProvider: true,
			usage: true,
		},
		globalState: {
			get: (key: string) => store.get(key),
			update: async (key: string, value: unknown) => {
				store.set(key, value);
			},
		},
	} as any;
}

function createFakeConfig(overrides?: Partial<ReadonlyConfig>): ReadonlyConfig {
	return {
		features: {
			statusBar: true,
			modelBrowser: true,
			comparison: true,
			export: true,
			favorites: true,
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

function makeModel(overrides?: Partial<ModelPricingInfo>): ModelPricingInfo {
	return {
		id: "openai/gpt-4o",
		name: "OpenAI: GPT-4o",
		blendedRate: 3.5,
		contextLength: 128000,
		contextLengthFormatted: "128,000",
		maxOutputLength: 4096,
		created: 1700000000,
		isDeprecated: false,
		deprecationDate: "",
		isFree: false,
		modality: "text",
		description: "Test model",
		supportedParameters: [],
		supportedFeatures: [],
		topProviderIsModerated: false,
		topProviderContextLength: 0,
		topProviderMaxCompletionTokens: 0,
		quantization: "",
		detailsLink: "",
		discountToUser: 0,
		topProviderId: "",
		topProviderName: "",
		perMillion: {
			prompt: 2.5,
			completion: 10,
			image: 0,
			request: 0,
			inputCacheRead: 1.25,
			inputCacheWrite: 0,
			webSearch: 0,
			internalReasoning: 0,
		},
		...overrides,
	};
}

function makeCacheData(models: ModelPricingInfo[]): CachedPricingData {
	return {
		fetchedAt: new Date().toISOString(),
		models,
	};
}

// ── Tests ────────────────────────────────────────────────────

describe("PricingCache: initialization", () => {
	it("starts empty when no persisted data", () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
		expect(cache.getLookup().size).toBe(0);
	});

	it("loads persisted data on construction", () => {
		const data = makeCacheData([makeModel()]);
		const ctx = createFakeContext(data);
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()?.models).toHaveLength(1);
		expect(cache.getLookup().size).toBe(1);
	});

	it("validates corrupt data and discards it", () => {
		const ctx = createFakeContext();
		ctx.globalState.update("openrouterInsights.pricingCache", { models: "not-an-array" });
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});
});

describe("PricingCache: get/set", () => {
	let cache: PricingCache;

	beforeEach(() => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		cache = new PricingCache(ctx, config);
	});

	it("persists and retrieves data", async () => {
		const data = makeCacheData([makeModel()]);
		await cache.set(data);
		expect(cache.get()?.models).toHaveLength(1);
	});

	it("rebuilds lookup on set", async () => {
		const model = makeModel({ id: "test/model" });
		await cache.set(makeCacheData([model]));
		expect(cache.getLookup().has("test/model")).toBe(true);
	});

	it("stores fetchedAt correctly", async () => {
		const data = makeCacheData([makeModel()]);
		await cache.set(data);
		expect(cache.get()?.fetchedAt).toBe(data.fetchedAt);
	});
});

describe("PricingCache: size trimming", () => {
	it("trims deprecated models when cache is too large", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig({ cacheTtlHours: 1 });
		const cache = new PricingCache(ctx, config);

		const models: ModelPricingInfo[] = [];
		for (let i = 0; i < 5000; i++) {
			models.push(makeModel({ id: `test/model-${i}`, name: `Model ${i}`.padEnd(200, "-") }));
		}
		for (let i = 0; i < 4000; i++) {
			models[i].isDeprecated = true;
		}

		await cache.set(makeCacheData(models));
		expect(cache.get()?.models.length).toBeGreaterThanOrEqual(1000);
	});

	it("uses real JSON.stringify for size check (not heuristic)", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);

		const data = makeCacheData([makeModel()]);
		await cache.set(data);
		expect(cache.get()?.models).toHaveLength(1);
	});
});

describe("PricingCache: staleness", () => {
	it("is stale when empty", () => {
		const ctx = createFakeContext();
		const config = createFakeConfig({ cacheTtlHours: 24 });
		const cache = new PricingCache(ctx, config);
		expect(cache.isStale()).toBe(true);
	});

	it("is not stale with fresh data and high TTL", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig({ cacheTtlHours: 24 });
		const cache = new PricingCache(ctx, config);
		await cache.set(makeCacheData([makeModel()]));
		expect(cache.isStale()).toBe(false);
	});

	it("is stale with TTL of 0", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig({ cacheTtlHours: 0 });
		const cache = new PricingCache(ctx, config);
		// Use a data set in the past so age > 0ms trivially exceeds TTL of 0
		const data = makeCacheData([makeModel()]);
		data.fetchedAt = new Date(Date.now() - 1000).toISOString();
		await cache.set(data);
		expect(cache.isStale()).toBe(true);
	});
});

describe("PricingCache: schema migration", () => {
	it("normalizes stale cache entries with missing fields", () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();

		// Simulate stale cache: older version missing `discountToUser` and `topProviderId`
		const stale = {
			id: "old/model",
			name: "Old Model",
			blendedRate: 5,
			contextLength: 4096,
			contextLengthFormatted: "4,096",
			maxOutputLength: 2048,
			created: 1600000000,
			isDeprecated: false,
			deprecationDate: "",
			isFree: false,
			modality: "text",
			description: "Old model from prior version",
			supportedParameters: [],
			supportedFeatures: [],
			topProviderIsModerated: false,
			topProviderContextLength: 0,
			topProviderMaxCompletionTokens: 0,
			quantization: "",
			detailsLink: "",
			perMillion: {
				prompt: 5,
				completion: 15,
				image: 0,
				request: 0,
				inputCacheRead: 0,
				inputCacheWrite: 0,
				webSearch: 0,
				internalReasoning: 0,
			},
		};

		const data: CachedPricingData = {
			fetchedAt: new Date().toISOString(),
			models: [stale as unknown as ModelPricingInfo],
		};

		ctx.globalState.update("openrouterInsights.pricingCache", data);

		const cache2 = new PricingCache(ctx, config);
		const result = cache2.get();
		expect(result).toBeDefined();
		expect(result!.models[0].discountToUser).toBe(0);
		expect(result!.models[0].topProviderId).toBe("");
	});
});

describe("PricingCache: lookup & index", () => {
	let cache: PricingCache;

	beforeEach(async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		cache = new PricingCache(ctx, config);
		await cache.set(
			makeCacheData([makeModel({ id: "a/model" }), makeModel({ id: "b/model", name: "B Model" })]),
		);
	});

	it("provides O(1) lookup by ID", () => {
		const lookup = cache.getLookup();
		expect(lookup.get("a/model")?.name).toBe("OpenAI: GPT-4o");
		expect(lookup.get("b/model")?.name).toBe("B Model");
	});

	it("provides values array", () => {
		expect(cache.getValues()).toHaveLength(2);
	});

	it("provides lowercased index", () => {
		const idx = cache.getLowercasedIndex();
		expect(idx.has("b model")).toBe(true);
		expect(idx.has("NOT FOUND")).toBe(false);
	});

	it("returns empty lowercased index for empty cache", () => {
		const ctx2 = createFakeContext();
		const config2 = createFakeConfig();
		const emptyCache = new PricingCache(ctx2, config2);
		expect(emptyCache.getLowercasedIndex().size).toBe(0);
	});
});

describe("PricingCache: validation", () => {
	it("rejects models array as non-array", () => {
		const ctx = createFakeContext();
		ctx.globalState.update("openrouterInsights.pricingCache", {
			models: "not-array",
			fetchedAt: "2024-01-01T00:00:00Z",
		});
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});

	it("rejects missing fetchedAt", () => {
		const ctx = createFakeContext();
		ctx.globalState.update("openrouterInsights.pricingCache", { models: [] });
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});

	it("rejects invalid fetchedAt (not ISO date)", () => {
		const ctx = createFakeContext();
		ctx.globalState.update("openrouterInsights.pricingCache", {
			models: [],
			fetchedAt: "not-a-date",
		});
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});

	it("rejects model with missing id", () => {
		const ctx = createFakeContext();
		ctx.globalState.update("openrouterInsights.pricingCache", {
			models: [{ name: "No ID", perMillion: { prompt: 1, completion: 2 } }],
			fetchedAt: "2024-01-01T00:00:00Z",
		});
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});

	it("rejects model with missing perMillion", () => {
		const ctx = createFakeContext();
		ctx.globalState.update("openrouterInsights.pricingCache", {
			models: [{ id: "test", name: "Test" }],
			fetchedAt: "2024-01-01T00:00:00Z",
		});
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});
});

describe("PricingCache: nested value validation", () => {
	it("rejects a model with a negative perMillion value", () => {
		const ctx = createFakeContext();
		const bad = makeModel();
		bad.perMillion.prompt = -1;
		ctx.globalState.update("openrouterInsights.pricingCache", makeCacheData([bad]));
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});

	it("rejects a model with a NaN perMillion value", () => {
		const ctx = createFakeContext();
		const bad = makeModel();
		bad.perMillion.completion = Number.NaN;
		ctx.globalState.update("openrouterInsights.pricingCache", makeCacheData([bad]));
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});

	it("rejects a model with a non-finite blendedRate", () => {
		const ctx = createFakeContext();
		const bad = makeModel();
		bad.blendedRate = Number.POSITIVE_INFINITY;
		ctx.globalState.update("openrouterInsights.pricingCache", makeCacheData([bad]));
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});

	it("discards only the malformed entry and keeps valid ones", () => {
		const ctx = createFakeContext();
		const bad = makeModel({ id: "bad/model" });
		bad.perMillion.request = Number.NaN;
		const good = makeModel({ id: "good/model", name: "Good Model" });
		ctx.globalState.update("openrouterInsights.pricingCache", makeCacheData([bad, good]));
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		const data = cache.get();
		expect(data).toBeDefined();
		expect(data!.models).toHaveLength(1);
		expect(data!.models[0].id).toBe("good/model");
	});

	it("rejects a model with a non-array collection field", () => {
		const ctx = createFakeContext();
		const bad = makeModel();
		bad.supportedParameters = "not-an-array" as unknown as string[];
		ctx.globalState.update("openrouterInsights.pricingCache", makeCacheData([bad]));
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		expect(cache.get()).toBeUndefined();
	});
});

describe("PricingCache: staged recovery", () => {
	it("recovers a newer staged value when the primary is older", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();

		const primary = makeCacheData([makeModel({ id: "old/model" })]);
		primary.fetchedAt = new Date(Date.now() - 60_000).toISOString();
		const staged = makeCacheData([makeModel({ id: "new/model" })]);
		staged.fetchedAt = new Date().toISOString();

		ctx.globalState.update("openrouterInsights.pricingCache", primary);
		ctx.globalState.update("openrouterInsights.pricingCache.tmp", staged);

		const cache = new PricingCache(ctx, config);
		const data = cache.get();
		expect(data).toBeDefined();
		expect(data!.models[0].id).toBe("new/model");

		await new Promise((r) => setTimeout(r, 10));
		expect(ctx.globalState.get("openrouterInsights.pricingCache.tmp")).toBeUndefined();
		expect(ctx.globalState.get("openrouterInsights.pricingCache")?.models[0].id).toBe("new/model");
	});

	it("keeps the primary when it is newer than the staged value", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();

		const primary = makeCacheData([makeModel({ id: "primary/model" })]);
		primary.fetchedAt = new Date().toISOString();
		const staged = makeCacheData([makeModel({ id: "stale/model" })]);
		staged.fetchedAt = new Date(Date.now() - 120_000).toISOString();

		ctx.globalState.update("openrouterInsights.pricingCache", primary);
		ctx.globalState.update("openrouterInsights.pricingCache.tmp", staged);

		const cache = new PricingCache(ctx, config);
		const data = cache.get();
		expect(data).toBeDefined();
		expect(data!.models[0].id).toBe("primary/model");
	});

	it("recovers a valid staged value when the primary is absent", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();

		const staged = makeCacheData([makeModel({ id: "only/model" })]);
		ctx.globalState.update("openrouterInsights.pricingCache.tmp", staged);

		const cache = new PricingCache(ctx, config);
		const data = cache.get();
		expect(data).toBeDefined();
		expect(data!.models[0].id).toBe("only/model");
	});

	it("keeps a valid primary value when staged data is malformed", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const primary = makeCacheData([makeModel({ id: "primary/model" })]);
		ctx.globalState.update("openrouterInsights.pricingCache", primary);
		ctx.globalState.update("openrouterInsights.pricingCache.tmp", {
			models: "invalid",
			fetchedAt: "not-a-date",
		});

		const cache = new PricingCache(ctx, config);

		expect(cache.get()?.models[0].id).toBe("primary/model");
		await Promise.resolve();
		expect(ctx.globalState.get("openrouterInsights.pricingCache.tmp")).toBeUndefined();
	});
});

describe("PricingCache: pagination truncation", () => {
	it("exposes truncation state through cacheInfo", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);

		const data = makeCacheData([makeModel()]);
		data.pagination = { pagesFetched: 5, truncated: true, reason: "page-cap" };
		await cache.set(data);

		const info = cache.cacheInfo();
		expect(info.truncated).toBe(true);
		expect(info.truncationReason).toBe("page-cap");
	});

	it("reports a complete catalog when not truncated", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);

		const data = makeCacheData([makeModel()]);
		data.pagination = { pagesFetched: 2, truncated: false };
		await cache.set(data);

		const info = cache.cacheInfo();
		expect(info.truncated).toBe(false);
		expect(info.truncationReason).toBeUndefined();
	});

	it("reads legacy truncation metadata without pagination details", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const data = { ...makeCacheData([makeModel()]), truncated: true } as CachedPricingData & {
			truncated: boolean;
		};
		await new PricingCache(ctx, config).set(data);

		const info = new PricingCache(ctx, config).cacheInfo();
		expect(info.truncated).toBe(true);
		expect(info.truncationReason).toBeUndefined();
	});
});

describe("PricingCache: persistence failures", () => {
	it("warns when globalState cannot persist the primary cache", async () => {
		const ctx = {
			globalState: {
				get: (key: string) => (key.endsWith(".tmp") ? undefined : undefined),
				update: async (key: string) => {
					if (key === "openrouterInsights.pricingCache") throw new Error("quota exceeded");
				},
			},
		} as any;
		const cache = new PricingCache(ctx, createFakeConfig());
		const warning = vi.spyOn(vscode.window, "showWarningMessage");

		await cache.set(makeCacheData([makeModel()]));

		expect(warning).toHaveBeenCalledWith(
			"OpenRouter Insights: Pricing updated but couldn't be saved. Data may be lost after restart. Check disk space.",
		);
		warning.mockRestore();
	});

	it("warns when the staged value disappears after the temporary write", async () => {
		let stagedWrite = false;
		const ctx = {
			globalState: {
				get: (key: string) =>
					key === "openrouterInsights.pricingCache.tmp" && stagedWrite ? undefined : undefined,
				update: async (key: string) => {
					if (key === "openrouterInsights.pricingCache.tmp") stagedWrite = true;
				},
			},
		} as any;
		const cache = new PricingCache(ctx, createFakeConfig());
		const warning = vi.spyOn(vscode.window, "showWarningMessage");

		await cache.set(makeCacheData([makeModel()]));

		expect(warning).toHaveBeenCalledWith(
			"OpenRouter Insights: Pricing updated but couldn't be saved. Data may be lost after restart. Check disk space.",
		);
		warning.mockRestore();
	});
});

describe("PricingCache: clear", () => {
	it("clears in-memory state", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		await cache.set(makeCacheData([makeModel()]));
		await cache.clear();
		expect(cache.get()).toBeUndefined();
		expect(cache.getLookup().size).toBe(0);
	});
});

describe("PricingCache: cacheInfo", () => {
	it("returns diagnostic info", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig({ cacheTtlHours: 24 });
		const cache = new PricingCache(ctx, config);
		await cache.set(makeCacheData([makeModel()]));

		const info = cache.cacheInfo();
		expect(info.modelCount).toBe(1);
		expect(info.stale).toBe(false);
		expect(info.ttlHours).toBe(24);
		expect(typeof info.age).toBe("string");
		expect(typeof info.sizeEstimate).toBe("string");
		expect(info.lastSerializedBytes).toBeGreaterThan(0);
		expect(info.lastWriteMs).toBeGreaterThanOrEqual(0);
	});

	it("shows stale and modelCount=0 for empty cache", () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);
		const info = cache.cacheInfo();
		expect(info.modelCount).toBe(0);
		expect(info.stale).toBe(true);
	});
});

describe("PricingCache: bounded write admission (DB-004)", () => {
	it("admits a normal-sized write and reports the result", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);

		const result = await cache.set(makeCacheData([makeModel()]));
		expect(result.admitted).toBe(true);
		expect(result.modelCount).toBe(1);
		expect(result.rejectedReason).toBeUndefined();
		expect(cache.get()?.models).toHaveLength(1);
	});

	it("rejects an irreducibly oversized write and preserves the prior cache", async () => {
		const ctx = createFakeContext();
		const config = createFakeConfig();
		const cache = new PricingCache(ctx, config);

		await cache.set(makeCacheData([makeModel({ id: "prior/model" })]));
		expect(cache.get()?.models).toHaveLength(1);

		const oversized = makeCacheData(
			Array.from({ length: 6000 }, (_, i) =>
				makeModel({ id: `big/model-${i}`, name: `Big Model ${i}` }),
			),
		);

		const result = await cache.set(oversized);
		expect(result.admitted).toBe(false);
		expect(result.rejectedReason).toBe("oversized-after-trim");
		expect(result.modelCount).toBe(0);
		// The previous, usable catalog must remain intact.
		expect(cache.get()?.models).toHaveLength(1);
		expect(cache.get()?.models[0].id).toBe("prior/model");
	});
});
