/**
 * OpenRouter account usage types.
 * @see https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key
 * @see https://openrouter.ai/docs/api/api-reference/api-keys/list-api-keys
 * @see https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits
 */

import type { ContractHealth } from "./types";

// ── GET /api/v1/key ───────────────────────────────────────────

/** Response from GET /api/v1/key */
export interface OpenRouterKeyResponse {
	data: {
		label: string;
		usage: number;
		usage_daily: number;
		usage_weekly: number;
		usage_monthly: number;
		limit: number | null;
		limit_remaining: number | null;
		limit_reset: string | null;
		is_free_tier: boolean;
		/** Whether this is a management key. */
		is_management_key?: boolean;
	};
}

// ── GET /api/v1/keys (management only) ────────────────────────

/** A single key entry from the GET /keys response. */
export interface ApiKeyEntry {
	/** Hashed identifier for the key. */
	hash: string;
	/** User-assigned name (may be empty). */
	name: string;
	/** Masked label, e.g. "sk-or-v1-abc...xyz". */
	label: string;
	/** Whether the key is disabled. */
	disabled: boolean;
	/** Total usage all-time (USD). */
	usage: number;
	/** Usage in the current UTC day. */
	usage_daily: number;
	/** Usage in the current UTC week. */
	usage_weekly: number;
	/** Usage in the current UTC month. */
	usage_monthly: number;
	/** Credit limit, or null if unlimited. */
	limit: number | null;
	/** Remaining credits under the limit. */
	limit_remaining: number | null;
	/** Reset interval ("monthly", etc.) or null. */
	limit_reset: string | null;
	/** ISO 8601 created-at timestamp. */
	created_at: string;
	/** ISO 8601 updated-at timestamp. */
	updated_at: string;
}

/** Response from GET /api/v1/keys */
export interface OpenRouterKeysResponse {
	data: ApiKeyEntry[];
}

// ── GET /api/v1/credits (management only) ─────────────────────

/** Response from GET /api/v1/credits */
export interface OpenRouterCreditsResponse {
	data: {
		/** Total credits purchased (USD). */
		total_credits: number;
		/** Total credits used across all keys (USD). */
		total_usage: number;
	};
}

// ── Unified types ──────────────────────────────────────────────

/** Whether the current key is a regular API key or a management key. */
export type UsageMode = "regular" | "management";

/** Availability of an endpoint-backed usage capability. */
export type CapabilityStatus = "available" | "permissionDenied" | "unavailable" | "notApplicable";

/** Endpoint capabilities exposed by the current API key. */
export interface UsageCapabilities {
	keys: CapabilityStatus;
	credits: CapabilityStatus;
	activity: CapabilityStatus;
	perKeyActivity: CapabilityStatus;
	analytics: CapabilityStatus;
	keyManagement: CapabilityStatus;
}

/** Sanitized failure metadata for an optional usage endpoint. */
export interface UsageEndpointDiagnostic {
	endpoint: string;
	errorClass: string;
	status: number;
	timestamp: string;
	/** Sanitized resource identifier, such as a key hash, when applicable. */
	resourceId?: string;
	/** Short, sanitized failure detail safe for the dashboard. */
	detail?: string;
}

export type UsageDetailStatus = "notLoaded" | "loading" | "fresh" | "stale" | "unavailable";

export interface UsageDetailState {
	status: UsageDetailStatus;
	lastAttemptAt?: string;
	lastSuccessAt?: string;
	failedSections?: string[];
}

/** Structured summary of the endpoints attempted during a usage refresh. */
export interface UsageRefreshSummary {
	successfulEndpoints: string[];
	failedEndpoints: string[];
}

/** Per-key usage (normalised). */
export interface KeyUsage {
	hash: string;
	name: string;
	label: string;
	disabled: boolean;
	totalUsed: number;
	dailyUsage: number;
	weeklyUsage: number;
	monthlyUsage: number;
	limit: number | null;
	limitRemaining: number | null;
	limitReset: string | null;
	usagePercent: number | null;
}

/** Normalised usage statistics for the active key or selected key. */
export interface UsageStats {
	/** Which mode we're in. */
	mode: UsageMode;
	/** Whether the key is a management key. */
	isManagementKey?: boolean;
	/** Availability of management-key endpoints used by the dashboard. */
	capabilities: UsageCapabilities;

