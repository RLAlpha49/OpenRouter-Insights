import { describe, expect, it } from "vitest";
import { costTier } from "../../ui/model-browser/costIconFactory";
import { deriveName } from "../../models/modelNameDeriver";
import { BLEND, BLEND_NO_CACHE, effectiveBlendWeights } from "../../models/domain";
import { computeBlendedRate } from "../../api/clients/pricingService";
import { ensureBlended } from "../../ui/formatting/formatting";

describe("costTier", () => {
	it.each([
		[0, 0],
		[0.5, 1],
		[0.99, 1],
		[3, 2],
		[10, 3],
		[15.01, 4],
		[20, 4],
	])("assigns $%s/M to tier %s", (rate, tier) => {
		expect(costTier(rate)).toBe(tier);
	});
});

describe("deriveName", () => {
	it.each([
		["openai/gpt-4o", "Gpt 4o"],
		["anthropic/claude-3-opus", "Claude 3 Opus"],
		["google/gemini-2.5-pro:exp", "Gemini 2.5 Pro Exp"],
		["gpt-4o", "Gpt 4o"],
		["openai/o1", "O1"],
	])("derives %s as %s", (id, expected) => {
		expect(deriveName(id)).toBe(expected);
	});
});

describe("ensureBlended", () => {
	it("returns a valid stored blended rate", () => {
		expect(ensureBlended({ blendedRate: 3.5 } as any)).toBe(3.5);
	});
	it("computes a rate when the stored value is NaN", () => {
		expect(
			ensureBlended({
				blendedRate: NaN,
				perMillion: {
					prompt: 1,
					completion: 10,
					inputCacheRead: 0,
					inputCacheWrite: 0,
				},
			} as any),
		).toBe(2.35);
	});
});

const pricing = {
	prompt: 2,
	completion: 8,
	inputCacheRead: 1,
	inputCacheWrite: 2,
	image: 0,
	request: 0,
	webSearch: 0,
	internalReasoning: 0,
};

describe("blended pricing", () => {
	it("keeps the configured blend constants normalized", () => {
		expect(BLEND.cacheRead + BLEND.cacheWrite + BLEND.prompt + BLEND.completion).toBe(1);
		expect(BLEND_NO_CACHE.prompt + BLEND_NO_CACHE.completion).toBe(1);
	});
	it("uses available cache pricing", () => {
		expect(computeBlendedRate(pricing)).toBeCloseTo(1.5, 2);
	});
	it("moves missing cache pricing to prompt or cache-read pricing", () => {
		expect(computeBlendedRate({ ...pricing, inputCacheRead: 0 })).toBeCloseTo(2.3, 2);
		expect(computeBlendedRate({ ...pricing, inputCacheRead: 0, inputCacheWrite: 0 })).toBeCloseTo(
			2.3,
			2,
		);
		expect(
			computeBlendedRate(
				{ ...pricing, inputCacheRead: 0, inputCacheWrite: 0 },
				{
					prompt: 0.1,
					completion: 0.05,
					cacheRead: 0.8,
					cacheWrite: 0.05,
				},
			),
		).toBeCloseTo(2.3, 2);
	});
	it("supports custom blend weights and free pricing", () => {
		expect(
			computeBlendedRate(
				{ ...pricing, inputCacheRead: 0, inputCacheWrite: 0 },
				{
					prompt: 0.5,
					completion: 0.25,
					cacheRead: 0.2,
					cacheWrite: 0.05,
				},
			),
		).toBeCloseTo(3.5, 2);
		expect(
			computeBlendedRate({
				...pricing,
				prompt: 0,
				completion: 0,
				inputCacheRead: 0,
				inputCacheWrite: 0,
			}),
		).toBe(0);
	});
});

describe("effectiveBlendWeights", () => {
	const weights = { prompt: 0.1, completion: 0.05, cacheRead: 0.8, cacheWrite: 0.05 };

	it("moves missing cache-read weight to prompt", () => {
		const result = effectiveBlendWeights(weights, false, true);
		expect(result.prompt).toBeCloseTo(0.9);
		expect(result.completion).toBe(0.05);
		expect(result.cacheRead).toBe(0);
		expect(result.cacheWrite).toBe(0.05);
	});
	it("moves missing cache-write weight to cache-read", () => {
		const result = effectiveBlendWeights(weights, true, false);
		expect(result.prompt).toBe(0.1);
		expect(result.completion).toBe(0.05);
		expect(result.cacheRead).toBeCloseTo(0.85);
		expect(result.cacheWrite).toBe(0);
	});
	it("moves both missing cache weights to prompt", () => {
		const result = effectiveBlendWeights(weights, false, false);
		expect(result.prompt).toBeCloseTo(0.95);
		expect(result.completion).toBe(0.05);
		expect(result.cacheRead).toBe(0);
		expect(result.cacheWrite).toBe(0);
	});
});
