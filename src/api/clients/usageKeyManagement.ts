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
	KeyManagementResult,
} from "../../types-usage";
import type { HttpClient } from "../transport/httpClient";
import { defaultHttpClient } from "../transport/httpClient";
import { buildEndpointUrl } from "../endpoint/endpointCatalog";
import { EndpointClient } from "../transport/endpointClient";
import { DEFAULT_BASE_URL } from "./usageTransport";

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
	const url = buildEndpointUrl(baseUrl, "keys.create");
	const endpointClient = new EndpointClient(client, {
		apiKeyProvider: async () => apiKey,
		managementKeyProvider: async () => apiKey,
	});
	const res = await endpointClient.request("keys.create", {
		url,
		input: req,
	});
	if (!res) throw new Error("Key creation endpoint returned 304 without a cached response");
	const data = res.value as CreateKeyResponse;
	return {
		action: "created",
		keyLabel: data.data.name || data.data.label,
		newKey: data.data.key,
		hash: data.data.hash,
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
	const url = buildEndpointUrl(baseUrl, "keys.update", { hash });
	const endpointClient = new EndpointClient(client, {
		apiKeyProvider: async () => apiKey,
		managementKeyProvider: async () => apiKey,
	});
	const res = await endpointClient.request("keys.update", {
		url,
		input: { ...req, hash },
	});
	if (!res) throw new Error("Key update endpoint returned 304 without a cached response");
	const data = res.value as UpdateKeyResponse;
	const action = req.disabled !== undefined ? "toggled" : "updated";
	return {
		action,
		keyLabel: data.data.name || data.data.label,
		hash: data.data.hash,
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
	const url = buildEndpointUrl(baseUrl, "keys.delete", { hash });
	const endpointClient = new EndpointClient(client, {
		apiKeyProvider: async () => apiKey,
		managementKeyProvider: async () => apiKey,
	});
	await endpointClient.request("keys.delete", { url, input: { hash } });
	return {
		action: "deleted",
		keyLabel: hash.slice(0, 12) + "...",
		hash,
	};
}
