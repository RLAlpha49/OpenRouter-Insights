/**
 * UsageService — baseline usage acquisition and aggregation client.
 *
 * Regular API key:   GET /api/v1/key → single-key usage
 * Management key:    GET /api/v1/key → detect management mode
 *                    GET /api/v1/keys → list all keys with per-key usage
 *                    GET /api/v1/credits → account-level totals
 *
 * Detail fan-out (activity, per-key activity, analytics) lives in
 * `usageDetailsService.ts` and key management (create/update/delete) lives in
 * `usageKeyManagement.ts`. This module owns credential-scoped baseline
 * acquisition, capability projection, and aggregation.
 *
 * @see https://openrouter.ai/docs/api/api-reference
 */

import type {
	OpenRouterKeyResponse,
	OpenRouterKeysResponse,
	OpenRouterCreditsResponse,
	UsageStats,
	KeyUsage,
	DailyUsagePoint,
	AccountCredits,
	UsageCapabilities,
	UsageEndpointDiagnostic,
} from "../../types-usage";
import type { ApiLogger } from "../logger";
import { noopApiLogger } from "../logger";
import type { HttpClient } from "../transport/httpClient";
import { defaultHttpClient } from "../transport/httpClient";
import { classifyError } from "../transport/fetchHelpers";
import { OpenRouterHttpError } from "../transport/openRouterError";
import type { DecodedResponse } from "../contractDecoders";
import {
	fetchJson,
	getUrls,
	trustedUsageBaseUrl,
	DEFAULT_BASE_URL,
	failedContractHealth,
	endpointDiagnostic,
	UsageTransportError,
	type ProgressCallback,
} from "./usageTransport";

/** Callback type for progress updates during fetch operations. */
export type { ProgressCallback };

// Re-export the split usage boundaries so existing call sites and tests keep
// importing from the original `usageService` module.
export { fetchUsageDetails } from "./usageDetailsService";
export { createApiKey, updateApiKey, deleteApiKey } from "./usageKeyManagement";
export { UsageTransportError };

/** Fetch usage stats. Automatically detects management keys and fetches
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
	health?: DecodedResponse<OpenRouterKeysResponse>["health"];
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
	activity: DailyUsagePoint | null,
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
	health?: DecodedResponse<OpenRouterCreditsResponse>["health"];
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

/** Resolve which key's usage to project for the dashboard.
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
