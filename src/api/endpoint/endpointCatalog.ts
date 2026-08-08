// Canonical inventory of OpenRouter endpoints used by the extension.

import { API_TIMEOUTS_MS } from "../transport/timeouts";

export type EndpointAuth = "none" | "apiKey" | "managementKey";

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

export interface OpenRouterEndpointContract {
	readonly id: string;
	readonly method: "GET" | "POST" | "PATCH" | "DELETE";
	readonly path: string;
	readonly auth: EndpointAuth;
	readonly decoder: EndpointDecoder;
	readonly retry: "none" | "transient";
	readonly timeoutMs: number;
	readonly docsUrl: string;
	readonly capability: "pricing" | "usage" | "management" | "analytics" | "metrics";
}

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
	},
] as const satisfies readonly OpenRouterEndpointContract[];

export type EndpointId = (typeof OPENROUTER_ENDPOINTS)[number]["id"];

/** Return the canonical runtime contract for an endpoint ID. */
export function getEndpointContract(id: EndpointId): OpenRouterEndpointContract {
	const endpoint = OPENROUTER_ENDPOINTS.find((candidate) => candidate.id === id);
	if (!endpoint) throw new Error(`Unknown OpenRouter endpoint: ${id}`);
	return endpoint;
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
