/**
 * Usage detail loader and aggregator — the management-only history, per-key
 * activity, and analytics fan-out that extends a baseline usage snapshot. Kept
 * separate from acquisition and key management so optional detail work can fail
 * independently and be tested on its own.
 *
 * @see https://openrouter.ai/docs/api/api-reference
 */

import type {
	OpenRouterActivityResponse,
	UsageStats,
	KeyUsage,
	DailyUsagePoint,
	AnalyticsResult,
	UsageEndpointDiagnostic,
	UsageDetailsOptions,
	UsageDetailState,
	UsageRefreshSummary,
} from "../../types-usage";
import type { ContractHealth } from "../../types";
import type { ApiLogger } from "../logger";
import { noopApiLogger } from "../logger";
import type { HttpClient } from "../transport/httpClient";
import { defaultHttpClient } from "../transport/httpClient";
import { classifyError } from "../transport/fetchHelpers";
import { OpenRouterHttpError } from "../transport/openRouterError";
import { fetchModelSpendBreakdown } from "./analyticsService";
import { fetchUsageStats } from "./usageService";
import {
	fetchJson,
	getUrls,
	trustedUsageBaseUrl,
	DEFAULT_BASE_URL,
	failedContractHealth,
	endpointDiagnostic,
	type ProgressCallback,
} from "./usageTransport";

/** Max concurrent per-key activity fetches to avoid rate limiting. */
const ACTIVITY_CONCURRENCY = 3;

/** Fetch history and optional analytics only for an intentional detail view. */
export async function fetchUsageDetails(
	apiKey: string,
	selectedKeyHash: string | undefined,
	options: UsageDetailsOptions = {},
	client: HttpClient = defaultHttpClient,
	baseUrl: string = DEFAULT_BASE_URL,
	signal?: AbortSignal,
	onProgress?: ProgressCallback,
	logger: ApiLogger = noopApiLogger,
): Promise<UsageStats> {
	const currentBaseline =
		options.baseline ??
		(await fetchUsageStats(apiKey, selectedKeyHash, client, baseUrl, signal, onProgress, logger));
	if (currentBaseline.mode !== "management") return currentBaseline;

	const urls = getUrls(trustedUsageBaseUrl(baseUrl));

	onProgress?.("Fetching usage activity…");
	const [activityResult, perKeyActivityHistory, enrichment] = await Promise.all([
		fetchActivity(apiKey, client, urls, signal, logger, onProgress),
		fetchPerKeyActivity(
			apiKey,
			client,
			currentBaseline.allKeys,
			currentBaseline.selectedKeyHash ?? undefined,
			urls,
			signal,
			logger,
			onProgress,
		),
		fetchOptionalAnalytics(options, apiKey, client, urls, signal, logger, onProgress),
	]);
	return buildUsageDetails(
		currentBaseline,
		activityResult,
		perKeyActivityHistory,
		enrichment,
		options.includeAnalytics ?? false,
	);
}

function buildUsageDetails(
	baseline: UsageStats,
	activityResult: Awaited<ReturnType<typeof fetchActivity>>,
	perKeyActivityHistory: PerKeyActivityResult,
	enrichment: Awaited<ReturnType<typeof fetchAnalyticsEnrichment>>,
	includeAnalytics: boolean,
): UsageStats {
	const dailyUsageHistory = activityResult.data;
	if (dailyUsageHistory) {
		const today = baseline.allKeys
			? baseline.allKeys.reduce((sum, key) => sum + key.dailyUsage, 0)
			: baseline.dailyUsage;
		mergeToday(dailyUsageHistory, today);
	}

	const details: UsageStats = {
		...baseline,
		dailyUsageHistory,
		perKeyActivityHistory: perKeyActivityHistory.data,
		analytics: enrichment.analytics,
		analyticsUnavailableReason: includeAnalytics ? enrichment.unavailableReason : "disabled",
		capabilities: {
			...baseline.capabilities,
			activity: activityResult.data ? "available" : "unavailable",
			perKeyActivity: perKeyActivityHistory ? "available" : "unavailable",
		},
		contractHealth: {
			...baseline.contractHealth,
			...(activityResult.health ? { "activity.list": activityResult.health } : {}),
			...(enrichment.health ? { "analytics.query": enrichment.health } : {}),
		},
		endpointDiagnostics: buildDetailDiagnostics(
			baseline,
			activityResult,
			perKeyActivityHistory,
			enrichment,
		),
		refreshSummary: buildDetailSummary(baseline, activityResult, perKeyActivityHistory, enrichment),
		detailState: buildDetailState(activityResult, perKeyActivityHistory, enrichment),
	};
	if (enrichment.analytics) details.capabilities.analytics = "available";
	return details;
}

