/**
 * UsageService — dual-mode OpenRouter usage fetcher.
 *
 * Regular API key:   GET /api/v1/key → single-key usage
 * Management key:    GET /api/v1/key → detect management mode
 *                    GET /api/v1/keys → list all keys with per-key usage
 *                    GET /api/v1/credits → account-level totals
 *
 * @see https://openrouter.ai/docs/api/api-reference
 */

import type {
	OpenRouterKeyResponse,
	OpenRouterKeysResponse,
	OpenRouterCreditsResponse,
	OpenRouterActivityResponse,
	UsageStats,
	KeyUsage,
	AccountCredits,
	DailyUsagePoint,
	CreateKeyRequest,
	CreateKeyResponse,
	UpdateKeyRequest,
	UpdateKeyResponse,
	DeleteKeyResponse,
	KeyManagementResult,
	AnalyticsResult,
	UsageCapabilities,
	UsageEndpointDiagnostic,
	UsageDetailsOptions,
	UsageDetailState,
	UsageRefreshSummary,
} from "../../types-usage";
import type { ApiLogger } from "../logger";
import { noopApiLogger } from "../logger";
import { type HttpClient, defaultHttpClient } from "../transport/httpClient";
import { classifyError } from "../transport/fetchHelpers";
import { OpenRouterHttpError } from "../transport/openRouterError";
import { redactUrl } from "../redaction";
import { buildEndpointUrl } from "../endpoint/endpointCatalog";
import { EndpointClient } from "../transport/endpointClient";
import { fetchModelSpendBreakdown } from "./analyticsService";
import type { DecodedResponse } from "../contractDecoders";
import type { ContractHealth } from "../../types";
import type { EndpointId } from "../endpoint/endpointCatalog";

/** Callback type for progress updates during fetch operations. */
export type ProgressCallback = (_message: string) => void;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function getUrls(baseUrl: string = DEFAULT_BASE_URL) {
	return {
		BASE_URL: baseUrl,
		KEY_URL: buildEndpointUrl(baseUrl, "keys.current"),
		KEYS_URL: buildEndpointUrl(baseUrl, "keys.list"),
		CREDITS_URL: buildEndpointUrl(baseUrl, "credits.get"),
		ACTIVITY_URL: buildEndpointUrl(baseUrl, "activity.list"),
	};
}

/** Max concurrent per-key activity fetches to avoid rate limiting. */
const ACTIVITY_CONCURRENCY = 3;

const TRUSTED_USAGE_ORIGIN = "https://openrouter.ai";

function validateKeyHash(hash: string): void {
	if (!/^[A-Za-z0-9_-]{3,256}$/.test(hash)) throw new Error("Invalid API key hash");
}

function validateKeyRequest(req: CreateKeyRequest | UpdateKeyRequest): void {
	if ("name" in req && req.name !== undefined && (!req.name.trim() || req.name.length > 256)) {
		throw new Error("API key name must be between 1 and 256 characters");
	}
	if (req.limit !== undefined && (!Number.isFinite(req.limit) || req.limit < 0)) {
		throw new Error("API key limit must be a finite non-negative number");
	}
	const expiration = "days_until_expiration" in req ? req.days_until_expiration : undefined;
	if (
		expiration !== undefined &&
		(!Number.isInteger(expiration) || expiration < 1 || expiration > 3650)
	) {
		throw new Error("API key expiration must be between 1 and 3650 days");
	}
}

function trustedUsageBaseUrl(_baseUrl: string): string {
	try {
		return `${TRUSTED_USAGE_ORIGIN}/api/v1`;
	} catch {
		return `${TRUSTED_USAGE_ORIGIN}/api/v1`;
	}
}

function failedContractHealth(endpointId: EndpointId, error: unknown): ContractHealth {
	const classified = classifyError(error);
	return {
		status: "partial",
		issueCount: 1,
		issues: [{ path: endpointId, message: `Request unavailable (${classified.kind})` }],
	};
}

// ── Fetch helpers ──────────────────────────────────────────────

/**
 * Transport failure raised before any HTTP status is known.
 *
 * `statusCode: 0` keeps the existing transient classification, while `cause`
 * and `endpointId` preserve the original exception for diagnostics.
 */