	// ── per-key usage (always present) ──────────────────────
	totalUsed: number;
	dailyUsage: number;
	weeklyUsage: number;
	monthlyUsage: number;
	limit: number | null;
	limitRemaining: number | null;
	limitReset: string | null;
	isFreeTier: boolean;
	usagePercent: number | null;

	// ── management-only fields ──────────────────────────────
	/** All API keys under this account (only with management key). */
	allKeys: KeyUsage[] | null;
	/** Hash of the currently selected key (only with management key). */
	selectedKeyHash: string | null;
	/** Account-level credits summary (only with management key). */
	accountCredits: AccountCredits | null;

	/** ISO timestamp of when the data was fetched. */
	fetchedAt: string;

	// ── activity data (management only) ─────────────────────
	/** Daily usage points for the history chart — account-wide (last 30 days). */
	dailyUsageHistory?: DailyUsagePoint[] | null;
	/** Per-key daily usage history, keyed by key hash. Only for management keys. */
	perKeyActivityHistory?: Record<string, DailyUsagePoint[]> | null;
	/** Optional per-model analytics for the dashboard. */
	analytics?: AnalyticsResult | null;
	/** Why analytics is unavailable, when it could not be loaded. */
	analyticsUnavailableReason?: "managementKeyRequired" | "unavailable" | "disabled";
	/** Contract health keyed by the endpoint ID that supplied each value. */
	contractHealth?: Record<string, ContractHealth>;
	/** Sanitized diagnostics for optional endpoint failures. */
	endpointDiagnostics?: UsageEndpointDiagnostic[];
	/** Structured endpoint outcome summary for observability. */
	refreshSummary?: UsageRefreshSummary;
	/** Freshness and failure state for optional activity/analytics sections. */
	detailState?: UsageDetailState;
}

/**
 * Validate a usage `fetchedAt` timestamp.
 *
 * Returns true only when the value is a string that parses to a finite,
 * non-NaN date. Usage snapshots with an invalid timestamp must fail closed
 * as stale instead of suppressing refreshes with a NaN age.
 */
export function isValidUsageFetchedAt(fetchedAt: string): boolean {
	if (typeof fetchedAt !== "string") return false;
	const time = new Date(fetchedAt).getTime();
	return !Number.isNaN(time);
}

/** Options for an intentional detailed management-usage request. */
export interface UsageDetailsOptions {
	lookbackDays?: number;
	includeAnalytics?: boolean;
	/** Already-published baseline to enrich without fetching it again. */
	baseline?: UsageStats;
}

/** Account-level credits summary (management key only). */
export interface AccountCredits {
	totalCredits: number;
	totalUsage: number;
	remaining: number;
	usagePercent: number;
}

// ── GET /api/v1/activity (management only) ───────────────────

/** A single activity entry from the /activity endpoint. */
export interface ActivityEntry {
	/** ISO date string (e.g. "2025-08-24"). */ date: string;
	/** Model ID (e.g. "openai/gpt-4.1"). */
	model?: string;
	/** Model permaslug. */
	model_permaslug?: string;
	/** Provider name. */
	provider_name?: string;
	/** Endpoint UUID. */
	endpoint_id?: string;
	/** USD cost. */
	usage: number;
	/** BYOK inference cost portion. */
	byok_usage_inference?: number;
	/** Number of requests. */
	requests: number;
	/** Prompt tokens. */
	prompt_tokens?: number;
	/** Completion tokens. */
	completion_tokens?: number;
	/** Reasoning tokens. */
	reasoning_tokens?: number;
}

/** Response from GET /api/v1/activity */
export interface OpenRouterActivityResponse {
	data: ActivityEntry[];
}

/** Aggregated daily usage for chart display. */
export interface DailyUsagePoint {
	date: string;
	usage: number;
	requests: number;
}

// ── Key management (management key only) ────────────────────────

/** Request body for POST /api/v1/keys — create a new API key. */
export interface CreateKeyRequest {
	name: string;
	/** Optional credit limit in USD. */
	limit?: number;
	/** Optional limit reset interval. */
	limit_reset?: LimitResetInterval;
	/** Optional: whether BYOK usage counts toward the limit. */
	include_byok_in_limit?: boolean;
	/** Optional: number of days until the key expires. */
	days_until_expiration?: number;
}

