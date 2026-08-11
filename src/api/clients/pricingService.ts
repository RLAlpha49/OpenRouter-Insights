/**
 * OpenRouter pricing service — fetches, parses, matches, and computes
 * model pricing from the public OpenRouter /models API endpoint.
 *
 * Exports:
 *   PricingFetcher      — stateful fetch + circuit breaker + ETag (per-instance)
 *   findModelById()     — exact lookup by OpenRouter model ID
 *   findBestMatch()     — fuzzy match for Copilot model names
 *   computeBlendedRate()— pure blend computation
 *   buildModelsUrl()    — construct the /models URL with sort/filter params
 */

import {
	type ModelPricingInfo,
	type OpenRouterModel,
	type DisplayPricing,
	type CachedPricingData,
	type ContractHealth,
} from "../../types";
import { BLEND, effectiveBlendWeights, type BlendWeights } from "../../models/domain";
import { noopApiLogger, type ApiLogger } from "../logger";
import { type HttpClient, defaultHttpClient } from "../transport/httpClient";
import { classifyError, fetchWithRetry } from "../transport/fetchHelpers";
import { OpenRouterHttpError, type OpenRouterErrorClass } from "../transport/openRouterError";
import type { RuntimeDiagnostics } from "../../infrastructure/runtimeDiagnostics";
import { redactUrl } from "../redaction";
import { mergeContractHealth } from "../contractDecoders";
import { buildEndpointUrl, getEndpointRetryPolicy } from "../endpoint/endpointCatalog";
import { EndpointClient } from "../transport/endpointClient";

const DEFAULT_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODELS_RETRY = getEndpointRetryPolicy("models.list");
const RETRY_MAX = MODELS_RETRY.maxRetries;
const RETRY_BASE_MS = MODELS_RETRY.baseDelayMs;
/** Maximum pages to fetch (to prevent infinite loops). */
const MAX_PAGES = 5;
/** Circuit breaker: max consecutive failures before exponential backoff across cycles. */
const CIRCUIT_BREAKER_MAX_FAILURES = 3;
/** Default sort order for the models endpoint. */
const DEFAULT_SORT: ModelsSortOption = "pricing-low-to-high";

export interface PricingCircuitState {
	status: "closed" | "open";
	consecutiveFailures: number;
	cooldownUntil: number | undefined;
	remainingMs: number;
}

/** Valid sort options accepted by the OpenRouter /models endpoint. */
export type ModelsSortOption =
	| "pricing-low-to-high"
	| "pricing-high-to-low"
	| "context-high-to-low"
	| "throughput-high-to-low"
	| "latency-low-to-high"
	| "most-popular"
	| "top-weekly"
	| "newest";

/** Parameters for constructing the /models URL. */
export interface ModelsUrlParams {
	/** Server-side sort order. */
	sort?: ModelsSortOption;
	/** Comma-separated output modalities filter. */
	output_modalities?: string;
	/** Comma-separated supported_parameters filter. */
	supported_parameters?: string;
}

/**
 * Build a fully-qualified /models URL with optional query parameters.
 * Base URL should be something like "https://openrouter.ai/api/v1/models".
 */
export function buildModelsUrl(baseUrl: string, params?: ModelsUrlParams): string {
	if (!params) return baseUrl;
	const qs = new URLSearchParams();
	if (params.sort && params.sort !== DEFAULT_SORT) {
		qs.set("sort", params.sort);
	}
	if (params.output_modalities) {
		qs.set("output_modalities", params.output_modalities);
	}
	if (params.supported_parameters) {
		qs.set("supported_parameters", params.supported_parameters);
	}
	const qsStr = qs.toString();
	return qsStr ? `${baseUrl}?${qsStr}` : baseUrl;
}

// ── Response body runtime validator (lightweight, no zod dep) ───
interface OpenRouterModelsResponseBody {
	data: unknown[];
	/** Pagination link (from API response). */
	links?: { next?: string };
}

interface PageResult {
	data: unknown[];
	links?: { next?: string };
	contractHealth: ContractHealth;
}

