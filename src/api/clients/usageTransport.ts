/**
 * Usage transport primitives shared by the usage, key-management, and
 * detail-loading clients. Keeps one authenticated request path, one URL
 * builder, and one set of response-diagnostic helpers so the three usage
 * boundaries stay consistent without duplicating transport logic.
 *
 * @see https://openrouter.ai/docs/api/api-reference
 */

import type {
	UsageEndpointDiagnostic,
	CreateKeyRequest,
	UpdateKeyRequest,
} from "../../types-usage";
import type { ApiLogger } from "../logger";
import { noopApiLogger } from "../logger";
import { type HttpClient } from "../transport/httpClient";
import { classifyError } from "../transport/fetchHelpers";
import { OpenRouterHttpError } from "../transport/openRouterError";
import { redactUrl } from "../redaction";
import { buildEndpointUrl } from "../endpoint/endpointCatalog";
import { EndpointClient } from "../transport/endpointClient";
import type { DecodedResponse } from "../contractDecoders";
import type { ContractHealth } from "../../types";
import type { EndpointId } from "../endpoint/endpointCatalog";

/** Callback type for progress updates during fetch operations. */
export type ProgressCallback = (_message: string) => void;

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function getUrls(baseUrl: string = DEFAULT_BASE_URL) {
	return {
		BASE_URL: baseUrl,
		KEY_URL: buildEndpointUrl(baseUrl, "keys.current"),
		KEYS_URL: buildEndpointUrl(baseUrl, "keys.list"),
		CREDITS_URL: buildEndpointUrl(baseUrl, "credits.get"),
		ACTIVITY_URL: buildEndpointUrl(baseUrl, "activity.list"),
	};
}

const TRUSTED_USAGE_ORIGIN = "https://openrouter.ai";

export function validateKeyHash(hash: string): void {
	if (!/^[A-Za-z0-9_-]{3,256}$/.test(hash)) throw new Error("Invalid API key hash");
}

export function validateKeyRequest(req: CreateKeyRequest | UpdateKeyRequest): void {
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

export function trustedUsageBaseUrl(_baseUrl: string): string {
	try {
		return `${TRUSTED_USAGE_ORIGIN}/api/v1`;
	} catch {
		return `${TRUSTED_USAGE_ORIGIN}/api/v1`;
	}
}

export function failedContractHealth(endpointId: EndpointId, error: unknown): ContractHealth {
	const classified = classifyError(error);
	return {
		status: "partial",
		issueCount: 1,
		issues: [{ path: endpointId, message: `Request unavailable (${classified.kind})` }],
	};
}

export function endpointDiagnostic(endpoint: string, error: unknown): UsageEndpointDiagnostic {
	const classified = classifyError(error);
	return {
		endpoint,
		errorClass: classified.errorClass ?? "client",
		status: classified.code,
		timestamp: new Date().toISOString(),
	};
}

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

export async function fetchJson<T>(
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

export { redactUrl };
