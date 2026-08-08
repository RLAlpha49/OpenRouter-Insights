/**
 * AnalyticsService — queries the OpenRouter Analytics API for per-model
 * spend breakdowns, cache-hit rates, and usage trends.
 *
 * Exports:
 *   fetchModelSpendBreakdown() — POST /api/v1/analytics/query, returns
 *     per-model spend with percentages, request counts, and cache-hit rates.
 *
 * @see https://openrouter.ai/docs/api/api-reference/analytics/query
 */

import type {
	AnalyticsQueryRequest,
	AnalyticsResult,
	ModelSpendBreakdown,
} from "../../types-usage";
import type { ApiLogger } from "../logger";
import { noopApiLogger } from "../logger";
import { type HttpClient, defaultHttpClient } from "../transport/httpClient";
import { classifyError, createAbortController, fetchWithRetry } from "../transport/fetchHelpers";
import { OpenRouterHttpError, parseOpenRouterErrorEnvelope } from "../transport/openRouterError";
import { redactBodySnippet } from "../redaction";
import { decodeAnalyticsResponse, decodeOrThrow } from "../contractDecoders";
import type { DecodedAnalyticsResponse } from "../contractDecoders";
import {
	buildEndpointUrl,
	getEndpointContract,
	getEndpointRetryPolicy,
} from "../endpoint/endpointCatalog";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const ANALYTICS_RETRY = getEndpointRetryPolicy("analytics.query");
const ANALYTICS_CACHE_TTL_MS = 60_000;

/**
 * Row budget for one analytics query.
 *
 * The dashboard renders a per-model spend list, so the request only asks for
 * the number of rows that list can present. A capped response is reported as
 * truncated instead of being displayed as a complete account breakdown.
 */
export const ANALYTICS_ROW_BUDGET = 100;

interface CachedAnalyticsResult {
	result: AnalyticsResult;
	completedAt: number;
}

const analyticsInFlight = new Map<string, Promise<AnalyticsResult>>();
const analyticsCache = new Map<string, CachedAnalyticsResult>();
const clientIds = new WeakMap<object, number>();
let nextClientId = 1;

function validateAnalyticsRequest(apiKey: string, daysBack: number): void {
	if (!apiKey.trim()) throw new Error("Analytics API key cannot be empty");
	if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 365) {
		throw new Error("Analytics lookback must be an integer between 1 and 365 days");
	}
}

function getClientId(client: HttpClient): number {
	const objectClient = client as object;
	let id = clientIds.get(objectClient);
	if (id === undefined) {
		id = nextClientId++;
		clientIds.set(objectClient, id);
	}
	return id;
}

function analyticsRequestKey(
	apiKey: string,
	daysBack: number,
	client: HttpClient,
	baseUrl: string,
): string {
	let hash = 2166136261;
	for (const char of apiKey) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	const endDate = new Date();
	const startDate = new Date(endDate);
	startDate.setUTCDate(startDate.getUTCDate() - daysBack);
	return `${getClientId(client)}:${hash >>> 0}:${daysBack}:${startDate.toISOString().slice(0, 10)}:${endDate.toISOString().slice(0, 10)}:${baseUrl}`;
}

/** Clear process-local analytics results after a credential or test boundary. */
export function clearAnalyticsCache(): void {
	analyticsInFlight.clear();
	analyticsCache.clear();
}

/**
 * Fetch per-model spend breakdown from OpenRouter's analytics endpoint.
 *
 * @param apiKey   OpenRouter API key (management key recommended).
 * @param daysBack Number of days to look back (default: 30).
 * @param client   HTTP client (default: global fetch).
 * @param baseUrl  Base URL (default: https://openrouter.ai/api/v1).
 */
export async function fetchModelSpendBreakdown(
	apiKey: string,
	daysBack: number = 30,
	client: HttpClient = defaultHttpClient,
	baseUrl: string = DEFAULT_BASE_URL,
	signal?: AbortSignal,
	logger: ApiLogger = noopApiLogger,
): Promise<AnalyticsResult> {
	validateAnalyticsRequest(apiKey, daysBack);
	const key = analyticsRequestKey(apiKey, daysBack, client, baseUrl);
	const cached = analyticsCache.get(key);
	if (cached && Date.now() - cached.completedAt < ANALYTICS_CACHE_TTL_MS) {
		return cached.result;
	}
	if (cached) analyticsCache.delete(key);

	const existing = analyticsInFlight.get(key);
	if (existing) return existing;

	const request = fetchModelSpendBreakdownUncached(
		apiKey,
		daysBack,
		client,
		baseUrl,
		signal,
		logger,
	);
	analyticsInFlight.set(key, request);
	void request
		.then(
			(result) => {
				analyticsCache.set(key, { result, completedAt: Date.now() });
			},
			() => {
				// Failed and cancelled requests are never cached.
			},
		)
		.finally(() => {
			analyticsInFlight.delete(key);
		});
	return request;
}