function isModelObject(obj: unknown): obj is Record<string, unknown> {
	return (
		typeof obj === "object" &&
		obj !== null &&
		typeof (obj as Record<string, unknown>).id === "string"
	);
}

function validateNextPageUrl(
	value: string,
	initialUrl: string,
): { ok: true; url: string } | { ok: false; reason: "invalid-link" | "cross-origin-link" } {
	try {
		const next = new URL(value);
		const initial = new URL(initialUrl);
		if (next.protocol !== "https:") return { ok: false, reason: "invalid-link" };
		if (next.origin !== initial.origin) return { ok: false, reason: "cross-origin-link" };
		return { ok: true, url: next.href };
	} catch {
		return { ok: false, reason: "invalid-link" };
	}
}

// ── PricingFetcher class ──────────────────────────────────────

/**
 * Encapsulates the stateful HTTP fetch + circuit breaker + ETag logic
 * for the OpenRouter /models endpoint. Each instance is independent,
 * enabling test isolation without `_resetForTesting()` anti-patterns
 * and allowing multiple fetchers for different base URLs.
 *
 * Pure functions (findModelById, findBestMatch, computeBlendedRate,
 * buildModelsUrl) remain as module-level exports with zero side effects.
 */
export class PricingFetcher {
	private readonly _logger: ApiLogger;
	private readonly _diagnostics?: RuntimeDiagnostics;
	private consecutiveFailures = 0;
	private lastSuccessEpoch = 0;
	private lastFailureEpoch = 0;
	private readonly pageCache = new Map<
		string,
		{ etag?: string; response: OpenRouterModelsResponseBody; health: ContractHealth }
	>();

	constructor(logger: ApiLogger = noopApiLogger, diagnostics?: RuntimeDiagnostics) {
		this._logger = logger;
		this._diagnostics = diagnostics;
	}

	/** Return a snapshot of the current pricing circuit state. */
	getCircuitState(now: number = Date.now()): PricingCircuitState {
		if (this.consecutiveFailures < CIRCUIT_BREAKER_MAX_FAILURES) {
			return {
				status: "closed",
				consecutiveFailures: this.consecutiveFailures,
				cooldownUntil: undefined,
				remainingMs: 0,
			};
		}

		const cooldownMs = Math.min(
			60_000 * Math.pow(2, this.consecutiveFailures - CIRCUIT_BREAKER_MAX_FAILURES),
			86_400_000,
		);
		const cooldownUntil = this.lastFailureEpoch + cooldownMs;
		return {
			status: now < cooldownUntil ? "open" : "closed",
			consecutiveFailures: this.consecutiveFailures,
			cooldownUntil,
			remainingMs: Math.max(0, cooldownUntil - now),
		};
	}

	// ── Circuit breaker helpers ─────────────────────────────

	/** Reset circuit breaker on success. */
	private resetCircuitBreaker(): void {
		this.consecutiveFailures = 0;
		this.lastFailureEpoch = 0;
	}

	/** Record a failure. Throws if circuit breaker is active. */
	private recordFailure(): number {
		this.consecutiveFailures++;
		this.lastFailureEpoch = Date.now();
		if (this.consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
			const backoffSec = Math.min(
				60 * Math.pow(2, this.consecutiveFailures - CIRCUIT_BREAKER_MAX_FAILURES),
				86400,
			);
			const delay = backoffSec * 1000;
			const elapsed = delay - (Date.now() - this.lastFailureEpoch);
			if (elapsed > 0) {
				this._logger.warn(
					`Circuit breaker active: ${this.consecutiveFailures} consecutive failures, ` +
						`cooldown ${(elapsed / 1000).toFixed(0)}s remaining`,
				);
				throw this.circuitOpenError(Math.ceil(elapsed / 1000));
			}
		}
		return this.consecutiveFailures;
	}

	// ── Public fetch entry point (instance method) ──────────────