function buildDetailDiagnostics(
	baseline: UsageStats,
	activityResult: Awaited<ReturnType<typeof fetchActivity>>,
	perKeyActivityHistory: PerKeyActivityResult,
	enrichment: Awaited<ReturnType<typeof fetchAnalyticsEnrichment>>,
): UsageEndpointDiagnostic[] {
	return [
		...(baseline.endpointDiagnostics ?? []),
		...(activityResult.diagnostic ? [activityResult.diagnostic] : []),
		...perKeyActivityHistory.diagnostics,
		...(enrichment.diagnostic ? [enrichment.diagnostic] : []),
	];
}

function buildDetailSummary(
	baseline: UsageStats,
	activityResult: Awaited<ReturnType<typeof fetchActivity>>,
	perKeyActivityHistory: PerKeyActivityResult,
	enrichment: Awaited<ReturnType<typeof fetchAnalyticsEnrichment>>,
): UsageRefreshSummary {
	return {
		successfulEndpoints: [
			...(baseline.refreshSummary?.successfulEndpoints ?? []),
			...(activityResult.data ? ["activity.list"] : []),
			...(enrichment.analytics ? ["analytics.query"] : []),
		],
		failedEndpoints: [
			...(baseline.refreshSummary?.failedEndpoints ?? []),
			...(activityResult.diagnostic ? ["activity.list"] : []),
			...(perKeyActivityHistory.diagnostics.length > 0 ? ["activity.list"] : []),
			...(enrichment.diagnostic ? ["analytics.query"] : []),
		],
	};
}

function buildDetailState(
	activityResult: Awaited<ReturnType<typeof fetchActivity>>,
	perKeyActivityHistory: PerKeyActivityResult,
	enrichment: Awaited<ReturnType<typeof fetchAnalyticsEnrichment>>,
): UsageDetailState {
	const hasSuccess = Boolean(
		activityResult.data || perKeyActivityHistory.data || enrichment.analytics,
	);
	const hasFailure = Boolean(
		activityResult.diagnostic ||
		perKeyActivityHistory.diagnostics.length > 0 ||
		enrichment.diagnostic,
	);
	const now = new Date().toISOString();
	let status: UsageDetailState["status"] = "fresh";
	if (hasFailure) status = hasSuccess ? "stale" : "unavailable";
	return {
		status,
		lastAttemptAt: now,
		lastSuccessAt: hasSuccess ? now : undefined,
		failedSections: [
			...(activityResult.diagnostic ? ["activity"] : []),
			...(perKeyActivityHistory.diagnostics.length > 0 ? ["per-key-activity"] : []),
			...(enrichment.diagnostic ? ["analytics"] : []),
		],
	};
}

function fetchOptionalAnalytics(
	options: UsageDetailsOptions,
	apiKey: string,
	client: HttpClient,
	urls: ReturnType<typeof getUrls>,
	signal: AbortSignal | undefined,
	logger: ApiLogger,
	onProgress?: ProgressCallback,
): Promise<Awaited<ReturnType<typeof fetchAnalyticsEnrichment>>> {
	if (!options.includeAnalytics) return Promise.resolve({ analytics: null });
	onProgress?.("Fetching analytics data…");
	return fetchAnalyticsEnrichment(apiKey, client, urls, signal, logger, options.lookbackDays ?? 30);
}

