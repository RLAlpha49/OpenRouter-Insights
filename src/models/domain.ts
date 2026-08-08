/**
 * Domain constants — shared blend weights and pure computations.
 * Single source of truth for pricing blend weights used across
 * pricingService (API layer) and formatting.ts (UI layer).
 *
 * Importing from the domain layer keeps the dependency graph clean:
 *   UI → domain ← API
 */

/** Blend weights for models with cache pricing. */
export const BLEND = {
	cacheRead: 0.8,
	cacheWrite: 0.05,
	prompt: 0.1,
	completion: 0.05,
} as const;

/** Blend weights for models without cache pricing. */
export const BLEND_NO_CACHE = {
	prompt: 0.85,
	completion: 0.15,
} as const;

export interface BlendWeights {
	cacheRead: number;
	cacheWrite: number;
	prompt: number;
	completion: number;
}

/**
 * Move the weight for unavailable pricing to the closest supported component.
 * Cache-read weight falls back to prompt pricing; cache-write weight falls
 * back to cache-read pricing when cache-read pricing is available, otherwise
 * it also falls back to prompt pricing.
 */
export function effectiveBlendWeights(
	weights: BlendWeights,
	hasCacheRead: boolean,
	hasCacheWrite: boolean,
): BlendWeights {
	let prompt = weights.prompt;
	let cacheRead = weights.cacheRead;
	let cacheWrite = weights.cacheWrite;

	if (!hasCacheRead) {
		prompt += cacheRead;
		cacheRead = 0;
	}
	if (!hasCacheWrite) {
		if (hasCacheRead) cacheRead += cacheWrite;
		else prompt += cacheWrite;
		cacheWrite = 0;
	}

	return { prompt, completion: weights.completion, cacheRead, cacheWrite };
}

/** Convert percentage settings into decimal blend weights. */
export function blendWeightsFromPercentages(
	prompt: number,
	completion: number,
	cacheRead: number,
	cacheWrite: number,
): BlendWeights {
	return {
		prompt: prompt / 100,
		completion: completion / 100,
		cacheRead: cacheRead / 100,
		cacheWrite: cacheWrite / 100,
	};
}