	/**
	 * Fetch the full model list from OpenRouter and convert to our internal form.
	 * No API key needed — the /models endpoint is public.
	 *
	 * Uses fetchWithRetry for transient errors with exponential backoff + jitter.
	 * Includes circuit breaker: after 3+ consecutive failures, enforces
	 * exponentially increasing cooldown between full refresh cycles.
	 * Uses ETag/If-None-Match for conditional requests to save bandwidth.
	 * Fetches paginated results if the API returns links.next.
	 */
	async fetchModelPricing(
		client: HttpClient = defaultHttpClient,
		baseUrl: string = DEFAULT_MODELS_URL,
		sort?: ModelsSortOption,
		blendWeights: BlendWeights = BLEND,
		signal?: AbortSignal,
	): Promise<CachedPricingData> {
		this._logger.debug("fetchModelPricing: starting OpenRouter API fetch from", baseUrl);

		// Circuit-breaker check at cycle start
		if (this.consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
			const backoffSec = Math.min(
				60 * Math.pow(2, this.consecutiveFailures - CIRCUIT_BREAKER_MAX_FAILURES),
				86400,
			);
			const elapsed = Date.now() - this.lastFailureEpoch;
			if (elapsed < backoffSec * 1000) {
				const remaining = Math.ceil((backoffSec * 1000 - elapsed) / 1000);
				this._logger.warn(`fetchModelPricing: circuit breaker cooldown — ${remaining}s remaining`);
				throw this.circuitOpenError(remaining);
			}
			this._logger.info("fetchModelPricing: circuit breaker cooldown expired, retrying");
		}

		const initialUrl = buildModelsUrl(buildEndpointUrl(baseUrl, "models.list"), {
			sort: sort ?? DEFAULT_SORT,
		});

		try {
			let pagination: CachedPricingData["pagination"] = { pagesFetched: 0, truncated: false };
			const result = await fetchWithRetry(
				async () => {
					const firstPage = await this.doFetchModelsPage(client, initialUrl, signal);
					const allData = [firstPage.data];
					const health = [firstPage.contractHealth];
					const seenUrls = new Set([new URL(initialUrl).href]);

					let nextUrl = firstPage.links?.next;
					let pageCount = 1;
					while (nextUrl && pageCount < MAX_PAGES) {
						const validatedNext = validateNextPageUrl(nextUrl, initialUrl);
						if (!validatedNext.ok) {
							pagination = {
								pagesFetched: pageCount,
								truncated: true,
								reason: validatedNext.reason,
							};
							this._logger.warn(`fetchModelPricing: stopping pagination: ${validatedNext.reason}`);
							break;
						}
						if (seenUrls.has(validatedNext.url)) {
							pagination = { pagesFetched: pageCount, truncated: true, reason: "repeated-link" };
							this._logger.warn("fetchModelPricing: repeated pagination link detected, stopping");
							break;
						}
						seenUrls.add(validatedNext.url);
						this._logger.debug(
							`fetchModelPricing: fetching page ${pageCount + 1}: ${redactUrl(nextUrl)}`,
						);
						const page = await this.doFetchModelsPage(client, validatedNext.url, signal);
						allData.push(page.data);
						health.push(page.contractHealth);
						nextUrl = page.links?.next;
						pageCount++;
					}
					if (nextUrl && pageCount >= MAX_PAGES) {
						pagination = { pagesFetched: pageCount, truncated: true, reason: "page-cap" };
						this._logger.warn(
							`fetchModelPricing: reached max pages (${MAX_PAGES}), remaining models on subsequent pages not fetched`,
						);
					} else if (!pagination?.truncated) {
						pagination = { pagesFetched: pageCount, truncated: false };
					}

					return { data: allData.flat(), contractHealth: mergeContractHealth(health) };
				},
				{
					maxRetries: RETRY_MAX,
					baseDelayMs: RETRY_BASE_MS,
					signal,
					endpoint: "models.list",
					onAttempt: (attempt, err) => {
						this._logger.warn(
							`Fetch attempt ${attempt}/${RETRY_MAX} failed (${err.kind}, HTTP ${err.code}):`,
							err.message,
						);
					},
					onRequestObservation: (observation) => {
						this._diagnostics?.recordRequestObservation(observation);
					},
				},
			);

			const parsed = parseModelsResponse(result.data, blendWeights);
			if (parsed.models.length === 0) {
				// An all-invalid (or empty) collection must not replace a usable
				// cache with an empty result. Reject before marking the cycle
				// successful so the circuit breaker stays intact and the caller's
				// fallback path preserves the prior catalog.
				this._logger.warn(
					"fetchModelPricing: decoded 0 valid models; rejecting empty refresh to preserve prior cache",
				);
				throw new OpenRouterHttpError({
					label: "models.list",
					status: 502,
					errorClass: "malformed-response",
					envelope: {
						message: "Pricing response contained no valid models; preserving previous cache",
					},
				});
			}
			this.resetCircuitBreaker();
			this.lastSuccessEpoch = Date.now();
			this._logger.info(
				`fetchModelPricing: completed, ${parsed.models.length} models parsed across all pages`,
			);
			const data = parsed;
			data.contractHealth = result.contractHealth;
			// Surface page-cap truncation as a visible data-health state.
			data.pagination = pagination;
			data.truncated = pagination.truncated;
			return data;
		} catch (err) {
			if (err instanceof OpenRouterHttpError && err.aborted) throw err;

			// Only transport-instability classes (server, transport, rate-limit)
			// advance the circuit breaker. Permanent failures (auth, permission,
			// insufficient-credit, not-found, client, malformed-response) keep
			// their diagnostics but do not open a pricing cooldown that would
			// delay recovery from an unrelated problem.
			const failureClass: OpenRouterErrorClass =
				err instanceof OpenRouterHttpError
					? err.errorClass
					: (classifyError(err).errorClass ?? "malformed-response");
			if (
				failureClass === "server" ||
				failureClass === "transport" ||
				failureClass === "rate-limit"
			) {
				this.recordFailure();
			}

			if (err instanceof OpenRouterHttpError) {
				if (err.errorClass === "server" || err.errorClass === "transport") {
					throw new OpenRouterHttpError({
						label: err.label,
						status: err.status,
						errorClass: err.errorClass,
						envelope: {
							message: `OpenRouter API unreachable after ${RETRY_MAX} attempts: ${err.apiMessage || err.message}`,
							type: err.errorType,
						},
						bodySnippet: err.bodySnippet,
					});
				}
				throw err;
			}
			const lastError = classifyError(err);
			this._logger.error(
				"fetchModelPricing: exhausted all attempts",
				lastError ? `(${lastError.kind}, HTTP ${lastError.code})` : "",
			);
			if (lastError.kind === "permanent") {
				const errOut = new Error(
					`OpenRouter API error (HTTP ${lastError.code}): ${lastError.message}`,
				);
				(errOut as Error & { statusCode?: number }).statusCode = lastError.code;
				throw errOut;
			}
			const errOut = new Error(
				`OpenRouter API unreachable after ${RETRY_MAX} attempts: ${lastError.message}`,
			);
			(errOut as Error & { statusCode?: number }).statusCode = lastError.code;
			throw errOut;
		}
	}

