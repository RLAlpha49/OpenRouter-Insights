/**
 * Usage key-management client — the management-key operations for creating,
 * updating, and deleting OpenRouter API keys. Isolated from usage acquisition
 * and detail loading so key administration can evolve independently.
 *
 * @see https://openrouter.ai/docs/api/api-reference
 */

import type {
	CreateKeyRequest,
	CreateKeyResponse,
	UpdateKeyRequest,
	UpdateKeyResponse,
	DeleteKeyResponse,
	KeyManagementResult,
} from "../../types-usage";
import type { HttpClient } from "../transport/httpClient";
import { defaultHttpClient } from "../transport/httpClient";
import { buildEndpointUrl } from "../endpoint/endpointCatalog";
import {
	fetchJson,
	DEFAULT_BASE_URL,
	validateKeyHash,
	validateKeyRequest,
	redactUrl,
} from "./usageTransport";

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
	fetchJson;
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
	await fetchJson<DeleteKeyResponse>(url, apiKey, client, "keys.delete");
	return {
		action: "deleted",
		keyLabel: hash.slice(0, 12) + "...",
		hash,
	};
}

// Re-export so callers and tests that referenced the old debug logging path
// keep working; the noop logger is used for redacted URL diagnostics.
export { redactUrl };
