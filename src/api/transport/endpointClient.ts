import {
	decodeEndpointResponse,
	decodeOrThrow,
	type DecodedResponse,
	type EndpointResponseMap,
} from "../contractDecoders";
import {
	buildEndpointUrl,
	getEndpointContract,
	getEndpointRetryPolicy,
	type EndpointId,
} from "../endpoint/endpointCatalog";
import { redactBodySnippet } from "../redaction";
import { createAbortController, fetchWithRetry } from "./fetchHelpers";
import type { HttpClient, HttpRequestInit } from "./httpClient";
import { fetchEndpoint, type EndpointCredentialProviders } from "./httpPipeline";
import { OpenRouterHttpError, parseOpenRouterErrorEnvelope } from "./openRouterError";

export interface EndpointRequestOptions {
	baseUrl?: string;
	url?: string;
	signal?: AbortSignal;
	allowNotModified?: boolean;
	retry?: { maxRetries: number; baseDelayMs: number };
	init?: Omit<HttpRequestInit, "method" | "endpointId" | "signal">;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export class EndpointClient {
	constructor(
		private readonly _http: HttpClient,
		private readonly _credentials: EndpointCredentialProviders,
	) {}

	async request<K extends EndpointId>(
		endpointId: K,
		options: EndpointRequestOptions = {},
	): Promise<DecodedResponse<EndpointResponseMap[K]> | undefined> {
		const endpoint = getEndpointContract(endpointId);
		const url = options.url ?? buildEndpointUrl(options.baseUrl ?? DEFAULT_BASE_URL, endpointId);
		const { controller, dispose } = createAbortController(endpoint.timeoutMs, options.signal);
		const policy = options.retry ?? getEndpointRetryPolicy(endpointId);

		try {
			return await fetchWithRetry(
				async () => {
					const init: HttpRequestInit = {
						...options.init,
						signal: controller.signal,
						endpointId,
						body: options.init?.body,
						headers: new Headers(options.init?.headers),
					};
					const headers = new Headers(init.headers);
					headers.set("Accept", "application/json");
					if (options.init?.body) headers.set("Content-Type", "application/json");
					init.headers = headers;
					let response: Response;
					try {
						response = await fetchEndpoint(this._http, url, endpointId, init, this._credentials);
					} catch (error) {
						if (error instanceof OpenRouterHttpError) throw error;
						throw new EndpointTransportError(endpointId, error);
					}
					const body = await readBoundedBody(response, endpoint.responseLimitBytes, endpointId);

					if (!response.ok && response.status !== 304) {
						const envelope = parseOpenRouterErrorEnvelope(body);
						throw new OpenRouterHttpError({
							label: endpointId,
							status: response.status,
							headers: response.headers,
							envelope,
							bodySnippet: redactBodySnippet(body),
						});
					}

					if (response.status === 304 && options.allowNotModified) return undefined;
					if (response.status === 204 || response.status === 304) {
						return {
							value: { data: { success: true } } as EndpointResponseMap[K],
							health: validHealth(),
						};
					}
					let parsed: unknown;
					try {
						parsed = JSON.parse(body);
					} catch {
						throw malformed(endpointId, response.status, "Response was not valid JSON");
					}
					if (!isJsonResponse(response)) {
						throw malformed(endpointId, response.status, "Expected an application/json response");
					}
					const decoded = decodeOrThrow(
						endpointId,
						(value) =>
							decodeEndpointResponse(endpointId, value) as ReturnType<
								typeof decodeEndpointResponse
							>,
						parsed,
						response.status,
					) as DecodedResponse<EndpointResponseMap[K]>;
					return {
						...decoded,
						responseStatus: response.status,
						responseHeaders: response.headers,
					};
				},
				{ ...policy, signal: options.signal },
			);
		} finally {
			dispose();
		}
	}
}

function validHealth() {
	return { status: "valid" as const, issueCount: 0, issues: [] };
}

function malformed(
	endpointId: EndpointId,
	responseStatus: number,
	message: string,
): OpenRouterHttpError {
	return new OpenRouterHttpError({
		label: endpointId,
		status: 0,
		responseStatus,
		errorClass: "malformed-response",
		envelope: { message },
	});
}

function isJsonResponse(response: Response): boolean {
	const contentType = response.headers.get("Content-Type")?.trim() ?? "";
	return /^(application\/json|application\/[^;]+\+json)(?:;|$)/i.test(contentType);
}

async function readBoundedBody(
	response: Response,
	limit: number,
	endpointId: EndpointId,
): Promise<string> {
	const declared = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(declared) && declared > limit) {
		throw malformed(endpointId, response.status, `Response exceeds ${limit} bytes`);
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit)
				throw malformed(endpointId, response.status, `Response exceeds ${limit} bytes`);
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

export class EndpointTransportError extends Error {
	readonly statusCode = 0;

	constructor(
		readonly endpointId: EndpointId,
		cause: unknown,
	) {
		super(
			`Fetch failed (${endpointId}): ${cause instanceof Error ? cause.message : String(cause)}`,
			{
				cause,
			},
		);
		this.name = "EndpointTransportError";
	}
}