	private circuitOpenError(remainingSeconds: number): OpenRouterHttpError {
		return new OpenRouterHttpError({
			label: "models",
			errorClass: "transport",
			envelope: {
				message: `Pricing circuit is open; retry in ${remainingSeconds}s`,
			},
		});
	}

	// ── Private fetch helpers ──────────────────────────────

	/**
	 * Fetch a single page of models from the OpenRouter API.
	 * Returns the raw data array + pagination links.
	 */
	private async doFetchModelsPage(
		client: HttpClient,
		url: string,
		externalSignal?: AbortSignal,
	): Promise<PageResult> {
		const pageKey = new URL(url).href;
		const cachedPage = this.pageCache.get(pageKey);
		this._logger.debug("doFetchModelsPage: sending GET", url);
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
		};
		if (cachedPage?.etag) headers["If-None-Match"] = cachedPage.etag;
		const endpointClient = new EndpointClient(client, {
			apiKeyProvider: async () => "",
			managementKeyProvider: async () => "",
		});
		const body = await endpointClient.request("models.list", {
			url,
			signal: externalSignal,
			allowNotModified: true,
			retry: { maxRetries: 1, baseDelayMs: 0 },
			init: { headers: new Headers(headers) },
		});
		if (!body) {
			if (!cachedPage) {
				throw new OpenRouterHttpError({ label: "models", status: 304, errorClass: "client" });
			}
			return {
				data: cachedPage.response.data,
				links: cachedPage.response.links,
				contractHealth: cachedPage.health,
			};
		}
		const response = body.value;
		this.pageCache.set(pageKey, {
			etag: body.responseHeaders?.get("ETag") ?? undefined,
			response,
			health: body.health,
		});
		return { data: response.data, links: response.links, contractHealth: body.health };
	}
}

