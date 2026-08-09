/**
 * Unit tests for statusBarPresenter — buildStatusBarViewModel,
 * relative age formatting, and view model construction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildStatusBarViewModel } from "../../ui/status/statusBarPresenter";
import { formatTimestamp } from "../../ui/formatting/formatting";
import type { ModelPricingInfo, CachedPricingData } from "../../types";

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
	return { fetchedAt: new Date().toISOString(), models };
}

describe("buildStatusBarViewModel", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	it("returns 'No OpenRouter model' when no display name (no model)", () => {
		const vm = buildStatusBarViewModel(undefined, undefined, undefined);
		expect(vm.text).toBe("No OpenRouter model");
		expect(vm.show).toBe(true);
	});

	it("returns question mark state when display name exists but no pricing", () => {
		const vm = buildStatusBarViewModel("My Model", undefined, undefined);
		expect(vm.text).toContain("$(question)");
		expect(vm.backgroundColor).toBeDefined();
		expect(vm.show).toBe(true);
	});

	it("returns pricing info when pricing is available", () => {
		const model = makeModel();
		const cache = makeCacheData([model]);
		const vm = buildStatusBarViewModel("GPT-4o", model, cache);
		expect(vm.text).toBeDefined();
		expect(vm.show).toBe(true);
		// Should not have warning background for non-deprecated
		expect(vm.backgroundColor).toBeUndefined();
	});

	it("uses warning background for deprecated models", () => {
		const model = makeModel({ isDeprecated: true });
		const cache = makeCacheData([model]);
		const vm = buildStatusBarViewModel("Old Model", model, cache);
		expect(vm.backgroundColor).toBeDefined();
	});

	it("handles pricing without cache", () => {
		const model = makeModel();
		const vm = buildStatusBarViewModel("GPT-4o", model, undefined);
		expect(vm.text).toBeDefined();
		expect(vm.show).toBe(true);
	});

	it("shows the pricing update timestamp above the action links", () => {
		const model = makeModel({ id: "openai/gpt-4o-updated-tooltip" });
		const fetchedAt = "2026-08-03T16:18:44.000Z";
		const vm = buildStatusBarViewModel("GPT-4o", model, { fetchedAt, models: [model] });
		const tooltip = (vm.tooltip as { value: string }).value;
		const updated = `*Updated ${formatTimestamp(fetchedAt)}*`;
		const actionLinks = "[$(refresh) Refresh]";

		expect(tooltip).toContain(updated);
		expect(tooltip).not.toContain("cached");
		expect(tooltip.indexOf(updated)).toBeLessThan(tooltip.indexOf(actionLinks));
	});

	it("formats the pricing update timestamp using the shared UTC policy", () => {
		const fetchedAt = "2026-08-02T12:00:00.000Z";
		const cache = makeCacheData([makeModel()]);
		cache.fetchedAt = fetchedAt;
		const vm = buildStatusBarViewModel("GPT-4o", makeModel(), cache);
		const tooltip = (vm.tooltip as { value: string }).value;

		expect(tooltip).toContain(`*Updated ${formatTimestamp(fetchedAt)}*`);
		expect(tooltip).not.toContain("cached");
	});

	it("rebuilds the tooltip when the blended rate changes for the same cache entry", () => {
		const model = makeModel({ id: "openai/gpt-4o-tooltip-refresh" });
		const cache = makeCacheData([model]);

		const before = buildStatusBarViewModel("GPT-4o", model, cache);
		model.blendedRate = 1.25;
		const after = buildStatusBarViewModel("GPT-4o", model, cache);

		expect(after.tooltip).not.toBe(before.tooltip);
	});

	it("rebuilds the tooltip when the cache timestamp changes", () => {
		const model = makeModel({ id: "openai/gpt-4o-cache-refresh" });
		const first = buildStatusBarViewModel("GPT-4o", model, makeCacheData([model]));
		const second = buildStatusBarViewModel("GPT-4o", model, {
			fetchedAt: new Date(Date.now() - 60_000).toISOString(),
			models: [model],
		});
		expect(second.tooltip).not.toBe(first.tooltip);
	});

	it("shows free indicator for free models in status bar text", () => {
		const model = makeModel({
			blendedRate: 0,
			isFree: true,
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
		});
		const cache = makeCacheData([model]);
		const vm = buildStatusBarViewModel("FreeModel", model, cache);
		expect(vm.text).toContain("$(gift)");
		expect(vm.text).toContain("Free");
	});

	it("shows free indicator in tooltip for free models", () => {
		const model = makeModel({
			blendedRate: 0,
			isFree: true,
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
		});
		const cache = makeCacheData([model]);
		const vm = buildStatusBarViewModel("FreeModel", model, cache);
		const tooltip = (vm.tooltip as { value: string }).value;
		// Should show gift icon in header badge
		expect(tooltip).toContain("$(gift)");
		// Should not contain blended rate formula for free models
		expect(tooltip).not.toContain("cache read");
		expect(tooltip).not.toContain("prompt");
		expect(tooltip).not.toContain("completion");
		// Should not have the code block with FREE text
		expect(tooltip).not.toContain("```");
	});
});