/** Fetch account activity history (management only). Returns null when the call fails. */
async function fetchActivity(
	apiKey: string,
	client: HttpClient,
	urls: ReturnType<typeof getUrls>,
	signal?: AbortSignal,
	logger: ApiLogger = noopApiLogger,
	onProgress?: ProgressCallback,
): Promise<{
	endpoint: "activity.list";
	data: DailyUsagePoint[] | null;
	health?: ContractHealth;
	diagnostic?: UsageEndpointDiagnostic;
}> {
	onProgress?.("Fetching account activity history…");
	try {
		const activityRes = await fetchJson<OpenRouterActivityResponse>(
			urls.ACTIVITY_URL,
			apiKey,
			client,
			"activity.list",
			undefined,
			{ signal, logger },
		);
		const points = toDailyUsagePoints(activityRes.value.data);
		logger.info(
			"UsageService: fetched account activity:",
			points.length,
			"days, total",
			points.reduce((s, p) => s + p.usage, 0).toFixed(2),
			"USD",
		);
		return { endpoint: "activity.list", data: points, health: activityRes.health };
	} catch (err) {
		if (signal?.aborted) throw err;
		logger.warn(
			"UsageService: activity fetch failed, continuing without:",
			classifyError(err).message,
		);
		return {
			endpoint: "activity.list",
			data: null,
			health: failedContractHealth("activity.list", err),
			diagnostic: endpointDiagnostic("activity.list", err),
		};
	}
}

/** Fetch the optional analytics spend breakdown; degrades gracefully. */
async function fetchAnalyticsEnrichment(
	apiKey: string,
	client: HttpClient,
	urls: ReturnType<typeof getUrls>,
	signal?: AbortSignal,
	logger: ApiLogger = noopApiLogger,
	daysBack = 30,
): Promise<{
	analytics: AnalyticsResult | null;
	unavailableReason?: "managementKeyRequired" | "unavailable";
	health?: ContractHealth;
	diagnostic?: UsageEndpointDiagnostic;
}> {
	try {
		const analytics = await fetchModelSpendBreakdown(
			apiKey,
			daysBack,
			client,
			urls.BASE_URL,
			signal,
			logger,
		);
		return { analytics };
	} catch (err) {
		if (signal?.aborted) throw err;
		const statusCode =
			err instanceof OpenRouterHttpError ? err.status : (err as { statusCode?: number }).statusCode;
		const unavailableReason: "managementKeyRequired" | "unavailable" =
			statusCode === 401 || statusCode === 403 ? "managementKeyRequired" : "unavailable";
		logger.warn(
			"UsageService: analytics fetch failed, continuing without:",
			classifyError(err).message,
		);
		return {
			analytics: null,
			unavailableReason,
			health: failedContractHealth("analytics.query", err),
			diagnostic: endpointDiagnostic("analytics.query", err),
		};
	}
}

interface PerKeyActivityResult {
	data: Record<string, DailyUsagePoint[]> | null;
	diagnostics: UsageEndpointDiagnostic[];
}

/**
 * Fetch per-key daily activity history. Uses the /activity endpoint with
 * ?api_key_hash for each key. Prioritizes the selected key, then up to
 * `maxKeys` other active keys. Fetches in parallel with a concurrency cap.
 */