/** Parse and validate individual model objects from the API response. */
function parseModelsResponse(
	dataArray: unknown[],
	blendWeights: BlendWeights = BLEND,
): CachedPricingData {
	const allModels = dataArray.map((item) => {
		if (!isModelObject(item)) {
			noopApiLogger.warn("parseModelsResponse: skipping non-object model entry:", typeof item);
			return null;
		}
		try {
			return toModelPricingInfo(item as unknown as OpenRouterModel, blendWeights);
		} catch (err) {
			noopApiLogger.warn(
				"parseModelsResponse: skipping model due to validation error:",
				String(err),
			);
			return null;
		}
	});

	const models = allModels.filter((m): m is ModelPricingInfo => m !== null);
	noopApiLogger.debug(
		"parseModelsResponse: parsed",
		models.length,
		"valid models",
		allModels.length - models.length > 0 ? `(${allModels.length - models.length} skipped)` : "",
	);

	const deprecatedCount = models.filter((m) => m.isDeprecated).length;
	const freeCount = models.filter((m) => m.blendedRate === 0).length;
	if (deprecatedCount > 0 || freeCount > 0) {
		noopApiLogger.debug(
			`parseModelsResponse: ${deprecatedCount} deprecated, ${freeCount} free models (of ${models.length})`,
		);
	}

	return {
		fetchedAt: new Date().toISOString(),
		models,
	};
}

/** Look up a model by its OpenRouter ID (exact match). */
export function findModelById(
	models: ModelPricingInfo[],
	id: string,
): ModelPricingInfo | undefined {
	return models.find((m) => m.id === id);
}

/** Resolve dated paid/free provider variants without crossing pricing routes. */
export function findModelVariant(
	models: readonly ModelPricingInfo[],
	lookup: Map<string, ModelPricingInfo>,
	id: string,
): ModelPricingInfo | undefined {
	const exact = lookup.get(id);
	if (exact) return exact;

	const isFree = /:free$/i.test(id);
	const baseId = id.replace(/:free$/i, "").replace(/-\d{8}$/, "");
	const candidate = lookup.get(`${baseId}${isFree ? ":free" : ""}`);
	if (candidate) return candidate;

	return models.find((model) => {
		const modelIsFree = /:free$/i.test(model.id);
		return (
			modelIsFree === isFree && model.id.replace(/:free$/i, "").replace(/-\d{8}$/, "") === baseId
		);
	});
}

/**
 * Attempt to find the best OpenRouter model match for a Copilot display name.
 * Single-pass scoring: exact name (4) > name contains (3) > ID contains (2) > last-segment (1).
 *
 * Accepts an optional pre-built lowercased index (from PricingCache) to
 * avoid per-model `.toLowerCase()` calls on every poll.
 */