async function fetchModelSpendBreakdownUncached(
	apiKey: string,
	daysBack: number,
	client: HttpClient,
	baseUrl: string,
	signal?: AbortSignal,
	logger: ApiLogger = noopApiLogger,
): Promise<AnalyticsResult> {
	const analyticsUrl = buildEndpointUrl(baseUrl, "analytics.query");

	const endDate = new Date();
	const startDate = new Date(endDate);
	startDate.setUTCDate(startDate.getUTCDate() - daysBack);

	const dateFrom = startDate.toISOString().slice(0, 10);
	const dateTo = endDate.toISOString().slice(0, 10);

	const body: AnalyticsQueryRequest = {
		dimensions: ["model"],
		time_range: {
			start: startDate.toISOString(),
			end: endDate.toISOString(),
		},
		order_by: { field: "total_usage", direction: "desc" },
		limit: ANALYTICS_ROW_BUDGET,
		metrics: [
			"total_usage",
			"request_count",
			"tokens_total",
			"tokens_prompt",
			"tokens_completion",
			"cache_hit_rate",
		],
	};

	logger.debug(`AnalyticsService: querying ${dateFrom} → ${dateTo}`);

	try {
		const result = await fetchWithRetry(
			async () => {
				const { controller, dispose } = createAbortController(
					getEndpointContract("analytics.query").timeoutMs,
					signal,
				);

				try {
					const endpoint = getEndpointContract("analytics.query");
					const res = await client.fetch(analyticsUrl, {
						method: endpoint.method,
						endpointId: "analytics.query",
						signal: controller.signal,
						headers: {
							Accept: "application/json",
							"Content-Type": "application/json",
							Authorization: `Bearer ${apiKey}`,
						},
						body: JSON.stringify(body),
					});

					if (!res.ok) {
						let bodySnippet = "";
						try {
							bodySnippet = (await res.text()).slice(0, 200);
						} catch {
							/* ignore */
						}
						const envelope = parseOpenRouterErrorEnvelope(bodySnippet);
						const sanitized = redactBodySnippet(bodySnippet);
						logger.warn(
							`AnalyticsService: ${res.status}`,
							envelope.type ? `type=${envelope.type}` : "",
							sanitized || "<empty>",
						);
						throw new OpenRouterHttpError({
							label: "analytics",
							status: res.status,
							headers: res.headers,
							envelope,
							bodySnippet: sanitized,
						});
					}

					return decodeOrThrow("analytics.query", decodeAnalyticsResponse, await res.json());
				} finally {
					dispose();
				}
			},
			{
				maxRetries: ANALYTICS_RETRY.maxRetries,
				baseDelayMs: ANALYTICS_RETRY.baseDelayMs,
				signal,
				onAttempt: (attempt, err) => {
					logger.warn(
						`AnalyticsService attempt ${attempt}/${ANALYTICS_RETRY.maxRetries} failed (${err.kind}, HTTP ${err.code}):`,
						err.message,
					);
				},
			},
		);

		return buildAnalyticsResult(result.value, result.health);
	} catch (err) {
		const lastError = classifyError(err);
		logger.error("AnalyticsService: query failed:", lastError.message);
		throw err;
	}
}

/**
 * Build a normalized AnalyticsResult from the decoded API response.
 *
 * The decoder already dropped rows that cannot support these calculations and
 * recorded why in `contractHealth`, so this function performs no second round
 * of silent defaulting: it aggregates the values it was given and reports a
 * capped response as truncated.
 */
function buildAnalyticsResult(
	response: DecodedAnalyticsResponse,
	contractHealth: AnalyticsResult["contractHealth"],
): AnalyticsResult {
	const rows = response.rows;
	const truncated = response.metadata?.truncated ?? rows.length >= ANALYTICS_ROW_BUDGET;
	if (rows.length === 0) {
		return {
			totalSpend: 0,
			totalRequests: 0,
			modelBreakdown: [],
			overallCacheHitRate: 0,
			rowLimit: ANALYTICS_ROW_BUDGET,
			truncated,
			contractHealth,
		};
	}

	const totalSpend = rows.reduce((sum, row) => sum + row.totalUsage, 0);
	const totalRequests = rows.reduce((sum, row) => sum + row.requestCount, 0);
	const totalTokens = rows.reduce((sum, row) => sum + (row.tokensTotal ?? 0), 0);

	const modelBreakdown: ModelSpendBreakdown[] = rows
		.map((row) => ({
			modelId: row.model,
			totalUsage: row.totalUsage,
			requestCount: row.requestCount,
			tokensTotal: row.tokensTotal ?? 0,
			promptTokens: row.promptTokens ?? 0,
			completionTokens: row.completionTokens ?? 0,
			cacheHitRate: (row.cacheHitRate ?? 0) * 100,
			percentage: totalSpend > 0 ? (row.totalUsage / totalSpend) * 100 : 0,
		}))
		.sort((a, b) => b.totalUsage - a.totalUsage);

	const overallCacheHitRate =
		totalTokens > 0
			? (rows.reduce((sum, row) => sum + (row.cacheHitRate ?? 0) * (row.tokensTotal ?? 0), 0) /
					totalTokens) *
				100
			: 0;

	return {
		totalSpend,
		totalRequests,
		modelBreakdown,
		overallCacheHitRate,
		rowLimit: ANALYTICS_ROW_BUDGET,
		truncated,
		contractHealth,
	};
}