async function fetchPerKeyActivity(
	apiKey: string,
	client: HttpClient,
	allKeys: KeyUsage[] | null,
	selectedKeyHash: string | undefined,
	urls: ReturnType<typeof getUrls>,
	signal?: AbortSignal,
	logger: ApiLogger = noopApiLogger,
	onProgress?: ProgressCallback,
): Promise<PerKeyActivityResult> {
	if (!allKeys || allKeys.length === 0) return { data: null, diagnostics: [] };

	// Selected key first, then other active keys.
	const selected = selectedKeyHash ? allKeys.find((k) => k.hash === selectedKeyHash) : undefined;
	const others = allKeys.filter((k) => k.hash !== selectedKeyHash && !k.disabled);
	const toFetch = selected ? [selected, ...others].slice(0, 5) : others.slice(0, 5);

	const result: Record<string, DailyUsagePoint[]> = {};
	const diagnostics: UsageEndpointDiagnostic[] = [];

	for (let i = 0; i < toFetch.length; i += ACTIVITY_CONCURRENCY) {
		if (signal?.aborted) throw cancellationError();
		const batch = toFetch.slice(i, i + ACTIVITY_CONCURRENCY);
		onProgress?.(
			`Fetching per-key activity (${i + 1}-${Math.min(i + ACTIVITY_CONCURRENCY, toFetch.length)} of ${toFetch.length})…`,
		);
		const batchResults = await Promise.allSettled(
			batch.map(async (k) => {
				const url = `${urls.ACTIVITY_URL}?api_key_hash=${encodeURIComponent(k.hash)}`;
				const res = await fetchJson<OpenRouterActivityResponse>(
					url,
					apiKey,
					client,
					"activity.list",
					undefined,
					{ signal, logger },
				);
				const points = toDailyUsagePoints(res.value.data);
				mergeToday(points, k.dailyUsage);
				return { hash: k.hash, points, dailyUsage: k.dailyUsage };
			}),
		);

		appendActivityResults(result, diagnostics, batch, batchResults, logger);
		if (signal?.aborted) throw cancellationError();
	}

	return {
		data: Object.keys(result).length > 0 ? result : null,
		diagnostics,
	};
}

function cancellationError(): Error & { cancelled: true } {
	return Object.assign(new Error("Operation cancelled"), { cancelled: true as const });
}

function appendActivityResults(
	result: Record<string, DailyUsagePoint[]>,
	diagnostics: UsageEndpointDiagnostic[],
	batch: KeyUsage[],
	batchResults: PromiseSettledResult<{
		hash: string;
		points: DailyUsagePoint[];
		dailyUsage: number;
	}>[],
	logger: ApiLogger,
): void {
	for (const [index, r] of batchResults.entries()) {
		if (r.status === "fulfilled") {
			const { hash, points, dailyUsage } = r.value;
			result[hash] = points;
			logger.info(
				`UsageService: per-key activity ${hash.slice(0, 8)}:`,
				points.length,
				"days, total",
				points.reduce((s, p) => s + p.usage, 0).toFixed(2),
				"USD (dailyUsage:",
				dailyUsage.toFixed(4),
				")",
			);
		} else {
			const key = batch[index];
			const diagnostic = endpointDiagnostic("activity.list", r.reason);
			diagnostics.push({
				...diagnostic,
				resourceId: key?.hash,
				detail: classifyError(r.reason).message.slice(0, 160),
			});
			logger.warn(
				`UsageService: per-key activity failed for ${key?.hash.slice(0, 8) ?? "unknown"}:`,
				classifyError(r.reason).message,
			);
		}
	}
}

/**
 * Aggregate raw activity entries into per-day usage points for charting.
 * Activity entries come grouped by endpoint/model; this merges them by date.
 */
function toDailyUsagePoints(entries: OpenRouterActivityResponse["data"]): DailyUsagePoint[] {
	const dayMap = new Map<string, { usage: number; requests: number }>();
	for (const e of entries) {
		const existing = dayMap.get(e.date);
		if (existing) {
			existing.usage += e.usage;
			existing.requests += e.requests;
		} else {
			dayMap.set(e.date, { usage: e.usage, requests: e.requests });
		}
	}
	const points: DailyUsagePoint[] = [];
	for (const [date, agg] of dayMap) {
		points.push({ date, usage: agg.usage, requests: agg.requests });
	}
	points.sort((a, b) => a.date.localeCompare(b.date));
	return points;
}

/**
 * Append or update today's usage point from key-level daily usage.
 *
 * The activity endpoint only returns completed UTC days, so the current
 * partial day is never present. This merges today into the already-sorted
 * daily history so the chart includes real-time usage for the current day.
 */
function mergeToday(points: DailyUsagePoint[], dailyUsage: number): void {
	const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
	const last = points.at(-1);

	if (last?.date === today) {
		last.usage = Math.max(last.usage, dailyUsage);
	} else {
		points.push({ date: today, usage: dailyUsage, requests: 0 });
	}
}