export function findBestMatch(
	models: readonly ModelPricingInfo[],
	searchName: string,
	lowercasedIndex?: Map<string, ModelPricingInfo>,
): ModelPricingInfo | undefined {
	if (!searchName || typeof searchName !== "string") return undefined;

	const lower = searchName.toLowerCase().trim();

	// Fast path: exact lookup in the lowercased index (if available)
	if (lowercasedIndex) {
		const exact = lowercasedIndex.get(lower);
		if (exact) {
			noopApiLogger.debug(`findBestMatch: "${searchName}" → "${exact.id}" (indexed exact match)`);
			return exact;
		}
	}

	let bestMatch: ModelPricingInfo | undefined;
	let bestScore = 0;

	for (const m of models) {
		const score = scoreModelMatch(m, lower);
		if (score > bestScore) {
			bestScore = score;
			bestMatch = m;
			if (score === 4) break; // exact name — can't beat this
		}
	}

	if (bestMatch) {
		noopApiLogger.debug(`findBestMatch: "${searchName}" → "${bestMatch.id}" (score=${bestScore})`);
	} else {
		noopApiLogger.debug(
			`findBestMatch: no match for "${searchName}" (searched ${models.length} models)`,
		);
	}

	return bestMatch;
}

/** Score a single model against the search string (4 = exact name, 0 = no match). */
function scoreModelMatch(m: ModelPricingInfo, lower: string): number {
	if (m.name.toLowerCase() === lower) return 4;
	if (m.name.toLowerCase().includes(lower)) return 3;
	if (m.id.toLowerCase().includes(lower)) return 2;
	const lastSeg = m.id.split("/").pop()?.toLowerCase() ?? "";
	if (lastSeg === lower || lastSeg.includes(lower) || lower.includes(lastSeg)) return 1;
	return 0;
}

// -- internal helpers --

function toModelPricingInfo(
	m: OpenRouterModel,
	blendWeights: BlendWeights = BLEND,
): ModelPricingInfo {
	const perMillion = toPerMillion(m.pricing);
	// Guard against malformed API responses: all pricing values must be
	// non-negative, finite numbers. A negative or NaN value from a
	// compromised/buggy endpoint would propagate through the cache and
	// corrupt the display. Reject the model wholesale if any value fails.
	for (const [key, value] of Object.entries(perMillion)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			noopApiLogger.warn(
				`toModelPricingInfo: "${m.id}" has invalid pricing field "${key}" = ${value}, skipping model`,
			);
			throw new Error(`Model "${m.id}" has invalid pricing field "${key}": ${value}`);
		}
	}
	return {
		id: m.id,
		name: m.name,
		perMillion,
		blendedRate: computeBlendedRate(perMillion, blendWeights),
		contextLength: m.context_length,
		contextLengthFormatted: m.context_length.toLocaleString(),
		maxOutputLength: m.max_output_length ?? 0,
		created: m.created,
		isDeprecated: isModelDeprecated(m),
		deprecationDate: m.deprecation_date ?? "",
		isFree: m.is_free === true,
		modality: m.architecture?.modality ?? "",
		description: m.description ?? "",
		supportedParameters: m.supported_parameters ?? [],
		supportedFeatures: m.supported_features ?? [],
		topProviderIsModerated: m.top_provider?.is_moderated ?? false,
		topProviderContextLength: m.top_provider?.context_length ?? 0,
		topProviderMaxCompletionTokens: m.top_provider?.max_completion_tokens ?? 0,
		quantization: m.quantization ?? "",
		detailsLink: m.links?.details ?? "",
		discountToUser: m.discount_to_user ?? 0,
		topProviderId: m.top_provider?.id ?? "",
		topProviderName: m.top_provider?.name ?? "",
		inputModalities: m.input_modalities ?? [],
		outputModalities: m.output_modalities ?? [],
		isReady: m.is_ready,
	};
}

/** Models older than this (in milliseconds) are flagged as potentially deprecated. */
const DEPRECATION_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000; // 2 years

/** Deprecation keywords to look for in the model description. */
const DEPRECATION_KEYWORDS = ["deprecated", "legacy", "end-of-life", "sunset", "replaced by"];

