// Canonical inventory of OpenRouter endpoints used by the extension.

import type { AnalyticsQueryRequest, CreateKeyRequest, UpdateKeyRequest } from "../../types-usage";
import { API_TIMEOUTS_MS } from "../transport/timeouts";

export type EndpointAuth = "none" | "apiKey" | "managementKey";

export type EndpointId =
	| "models.list"
	| "keys.current"
	| "keys.list"
	| "credits.get"
	| "activity.list"
	| "analytics.query"
	| "keys.create"
	| "keys.update"
	| "keys.delete";

export interface EndpointRequestMap {
	"models.list": undefined;
	"keys.current": undefined;
	"keys.list": undefined;
	"credits.get": undefined;
	"activity.list": undefined;
	"analytics.query": { start: string; end: string; limit: number };
	"keys.create": CreateKeyRequest;
	"keys.update": UpdateKeyRequest & { hash: string };
	"keys.delete": { hash: string };
}

export type EndpointDecoder =
	| "models"
	| "key"
	| "keys"
	| "credits"
	| "activity"
	| "analytics"
	| "endpoints"
	| "createKey"
	| "updateKey"
	| "deleteKey";

export interface EndpointRequestDescriptor {
	readonly method: "GET" | "POST" | "PATCH" | "DELETE";
	readonly path: string;
	readonly body?: object;
}

export interface OpenRouterEndpointContract {
	readonly id: EndpointId;
	readonly method: "GET" | "POST" | "PATCH" | "DELETE";
	readonly path: string;
	readonly auth: EndpointAuth;
	readonly decoder: EndpointDecoder;
	readonly retry: "none" | "transient";
	readonly timeoutMs: number;
	readonly docsUrl: string;
	readonly capability: "pricing" | "usage" | "management" | "analytics" | "metrics";
	readonly responseLimitBytes: number;
	readonly requestBuilder: (_input: unknown) => EndpointRequestDescriptor;
}

const DEFAULT_RESPONSE_LIMIT_BYTES = 10 * 1024 * 1024;

export const OPENROUTER_ENDPOINTS = [
	{
		id: "models.list",
		method: "GET",
		path: "/api/v1/models",
		auth: "none",
		decoder: "models",
		retry: "transient",
		timeoutMs: API_TIMEOUTS_MS.models,
		docsUrl: "https://openrouter.ai/docs/api-reference/models/list-models",
		capability: "pricing",
		responseLimitBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
		requestBuilder: () => buildNoBodyRequest("models.list"),
	},
	{
		id: "keys.current",
		method: "GET",
		path: "/api/v1/key",
		auth: "apiKey",
		decoder: "key",
		retry: "transient",
		timeoutMs: API_TIMEOUTS_MS.key,
		docsUrl: "https://openrouter.ai/docs/api-reference/overview#api-keys",
		capability: "usage",
		responseLimitBytes: 512 * 1024,
		requestBuilder: () => buildNoBodyRequest("keys.current"),
	},
	{
		id: "keys.list",
		method: "GET",
		path: "/api/v1/keys",
		auth: "managementKey",
		decoder: "keys",
		retry: "transient",
		timeoutMs: API_TIMEOUTS_MS.keys,
		docsUrl: "https://openrouter.ai/docs/api-reference/api-keys/list-api-keys",
		capability: "management",
		responseLimitBytes: 2 * 1024 * 1024,
		requestBuilder: () => buildNoBodyRequest("keys.list"),
	},
	{
		id: "credits.get",
		method: "GET",
		path: "/api/v1/credits",
		auth: "managementKey",
		decoder: "credits",
		retry: "transient",
		timeoutMs: API_TIMEOUTS_MS.credits,
		docsUrl: "https://openrouter.ai/docs/api-reference/credits/get-remaining-credits",
		capability: "management",
		responseLimitBytes: 512 * 1024,
		requestBuilder: () => buildNoBodyRequest("credits.get"),
	},
	{
		id: "activity.list",
		method: "GET",
		path: "/api/v1/activity",
		auth: "managementKey",
		decoder: "activity",
		retry: "transient",
		timeoutMs: API_TIMEOUTS_MS.activity,
		docsUrl: "https://openrouter.ai/docs/api-reference/activity/get-activity",
		capability: "usage",
		responseLimitBytes: 4 * 1024 * 1024,
		requestBuilder: () => buildNoBodyRequest("activity.list"),
	},
	{
		id: "analytics.query",
		method: "POST",
		path: "/api/v1/analytics/query",
		auth: "managementKey",
		decoder: "analytics",
		retry: "transient",
		timeoutMs: API_TIMEOUTS_MS.analytics,
		docsUrl: "https://openrouter.ai/docs/api-reference/analytics/query",
		capability: "analytics",
		responseLimitBytes: 4 * 1024 * 1024,
		requestBuilder: (input) =>
			buildAnalyticsRequest(input as EndpointRequestMap["analytics.query"]),
	},
	{
		id: "keys.create",
		method: "POST",
		path: "/api/v1/keys",
		auth: "managementKey",
		decoder: "createKey",
		retry: "transient",
		timeoutMs: API_TIMEOUTS_MS.keys,
		docsUrl: "https://openrouter.ai/docs/api-reference/api-keys/create-api-key",
		capability: "management",
		responseLimitBytes: 512 * 1024,
		requestBuilder: (input) => buildKeyManagementRequest("keys.create", input as CreateKeyRequest),
	},
	{
		id: "keys.update",
		method: "PATCH",
		path: "/api/v1/keys/{hash}",
		auth: "managementKey",
		decoder: "updateKey",
		retry: "transient",
		timeoutMs: API_TIMEOUTS_MS.keys,
		docsUrl: "https://openrouter.ai/docs/api-reference/api-keys/update-api-key",
		capability: "management",
		responseLimitBytes: 512 * 1024,
		requestBuilder: (input) =>
			buildKeyManagementRequest("keys.update", input as UpdateKeyRequest & { hash: string }),
	},
	{
		id: "keys.delete",
		method: "DELETE",
		path: "/api/v1/keys/{hash}",
		auth: "managementKey",
		decoder: "deleteKey",
		retry: "transient",
		timeoutMs: API_TIMEOUTS_MS.keys,
		docsUrl: "https://openrouter.ai/docs/api-reference/api-keys/delete-api-key",
		capability: "management",
		responseLimitBytes: 128 * 1024,
		requestBuilder: (input) => buildDeleteKeyRequest(input as { hash: string }),
	},
] as const satisfies readonly OpenRouterEndpointContract[];