/** Request body for PATCH /api/v1/keys/{hash} — update an API key. */
export interface UpdateKeyRequest {
	/** New human-readable name. */
	name?: string;
	/** Set to true to disable the key, false to re-enable. */
	disabled?: boolean;
	/** New credit limit. */
	limit?: number;
	/** Reset interval for the credit limit. */
	limit_reset?: LimitResetInterval;
	/** Whether BYOK usage counts toward the limit. */
	include_byok_in_limit?: boolean;
}

/** Valid limit reset intervals. */
export type LimitResetInterval = "daily" | "weekly" | "monthly" | "yearly";

/** Response from POST /api/v1/keys — create an API key. */
export interface CreateKeyResponse {
	data: {
		key: string;
		hash: string;
		name: string;
		label: string;
		disabled: boolean;
		limit: number | null;
		limit_remaining: number | null;
		limit_reset: string | null;
		created_at: string;
	};
}

/** Response from PATCH /api/v1/keys/{hash} — update an API key. */
export interface UpdateKeyResponse {
	data: {
		hash: string;
		name: string;
		label: string;
		disabled: boolean;
		limit: number | null;
		limit_remaining: number | null;
		limit_reset: string | null;
		updated_at: string;
	};
}

/** Response from DELETE /api/v1/keys/{hash}. */
export interface DeleteKeyResponse {
	data: { success: boolean };
}

/** Key management result exposed to UI — wraps API response for status display. */
export interface KeyManagementResult {
	/** `"created"` | `"updated"` | `"deleted"` | `"toggled"` */
	action: string;
	/** Human-readable name or label for the key. */
	keyLabel: string;
	/** The raw API key string (only present on create). */
	newKey?: string;
	/** Hash of the affected key. */
	hash: string;
}

// ── POST /api/v1/analytics/query ──────────────────────────────

/** Dimensions for the analytics query breakdown. */
export type AnalyticsDimension = "model" | "provider" | "endpoint" | "date";

/** Metrics to include in the analytics query. */
export type AnalyticsMetric =
	| "total_usage"
	| "request_count"
	| "tokens_total"
	| "tokens_prompt"
	| "tokens_completion"
	| "cache_hit_rate";

/** Analytics metrics may be returned as numbers or numeric strings. */
export type AnalyticsValue = number | string | null;

/** Request body for POST /api/v1/analytics/query. */
export interface AnalyticsQueryRequest {
	/** Current Analytics API dimension field. */
	dimensions?: AnalyticsDimension[];
	/** Current Analytics API time range. */
	time_range?: { start: string; end: string };
	/** Metrics to return. */
	metrics?: AnalyticsMetric[];
	order_by?: { field: string; direction: "asc" | "desc" };
	limit?: number;
	/** Optional model filter. */
	model?: string;
	/** Optional API key hash filter. */
	api_key_hash?: string;
}

/** A single row in the analytics query response. */
export interface AnalyticsDataPoint {
	date?: string;
	model?: string;
	provider?: string;
	endpoint_id?: string;
	total_usage?: AnalyticsValue;
	request_count?: AnalyticsValue;
	tokens_total?: AnalyticsValue;
	tokens_prompt?: AnalyticsValue;
	tokens_completion?: AnalyticsValue;
	cache_hit_rate?: AnalyticsValue;
}

/** Response from POST /api/v1/analytics/query. */
export interface AnalyticsQueryResponse {
	data:
		| AnalyticsDataPoint[]
		| {
				data: AnalyticsDataPoint[];
				metadata?: { query_time_ms?: number; row_count?: number; truncated?: boolean };
		  };
}

/** Aggregated per-model spend breakdown. */
export interface ModelSpendBreakdown {
	modelId: string;
	totalUsage: number;
	requestCount: number;
	tokensTotal: number;
	promptTokens: number;
	completionTokens: number;
	cacheHitRate: number;
	percentage: number;
}

/** Full analytics query result for dashboard display. */
export interface AnalyticsResult {
	/** Total spend in the query period. */
	totalSpend: number;
	/** Total requests in the query period. */
	totalRequests: number;
	/** Per-model breakdown sorted by spend (descending). */
	modelBreakdown: ModelSpendBreakdown[];
	/** Cache hit rate (0-100). */
	overallCacheHitRate: number;
	/** Row budget requested from the Analytics API for this result. */
	rowLimit?: number;
	/** True when the account breakdown was capped by the requested row budget. */
	truncated?: boolean;
	/** Contract health for the analytics response. */
	contractHealth?: ContractHealth;
}