export class UsageTransportError extends Error {
	readonly statusCode = 0;
	constructor(
		readonly endpointId: EndpointId,
		cause: unknown,
	) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Fetch failed (${endpointId}): ${message}`, { cause });
		this.name = "UsageTransportError";
	}
}

async function fetchJson<T>(
	url: string,
	apiKey: string,
	client: HttpClient,
	endpointId: EndpointId,
	body?: Record<string, unknown>,
	options: { signal?: AbortSignal; logger?: ApiLogger } = {},
): Promise<DecodedResponse<T>> {
	const logger = options.logger ?? noopApiLogger;
	logger.debug(`UsageService: ${endpointId}`);
	try {
		const endpointClient = new EndpointClient(client, {
			apiKeyProvider: async () => apiKey,
			managementKeyProvider: async () => apiKey,
		});
		return (await endpointClient.request(endpointId, {
			url,
			signal: options.signal,
			init: body ? { body: JSON.stringify(body) } : undefined,
		})) as DecodedResponse<T>;
	} catch (err) {
		if (err instanceof OpenRouterHttpError) throw err;
		throw new UsageTransportError(endpointId, err);
	}
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Fetch usage stats. Automatically detects management keys and fetches
 * additional data (all keys, credits) when available.
 *
 * @param apiKey    The OpenRouter API key
 * @param selectedKeyHash  For management keys: the hash of the key to show usage for
 * @param onProgress Optional callback for progress updates
 */
export async function fetchUsageStats(
	apiKey: string,
	selectedKeyHash?: string,
	client: HttpClient = defaultHttpClient,
	baseUrl: string = DEFAULT_BASE_URL,
	signal?: AbortSignal,
	onProgress?: ProgressCallback,
	logger: ApiLogger = noopApiLogger,
): Promise<UsageStats> {
	const urls = getUrls(trustedUsageBaseUrl(baseUrl));
	logger.debug("UsageService: fetching usage from", urls.BASE_URL);

	try {
		return await doFetchAll(apiKey, selectedKeyHash, client, urls, logger, signal, onProgress);
	} catch (err) {
		if (err instanceof OpenRouterHttpError) {
			err.message = err.message.replace(/^OpenRouter [^ ]+ failed/, "OpenRouter API failed");
		}
		throw err;
	}
}

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

async function doFetchAll(
	apiKey: string,
	selectedKeyHash: string | undefined,
	client: HttpClient,
	urls: ReturnType<typeof getUrls>,
	logger: ApiLogger,
	signal?: AbortSignal,
	onProgress?: ProgressCallback,
): Promise<UsageStats> {
	const endpointDiagnostics: UsageEndpointDiagnostic[] = [];
	const successfulEndpoints = ["keys.current"];

	onProgress?.("Fetching API key info…");
	const keyData = await fetchJson<OpenRouterKeyResponse>(
		urls.KEY_URL,
		apiKey,
		client,
		"keys.current",
		undefined,
		{ signal, logger },
	);
	const isManagement = keyData.value.data.is_management_key === true;

	if (!isManagement) {
		return buildRegularUsageStats(keyData, logger);
	}

	logger.info("UsageService: management key detected, fetching all keys + credits");
	onProgress?.("Fetching all API keys…");
	const [keysResult, creditsResult] = await Promise.all([
		fetchKeysList(apiKey, client, urls, signal, logger),
		fetchAccountCredits(apiKey, client, urls, signal, logger),
	]);
	collectEndpointResults([keysResult, creditsResult], successfulEndpoints, endpointDiagnostics);
	const allKeys = keysResult.data;
	const accountCredits = creditsResult.data;
	const dailyUsageHistory = null;
	const capabilities = createManagementCapabilities(
		allKeys,
		accountCredits,
		dailyUsageHistory,
		keysResult.diagnostic,
		creditsResult.diagnostic,
	);

	const { targetKey, resolvedHash } = resolveTargetKey(
		keyData.value.data,
		allKeys,
		selectedKeyHash,
	);
	selectedKeyHash = resolvedHash;

	const stats = buildSingleKeyStats(targetKey, true);
	stats.contractHealth = {
		"keys.current": keyData.health,
		...(keysResult.health ? { "keys.list": keysResult.health } : {}),
		...(creditsResult.health ? { "credits.get": creditsResult.health } : {}),
	};
	stats.capabilities = capabilities;
	stats.allKeys = allKeys;
	stats.selectedKeyHash = selectedKeyHash ?? null;
	stats.accountCredits = accountCredits;
	stats.dailyUsageHistory = dailyUsageHistory;
	stats.capabilities.keyManagement = "available";
	stats.endpointDiagnostics = endpointDiagnostics;
	stats.refreshSummary = {
		successfulEndpoints,
		failedEndpoints: endpointDiagnostics.map((d) => d.endpoint),
	};
	logger.info("UsageService: refresh summary", stats.refreshSummary);
	return stats;
}

function collectEndpointResults(
	results: ReadonlyArray<{
		endpoint: string;
		data: unknown;
		diagnostic?: UsageEndpointDiagnostic;
	}>,
	successfulEndpoints: string[],
	endpointDiagnostics: UsageEndpointDiagnostic[],
): void {
	for (const result of results) {
		if (result.data !== null) successfulEndpoints.push(result.endpoint);
		else if (result.diagnostic) endpointDiagnostics.push(result.diagnostic);
	}
}

function buildRegularUsageStats(
	keyData: DecodedResponse<OpenRouterKeyResponse>,
	logger: ApiLogger,
): UsageStats {
	logger.info("UsageService: regular key, usage:", keyData.value.data.usage.toFixed(2));
	const stats = buildSingleKeyStats(keyData.value.data, false);
	stats.contractHealth = { "keys.current": keyData.health };
	stats.endpointDiagnostics = [];
	stats.refreshSummary = { successfulEndpoints: ["keys.current"], failedEndpoints: [] };
	return stats;
}

function endpointDiagnostic(endpoint: string, error: unknown): UsageEndpointDiagnostic {
	const classified = classifyError(error);
	return {
		endpoint,
		errorClass: classified.errorClass ?? "client",
		status: classified.code,
		timestamp: new Date().toISOString(),
	};
}

/** Fetch the keys list (management only). Returns null when the call fails. */
async function fetchKeysList(
	apiKey: string,
	client: HttpClient,
	urls: ReturnType<typeof getUrls>,
	signal?: AbortSignal,
	logger: ApiLogger = noopApiLogger,
): Promise<{
	endpoint: "keys.list";
	data: KeyUsage[] | null;
	health?: ContractHealth;
	diagnostic?: UsageEndpointDiagnostic;
}> {
	try {
		const keysRes = await fetchJson<OpenRouterKeysResponse>(
			urls.KEYS_URL,
			apiKey,
			client,
			"keys.list",
			undefined,
			{ signal, logger },
		);
		const keys = (keysRes.value.data ?? []).map(toKeyUsage);
		logger.info("UsageService: fetched", keys.length, "API keys");
		return { endpoint: "keys.list", data: keys, health: keysRes.health };
	} catch (err) {
		if (signal?.aborted) throw err;
		logger.warn(
			"UsageService: keys list fetch failed, continuing without:",
			classifyError(err).message,
		);
		return {
			endpoint: "keys.list",
			data: null,
			health: failedContractHealth("keys.list", err),
			diagnostic: endpointDiagnostic("keys.list", err),
		};
	}
}

function createManagementCapabilities(
	keys: KeyUsage[] | null,
	credits: AccountCredits | null,
	activity: DailyUsagePoint[] | null,
	keyFailure?: UsageEndpointDiagnostic,
	creditsFailure?: UsageEndpointDiagnostic,
	activityFailure?: UsageEndpointDiagnostic,
): UsageCapabilities {
	const statusFor = (value: unknown, failure?: UsageEndpointDiagnostic) => {
		if (value !== null) return "available" as const;
		return failure?.status === 401 || failure?.status === 403
			? ("permissionDenied" as const)
			: ("unavailable" as const);
	};
	return {
		keys: statusFor(keys, keyFailure),
		credits: statusFor(credits, creditsFailure),
		activity: statusFor(activity, activityFailure),
		perKeyActivity: statusFor(keys, keyFailure),
		analytics: "available",
		keyManagement: "available",
	};
}

/** Fetch account credits (management only). Returns null when the call fails. */
async function fetchAccountCredits(
	apiKey: string,
	client: HttpClient,
	urls: ReturnType<typeof getUrls>,
	signal?: AbortSignal,
	logger: ApiLogger = noopApiLogger,
): Promise<{
	endpoint: "credits.get";
	data: AccountCredits | null;
	health?: ContractHealth;
	diagnostic?: UsageEndpointDiagnostic;
}> {
	try {
		const creditsRes = await fetchJson<OpenRouterCreditsResponse>(
			urls.CREDITS_URL,
			apiKey,
			client,
			"credits.get",
			undefined,
			{ signal, logger },
		);
		const credits = toAccountCredits(creditsRes.value.data);
		logger.info("UsageService: fetched account credits:", credits.remaining.toFixed(2));
		return { endpoint: "credits.get", data: credits, health: creditsRes.health };
	} catch (err) {
		if (signal?.aborted) throw err;
		logger.warn(
			"UsageService: credits fetch failed, continuing without:",
			classifyError(err).message,
		);
		return {
			endpoint: "credits.get",
			data: null,
			health: failedContractHealth("credits.get", err),
			diagnostic: endpointDiagnostic("credits.get", err),
		};
	}
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

/**
 * Resolve which key's usage to project for the dashboard.
 * Returns the target key data and the resolved selected hash.
 */
function resolveTargetKey(
	keyData: OpenRouterKeyResponse["data"],
	allKeys: KeyUsage[] | null,
	selectedKeyHash: string | undefined,
): { targetKey: OpenRouterKeyResponse["data"]; resolvedHash: string | undefined } {
	if (selectedKeyHash && allKeys) {
		const match = allKeys.find((k) => k.hash === selectedKeyHash);
		if (match) {
			return {
				targetKey: projectKeyUsage(match, keyData),
				resolvedHash: selectedKeyHash,
			};
		}
	}
	if (allKeys && allKeys.length > 0) {
		const firstActive = allKeys.find((k) => !k.disabled) ?? allKeys[0];
		return {
			targetKey: projectKeyUsage(firstActive, keyData),
			resolvedHash: firstActive.hash,
		};
	}
	return { targetKey: keyData, resolvedHash: undefined };
}

/** Project a KeyUsage entry onto the key-response shape used by builders. */
function projectKeyUsage(
	k: KeyUsage,
	keyData: OpenRouterKeyResponse["data"],
): OpenRouterKeyResponse["data"] {
	return {
		label: k.label,
		usage: k.totalUsed,
		usage_daily: k.dailyUsage,
		usage_weekly: k.weeklyUsage,
		usage_monthly: k.monthlyUsage,
		limit: k.limit,
		limit_remaining: k.limitRemaining,
		limit_reset: k.limitReset,
		is_free_tier: keyData.is_free_tier,
		is_management_key: true,
	};
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

// ── Builders ───────────────────────────────────────────────────

function buildSingleKeyStats(d: OpenRouterKeyResponse["data"], isManagement: boolean): UsageStats {
	const pct = calculateUsagePercent(d.limit, d.limit_remaining, d.usage);

	return {
		mode: isManagement ? "management" : "regular",
		isManagementKey: isManagement,
		capabilities: isManagement
			? {
					keys: "unavailable",
					credits: "unavailable",
					activity: "unavailable",
					perKeyActivity: "unavailable",
					analytics: "unavailable",
					keyManagement: "unavailable",
				}
			: {
					keys: "notApplicable",
					credits: "notApplicable",
					activity: "notApplicable",
					perKeyActivity: "notApplicable",
					analytics: "notApplicable",
					keyManagement: "notApplicable",
				},
		totalUsed: d.usage,
		dailyUsage: d.usage_daily,
		weeklyUsage: d.usage_weekly,
		monthlyUsage: d.usage_monthly,
		limit: d.limit,
		limitRemaining: d.limit_remaining,
		limitReset: d.limit_reset,
		isFreeTier: d.is_free_tier,
		usagePercent: pct,
		allKeys: null,
		selectedKeyHash: null,
		accountCredits: null,
		fetchedAt: new Date().toISOString(),
		dailyUsageHistory: null,
		perKeyActivityHistory: null,
		analytics: null,
		analyticsUnavailableReason: isManagement ? undefined : "managementKeyRequired",
		detailState: isManagement ? { status: "notLoaded" } : undefined,
		endpointDiagnostics: [],
		refreshSummary: { successfulEndpoints: [], failedEndpoints: [] },
	};
}

function toKeyUsage(k: {
	hash: string;
	name?: string;
	label: string;
	disabled: boolean;
	usage: number;
	usage_daily: number;
	usage_weekly: number;
	usage_monthly: number;
	limit: number | null;
	limit_remaining: number | null;
	limit_reset: string | null;
}): KeyUsage {
	const pct = calculateUsagePercent(k.limit, k.limit_remaining, k.usage);
	return {
		hash: k.hash,
		name: k.name ?? "",
		label: k.label,
		disabled: k.disabled,
		totalUsed: k.usage,
		dailyUsage: k.usage_daily,
		weeklyUsage: k.usage_weekly,
		monthlyUsage: k.usage_monthly,
		limit: k.limit,
		limitRemaining: k.limit_remaining,
		limitReset: k.limit_reset,
		usagePercent: pct,
	};
}

/**
 * Calculate the percentage for the currently active limit window.
 *
 * `usage` is all-time usage, while `limit_remaining` is reset with the
 * configured limit interval. Using the former makes a key appear over its
 * limit immediately after a daily/weekly/monthly reset. The API's remaining
 * value is the authoritative current-window value, so prefer it whenever it
 * is available.
 */
function calculateUsagePercent(
	limit: number | null,
	limitRemaining: number | null,
	usage: number,
): number | null {
	if (limit === null || limit <= 0) return null;
	if (limitRemaining !== null) {
		return Math.max(0, ((limit - limitRemaining) / limit) * 100);
	}
	return (usage / limit) * 100;
}

function toAccountCredits(d: { total_credits: number; total_usage: number }): AccountCredits {
	const remaining = d.total_credits - d.total_usage;
	const pct = d.total_credits > 0 ? (d.total_usage / d.total_credits) * 100 : 0;
	return {
		totalCredits: d.total_credits,
		totalUsage: d.total_usage,
		remaining: Math.max(0, remaining),
		usagePercent: pct,
	};
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
		// Today is already present (unusual, but handle it).
		last.usage = Math.max(last.usage, dailyUsage);
	} else {
		points.push({ date: today, usage: dailyUsage, requests: 0 });
	}
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

interface PerKeyActivityResult {
	data: Record<string, DailyUsagePoint[]> | null;
	diagnostics: UsageEndpointDiagnostic[];
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

// ── Key management API ─────────────────────────────────────────

/**
 * Create a new API key. Requires a management key.
 * @param apiKey  The management API key.
 * @param req     Key creation parameters (name, optional limit, etc.).
 * @returns       Result with the new key string (only shown once).
 */
export async function createApiKey(
	apiKey: string,
	req: CreateKeyRequest,
	client: HttpClient = defaultHttpClient,
	baseUrl: string = DEFAULT_BASE_URL,
): Promise<KeyManagementResult> {
	if (!apiKey.trim()) throw new Error("Management API key cannot be empty");
	validateKeyRequest(req);
	const url = buildEndpointUrl(baseUrl, "keys.create");
	noopApiLogger.debug(`UsageService: POST ${redactUrl(url)} (create key: ${req.name})`);
	const res = await fetchJson<CreateKeyResponse>(url, apiKey, client, "keys.create", {
		name: req.name,
		limit: req.limit,
		limit_reset: req.limit_reset,
		include_byok_in_limit: req.include_byok_in_limit,
		days_until_expiration: req.days_until_expiration,
	});
	return {
		action: "created",
		keyLabel: res.value.data.name || res.value.data.label,
		newKey: res.value.data.key,
		hash: res.value.data.hash,
	};
}

/**
 * Update an API key (rename, enable/disable, change limit). Requires a management key.
 * @param apiKey  The management API key.
 * @param hash    The hash identifier of the key to update.
 * @param req     Fields to update.
 */
export async function updateApiKey(
	apiKey: string,
	hash: string,
	req: UpdateKeyRequest,
	client: HttpClient = defaultHttpClient,
	baseUrl: string = DEFAULT_BASE_URL,
): Promise<KeyManagementResult> {
	if (!apiKey.trim()) throw new Error("Management API key cannot be empty");
	validateKeyHash(hash);
	validateKeyRequest(req);
	const url = buildEndpointUrl(baseUrl, "keys.update", { hash });
	noopApiLogger.debug(`UsageService: PATCH ${redactUrl(url)} (update key)`);
	const res = await fetchJson<UpdateKeyResponse>(url, apiKey, client, "keys.update", {
		name: req.name,
		disabled: req.disabled,
		limit: req.limit,
		limit_reset: req.limit_reset,
		include_byok_in_limit: req.include_byok_in_limit,
	});
	const action = req.disabled !== undefined ? "toggled" : "updated";
	return {
		action,
		keyLabel: res.value.data.name || res.value.data.label,
		hash: res.value.data.hash,
	};
}

/**
 * Delete an API key. Requires a management key.
 * @param apiKey  The management API key.
 * @param hash    The hash identifier of the key to delete.
 */
export async function deleteApiKey(
	apiKey: string,
	hash: string,
	client: HttpClient = defaultHttpClient,
	baseUrl: string = DEFAULT_BASE_URL,
): Promise<KeyManagementResult> {
	if (!apiKey.trim()) throw new Error("Management API key cannot be empty");
	validateKeyHash(hash);
	const url = buildEndpointUrl(baseUrl, "keys.delete", { hash });
	noopApiLogger.debug(`UsageService: DELETE ${redactUrl(url)} (delete key)`);
	await fetchJson<DeleteKeyResponse>(url, apiKey, client, "keys.delete");
	return {
		action: "deleted",
		keyLabel: hash.slice(0, 12) + "...",
		hash,
	};
}
