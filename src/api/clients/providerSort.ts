/**
 * Provider-sort selection — mirrors OpenRouter's provider routing preferences
 * (https://openrouter.ai/docs/features/provider-routing) against the public
 * per-model endpoints API.
 *
 * The default strategy is price-based load balancing across top providers;
 * because the public API does not expose the router's balancing weights, the
 * "default" option keeps the catalog's top-level pricing unchanged. Explicit
 * sorts ("price", "throughput", "latency") pick the endpoint the router would
 * try first. Exacto quality signals are not publicly exposed, so there is no
 * exacto option.
 */

/** User-selectable provider sort strategies. */
export type ProviderSortOption = "default" | "price" | "throughput" | "latency";

export const PROVIDER_SORT_OPTIONS: readonly ProviderSortOption[] = [
	"default",
	"price",
	"throughput",
	"latency",
];

/** Minimum 30-minute uptime for throughput/latency candidates. */
const MIN_UPTIME_30M = 99;

/** One provider endpoint from GET /api/v1/models/{id}/endpoints (normalized). */
export interface ProviderEndpoint {
	providerName: string;
	tag: string;
	pricing: { prompt: number; completion: number; inputCacheRead?: number };
	contextLength?: number;
	maxCompletionTokens?: number;
	quantization?: string;
	status: number;
	uptimeLast30m: number | null;
	throughputLast30m: number | null;
	latencyLast30m: number | null;
}

/** Total per-token cost of an endpoint; NaN when either price is missing. */
function totalCost(e: ProviderEndpoint): number {
	return e.pricing.prompt + e.pricing.completion;
}

/** True when the endpoint is active and meets the uptime floor (or reports none). */
function isHealthyCandidate(e: ProviderEndpoint): boolean {
	return e.status === 0 && (e.uptimeLast30m ?? 0) >= MIN_UPTIME_30M;
}

/** Cheapest active endpoint by prompt+completion; ties keep list order. */
function pickCheapest(active: readonly ProviderEndpoint[]): ProviderEndpoint | undefined {
	let best: ProviderEndpoint | undefined;
	for (const e of active) {
		if (!Number.isFinite(totalCost(e))) continue;
		if (!best || totalCost(e) < totalCost(best)) best = e;
	}
	return best;
}

/** Extreme-metric picker: max for throughput, min for latency. */
function pickExtreme(
	active: readonly ProviderEndpoint[],
	metric: (_endpoint: ProviderEndpoint) => number | null,
	isBetter: (_candidate: number, _incumbent: number) => boolean,
): ProviderEndpoint | undefined {
	let best: ProviderEndpoint | undefined;
	let bestValue = 0;
	for (const endpoint of active) {
		const value = metric(endpoint);
		if (value === null || !isHealthyCandidate(endpoint)) continue;
		if (!best || isBetter(value, bestValue)) {
			best = endpoint;
			bestValue = value;
		}
	}
	return best;
}

/**
 * Pick the endpoint OpenRouter routing would use under the given sort.
 * Returns undefined when the sort is "default" or no endpoint qualifies —
 * callers keep catalog pricing in that case.
 */
export function selectProviderEndpoint(
	endpoints: readonly ProviderEndpoint[],
	sort: ProviderSortOption,
): ProviderEndpoint | undefined {
	if (sort === "default") return undefined;
	const active = endpoints.filter((e) => e.status === 0);
	if (active.length === 0) return undefined;

	switch (sort) {
		case "price":
			return pickCheapest(active);
		case "throughput":
			return pickExtreme(
				active,
				(e) => e.throughputLast30m,
				(candidate, best) => candidate > best,
			);
		case "latency":
			return pickExtreme(
				active,
				(e) => e.latencyLast30m,
				(candidate, best) => candidate < best,
			);
		default:
			return undefined;
	}
}

/** Routing-only variant suffixes that have no endpoint pool of their own. */
const VIRTUAL_VARIANTS = new Set(["nitro", "floor", "exacto"]);

/** Strip a trailing virtual routing variant (`:nitro`, `:floor`, `:exacto`). Keeps `:free`. */
export function stripVirtualVariant(modelId: string): string {
	const colon = modelId.lastIndexOf(":");
	if (colon <= 0) return modelId;
	const suffix = modelId.slice(colon + 1);
	return VIRTUAL_VARIANTS.has(suffix) ? modelId.slice(0, colon) : modelId;
}