/** Return the canonical runtime contract for an endpoint ID. */
export function getEndpointContract(id: EndpointId): OpenRouterEndpointContract {
	const endpoint = OPENROUTER_ENDPOINTS.find((candidate) => candidate.id === id);
	if (!endpoint) throw new Error(`Unknown OpenRouter endpoint: ${id}`);
	return endpoint;
}

/** Build the validated request descriptor associated with an endpoint ID. */
export function buildEndpointRequest<K extends EndpointId>(
	id: K,
	input: EndpointRequestMap[K] = undefined as EndpointRequestMap[K],
): EndpointRequestDescriptor {
	const endpoint = getEndpointContract(id);
	return endpoint.requestBuilder(input);
}

/** Retry budget a caller passes to `fetchWithRetry` for one endpoint. */
export interface EndpointRetryPolicy {
	readonly maxRetries: number;
	readonly baseDelayMs: number;
}

/** Attempt budget for endpoints that declare `retry: "transient"`. */
export const TRANSIENT_RETRY_POLICY: EndpointRetryPolicy = { maxRetries: 3, baseDelayMs: 1000 };

/** Single-attempt budget for endpoints that declare `retry: "none"`. */
export const NO_RETRY_POLICY: EndpointRetryPolicy = { maxRetries: 1, baseDelayMs: 0 };

/**
 * Resolve the runtime retry policy for an endpoint from its catalog contract.
 *
 * The catalog is the single source of truth for *whether* an endpoint may be
 * retried. A service may tighten or loosen the attempt budget of a `transient`
 * endpoint through `overrides`, but an endpoint declared `none` always resolves
 * to a single attempt so the declared contract cannot drift from the request.
 */
export function getEndpointRetryPolicy(
	id: EndpointId,
	overrides: Partial<EndpointRetryPolicy> = {},
): EndpointRetryPolicy {
	const endpoint = getEndpointContract(id);
	if (endpoint.retry === "none") return NO_RETRY_POLICY;
	return {
		maxRetries: Math.max(1, Math.trunc(overrides.maxRetries ?? TRANSIENT_RETRY_POLICY.maxRetries)),
		baseDelayMs: Math.max(0, overrides.baseDelayMs ?? TRANSIENT_RETRY_POLICY.baseDelayMs),
	};
}

