/**
 * Unit tests for RefreshUseCase — concurrent coalescing, error handling,
 * callback invocation, and cache interaction.
 */

import { describe, it, expect, vi } from "vitest";
import { RefreshUseCase } from "../../use-cases/refreshUseCase";
import type { IPricingStore } from "../../api/cache/pricingStore";
import type { CachedPricingData } from "../../types";
import { createFakeReadonlyConfig } from "../__mocks__/config-test-helpers";
import { EventBus } from "../../infrastructure/eventBus";

function createFakeCache(overrides?: Partial<IPricingStore>): IPricingStore {
	return {
		get: () => undefined,
		set: vi.fn(),
		isStale: () => true,
		age: () => "never",
		clear: vi.fn(),
		cacheInfo: () => ({
			age: "never",
			modelCount: 0,
			sizeEstimate: "0 B",
			ttlHours: 24,
			stale: true,
		}),
		...overrides,
	};
}

function makeCacheData(): CachedPricingData {
	return {
		fetchedAt: new Date().toISOString(),
		models: [],
	};
}

describe("RefreshUseCase", () => {
	it("is not in progress initially", () => {
		const cache = createFakeCache();
		const config = createFakeReadonlyConfig();
		const useCase = new RefreshUseCase(cache, config);
		expect(useCase.isInProgress).toBe(false);
	});

	it("coalesces concurrent calls", async () => {
		const cache = createFakeCache();
		const config = createFakeReadonlyConfig();
		const useCase = new RefreshUseCase(cache, config);

		const p1 = useCase.execute();
		const p2 = useCase.execute();

		await Promise.all([p1, p2]);

		expect(cache.set).toHaveBeenCalledTimes(1);
	});

	it("gracefully degrades with cached data on fetch failure", async () => {
		const cachedData = makeCacheData();
		cachedData.models = [
			{
				id: "test/model",
				name: "Test Model",
				blendedRate: 0,
				contextLength: 4096,
				contextLengthFormatted: "4K",
				maxOutputLength: 4096,
				created: 0,
				isDeprecated: false,
				deprecationDate: "",
				isFree: true,
				modality: "text",
				description: "",
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
					prompt: 0,
					completion: 0,
					image: 0,
					request: 0,
					inputCacheRead: 0,
					inputCacheWrite: 0,
					webSearch: 0,
					internalReasoning: 0,
				},
			} as any,
		];
		const cache = createFakeCache({ get: () => cachedData });
		const config = createFakeReadonlyConfig();
		const useCase = new RefreshUseCase(cache, config);

		await expect(useCase.execute()).resolves.toBeUndefined();
	});

	it("emits a bounded failure outcome for a non-cancellation error", async () => {
		const eventBus = new EventBus();
		const failures: Array<{ label?: string; error: string }> = [];
		eventBus.on("refreshFailed", (failure) => failures.push(failure));
		const fetcher = {
			fetchModelPricing: vi.fn().mockRejectedValue(new Error("x".repeat(500))),
		};
		const useCase = new RefreshUseCase(
			createFakeCache(),
			createFakeReadonlyConfig(),
			fetcher as any,
			undefined,
			eventBus,
		);

		await useCase.execute();

		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ label: "pricing" });
		expect(failures[0].error.length).toBeLessThanOrEqual(240);
	});
});