/**
 * Determine if a model is deprecated.
 * Primary signal: `deprecation_date` from the API (authoritative).
 * Fallback heuristic: model age > 2 years OR deprecation keywords in description.
 */
function isModelDeprecated(m: OpenRouterModel): boolean {
	// Primary: API-provided deprecation date
	if (m.deprecation_date) {
		const depDate = Date.parse(m.deprecation_date);
		if (!Number.isNaN(depDate) && depDate <= Date.now()) return true;
	}
	// Fallback heuristic: old models (created more than 2 years ago)
	if (m.created > 0 && Date.now() - m.created * 1000 > DEPRECATION_AGE_MS) return true;
	// Fallback heuristic: description contains deprecation keywords
	const desc = (m.description ?? "").toLowerCase();
	return DEPRECATION_KEYWORDS.some((kw) => desc.includes(kw));
}

/** Convert numeric or string per-token pricing (USD) to per-1M-tokens numbers. */
function toPerMillion(p: OpenRouterModel["pricing"]): DisplayPricing {
	const parse = (s: string | number | undefined) =>
		(typeof s === "number" ? s : Number.parseFloat(s ?? "0") || 0) * 1_000_000;
	return {
		prompt: parse(p.prompt),
		completion: parse(p.completion),
		image: parse(p.image),
		request: parse(p.request),
		inputCacheRead: parse(p.input_cache_read),
		inputCacheWrite: parse(p.input_cache_write),
		webSearch: parse(p.web_search),
		internalReasoning: parse(p.internal_reasoning),
	};
}

/**
 * Compute an estimated blended rate per 1M tokens.
 *
 * For models with cache pricing: assumes 80% cache-read, 5% cache-write,
 * 10% fresh prompt, 5% completion — approximating real Copilot usage where
 * conversation context is heavily cached.
 *
 * For models without cache pricing: falls back to 85% prompt, 15%
 * completion (typical completion-only coding sessions).
 */
export function computeBlendedRate(pm: DisplayPricing, weights: BlendWeights = BLEND): number {
	return computeCacheBlend(pm, weights) ?? computeNoCacheBlend(pm, weights);
}

function isValidPrice(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function weightedRate(components: Array<[number, number]>): number {
	const totalWeight = components.reduce((sum, [, weight]) => sum + weight, 0);
	if (totalWeight === 0) return 0;
	return components.reduce((sum, [price, weight]) => sum + price * (weight / totalWeight), 0);
}

function computeCacheBlend(pm: DisplayPricing, weights: BlendWeights): number | undefined {
	const hasRead = isValidPrice(pm.inputCacheRead) && pm.inputCacheRead > 0;
	const hasWrite = isValidPrice(pm.inputCacheWrite) && pm.inputCacheWrite > 0;
	if (!hasRead && !hasWrite) return undefined;
	const effectiveWeights = effectiveBlendWeights(weights, hasRead, hasWrite);

	const components: Array<[number, number]> = [];
	const add = (price: unknown, weight: number) => {
		if (isValidPrice(price) && weight > 0) components.push([price, weight]);
	};
	add(pm.prompt, effectiveWeights.prompt);
	add(pm.completion, effectiveWeights.completion);
	if (hasRead && hasWrite) {
		add(pm.inputCacheRead, effectiveWeights.cacheRead);
		add(pm.inputCacheWrite, effectiveWeights.cacheWrite);
	} else if (hasRead) {
		add(pm.inputCacheRead, effectiveWeights.cacheRead);
	} else {
		add(pm.inputCacheWrite, effectiveWeights.cacheWrite);
	}
	return weightedRate(components);
}

function computeNoCacheBlend(pm: DisplayPricing, weights: BlendWeights): number {
	const components: Array<[number, number]> = [];
	const effectiveWeights = effectiveBlendWeights(weights, false, false);
	if (isValidPrice(pm.prompt)) components.push([pm.prompt, effectiveWeights.prompt]);
	if (isValidPrice(pm.completion)) components.push([pm.completion, effectiveWeights.completion]);
	if (components.length === 0) return 0;
	return weightedRate(components);
}