/**
 * Build an endpoint URL from an API origin or an existing /models URL.
 * Template parameters are encoded one at a time so slashes cannot alter paths.
 */
export function buildEndpointUrl(
	baseUrl: string,
	id: EndpointId,
	params: Readonly<Record<string, string | number>> = {},
): string {
	const endpoint = getEndpointContract(id);
	const base = new URL(baseUrl);
	let basePath = base.pathname;
	while (basePath.endsWith("/")) basePath = basePath.slice(0, -1);
	if (basePath.endsWith("/models")) basePath = basePath.slice(0, -"/models".length);

	const endpointPath = basePath.endsWith("/api/v1")
		? endpoint.path.replace(/^\/api\/v1/, "")
		: endpoint.path;
	let path = endpointPath;
	let openBrace = path.indexOf("{");
	while (openBrace >= 0) {
		const closeBrace = path.indexOf("}", openBrace + 1);
		if (closeBrace < 0) throw new Error(`Invalid path template for ${id}`);
		const name = path.slice(openBrace + 1, closeBrace);
		const value = params[name];
		if (value === undefined) throw new Error(`Missing path parameter "${name}" for ${id}`);
		path = `${path.slice(0, openBrace)}${encodeURIComponent(String(value))}${path.slice(closeBrace + 1)}`;
		openBrace = path.indexOf("{", openBrace + 1);
	}
	base.pathname = `${basePath}${path}` || "/";
	base.search = "";
	return base.href;
}

function validateKeyHash(hash: string): void {
	if (!/^[A-Za-z0-9_-]{3,256}$/.test(hash)) throw new Error("Invalid API key hash");
}

function validateKeyBody(body: CreateKeyRequest | UpdateKeyRequest): Record<string, unknown> {
	if ("name" in body && body.name !== undefined && (!body.name.trim() || body.name.length > 256)) {
		throw new Error("API key name must be between 1 and 256 characters");
	}
	if (body.limit !== undefined && (!Number.isFinite(body.limit) || body.limit < 0)) {
		throw new Error("API key limit must be a finite non-negative number");
	}
	const expiration = "days_until_expiration" in body ? body.days_until_expiration : undefined;
	if (
		expiration !== undefined &&
		(!Number.isInteger(expiration) || expiration < 1 || expiration > 3650)
	) {
		throw new Error("API key expiration must be between 1 and 3650 days");
	}
	return { ...body };
}

export function buildAnalyticsRequest(input: {
	start: string;
	end: string;
	limit: number;
}): EndpointRequestDescriptor {
	if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
		throw new Error("Analytics limit must be an integer between 1 and 1000");
	}
	if (Number.isNaN(Date.parse(input.start)) || Number.isNaN(Date.parse(input.end))) {
		throw new TypeError("Analytics dates must be valid timestamps");
	}
	const body: AnalyticsQueryRequest = {
		dimensions: ["model"],
		time_range: { start: input.start, end: input.end },
		order_by: { field: "total_usage", direction: "desc" },
		limit: input.limit,
		metrics: [
			"total_usage",
			"request_count",
			"tokens_total",
			"tokens_prompt",
			"tokens_completion",
			"cache_hit_rate",
		],
	};
	return { method: "POST", path: getEndpointContract("analytics.query").path, body };
}

function buildNoBodyRequest(
	id: Exclude<EndpointId, "analytics.query" | "keys.create" | "keys.update" | "keys.delete">,
): EndpointRequestDescriptor {
	const endpoint = getEndpointContract(id);
	return { method: endpoint.method, path: endpoint.path };
}

export function buildKeyManagementRequest(
	id: "keys.create" | "keys.update",
	input: (CreateKeyRequest | UpdateKeyRequest) & { hash?: string },
): EndpointRequestDescriptor {
	if (id === "keys.update") {
		if (!input.hash) throw new Error("Missing API key hash");
		validateKeyHash(input.hash);
	}
	const body = { ...input };
	delete body.hash;
	return {
		method: getEndpointContract(id).method,
		path: getEndpointContract(id).path,
		body: validateKeyBody(body),
	};
}

function buildDeleteKeyRequest(input: { hash: string }): EndpointRequestDescriptor {
	validateKeyHash(input.hash);
	const endpoint = getEndpointContract("keys.delete");
	return {
		method: endpoint.method,
		path: endpoint.path,
	};
}

export function buildModelMetricsQuery(_model: string): string {
	return "?max_results=100";
}
