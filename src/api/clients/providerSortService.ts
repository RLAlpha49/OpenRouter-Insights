/**
 * ProviderSortService — resolves per-model pricing overrides that mirror
 * OpenRouter's provider routing preference (general.providerSort).
 *
 * For each tracked model it fetches GET /api/v1/models/{id}/endpoints,
 * selects the endpoint the router would try first under the configured
 * sort, and converts its prices into a ProviderOverride. Results are
 * cached for one hour. Individual failures degrade to catalog pricing.
 */

import { EndpointClient } from "../transport/endpointClient";
import type { HttpClient } from "../transport/httpClient";
import { noopApiLogger, type ApiLogger } from "../logger";
import { computeBlendedRate } from "./pricingService";
import {
	selectProviderEndpoint,
	stripVirtualVariant,
	type ProviderEndpoint,
	type ProviderSortOption,
} from "./providerSort";
import type { BlendWeights } from "../../models/domain";
import type { DisplayPricing } from "../../types";

/** Pricing fields taken from the winning provider endpoint. */
export interface ProviderOverride {
	perMillion: DisplayPricing;
	blendedRate: number;
	quantization: string;
	topProviderId: string;
	topProviderName: string;
	topProviderContextLength: number;
	topProviderMaxCompletionTokens: number;
}

interface CacheEntry {
	override: ProviderOverride;
	fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

function toPerMillionToken(value: unknown): number {
	const n = typeof value === "string" ? Number.parseFloat(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n * 1_000_000 : 0;
}

/** Map one decoded wire endpoint onto the pure-selection input shape. */
function toSelectionEndpoint(raw: Record<string, unknown>): ProviderEndpoint {
	const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
	return {
		providerName: String(raw.provider_name ?? ""),
		tag: String(raw.tag ?? ""),
		pricing: {
			prompt: Number(pricing.prompt ?? 0),
			completion: Number(pricing.completion ?? 0),
			inputCacheRead:
				pricing.input_cache_read !== undefined ? Number(pricing.input_cache_read) : undefined,
		},
		contextLength: typeof raw.context_length === "number" ? raw.context_length : undefined,
		maxCompletionTokens:
			typeof raw.max_completion_tokens === "number" ? raw.max_completion_tokens : undefined,
		quantization: typeof raw.quantization === "string" ? raw.quantization : undefined,
		status: Number(raw.status ?? 0),
		uptimeLast30m: typeof raw.uptime_last_30m === "number" ? raw.uptime_last_30m : null,
		throughputLast30m: typeof raw.throughput_last_30m === "number" ? raw.throughput_last_30m : null,
		latencyLast30m: typeof raw.latency_last_30m === "number" ? raw.latency_last_30m : null,
	};
}

export class ProviderSortService {
	private readonly _logger: ApiLogger;
	private readonly _cache = new Map<string, CacheEntry>();

	constructor(logger: ApiLogger = noopApiLogger) {
		this._logger = logger;
	}

	/** Cached override for a model ID if fresh, else undefined. */
	getCached(modelId: string): ProviderOverride | undefined {
		const entry = this._cache.get(modelId);
		if (!entry) return undefined;
		if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return undefined;
		return entry.override;
	}

	clearCache(): void {
		this._cache.clear();
	}

	async resolveOverrides(
		trackedIds: readonly string[],
		sort: ProviderSortOption,
		client: HttpClient,
		baseUrl: string,
		blendWeights: BlendWeights,
		signal?: AbortSignal,
	): Promise<Map<string, ProviderOverride>> {
		const out = new Map<string, ProviderOverride>();
		if (sort === "default" || trackedIds.length === 0) return out;

		const origin = new URL(baseUrl).origin;
		const endpointClient = new EndpointClient(client, {
			apiKeyProvider: async () => "",
			managementKeyProvider: async () => "",
		});

		for (const rawId of trackedIds) {
			const modelId = stripVirtualVariant(rawId);
			const cached = this.getCached(rawId) ?? this.getCached(modelId);
			if (cached) {
				out.set(rawId, cached);
				continue;
			}
			try {
				const response = await endpointClient.request("models.endpoints", {
					url: `${origin}/api/v1/models/${modelId}/endpoints`,
					input: { model: modelId },
					signal,
					retry: { maxRetries: 1, baseDelayMs: 0 },
				});
				const winner = selectProviderEndpoint(
					(response?.value.endpoints ?? []).map(toSelectionEndpoint),
					sort,
				);
				if (!winner) continue;
				const override = this._buildOverride(winner, blendWeights);
				this._cache.set(rawId, { override, fetchedAt: Date.now() });
				this._cache.set(modelId, { override, fetchedAt: Date.now() });
				out.set(rawId, override);
			} catch (err) {
				this._logger.warn(
					`ProviderSortService: endpoints fetch failed for ${modelId}: ${String(err)}`,
				);
			}
		}
		return out;
	}

	private _buildOverride(winner: ProviderEndpoint, blendWeights: BlendWeights): ProviderOverride {
		const perMillion: DisplayPricing = {
			prompt: toPerMillionToken(winner.pricing.prompt),
			completion: toPerMillionToken(winner.pricing.completion),
			image: 0,
			request: 0,
			inputCacheRead: toPerMillionToken(winner.pricing.inputCacheRead),
			inputCacheWrite: 0,
			webSearch: 0,
			internalReasoning: 0,
		};
		return {
			perMillion,
			blendedRate: computeBlendedRate(perMillion, blendWeights),
			quantization: winner.quantization ?? "",
			topProviderId: winner.tag,
			topProviderName: winner.providerName,
			topProviderContextLength: winner.contextLength ?? 0,
			topProviderMaxCompletionTokens: winner.maxCompletionTokens ?? 0,
		};
	}
}
