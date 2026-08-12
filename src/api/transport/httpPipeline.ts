/**
 * HTTP Pipeline — composable middleware for HttpClient.
 *
 * Wraps the base HttpClient with middleware that can intercept,
 * modify, or short-circuit requests. Each middleware receives the
 * request, the URL, and a `next` function to call the next layer.
 *
 * Usage:
 *   import { HttpPipeline, withAuth, withTimeout, withLogging } from "./httpPipeline";
 *   const pipeline = new HttpPipeline(defaultHttpClient, [
 *     withLogging(log),
 *     withTimeout(15_000),
 *     withAuth(() => apiKey),
 *   ]);
 *   const res = await pipeline.fetch("https://...", init);
 */

import type { HttpClient, HttpRequestInit } from "./httpClient";
import { redactUrl } from "../redaction";
import type { EndpointId } from "../endpoint/endpointCatalog";
import {
	applyEndpointPolicy,
	type EndpointCredentialProviders,
	type EndpointRequestWithMetadata,
} from "./endpointPolicy";

interface RequestMetadata {
	refreshId?: number;
	endpointId?: EndpointId;
}

export type EndpointRequestInit = HttpRequestInit & { endpointId?: EndpointId };

/** Minimal logger interface to avoid circular imports. */
interface PipelineLogger {
	info(..._args: unknown[]): void;
	warn(..._args: unknown[]): void;
}

export interface RequestDiagnostics {
	recordRequest(_endpoint: string): void;
}

// ── Middleware type ───────────────────────────────────────────

/** A composable HTTP middleware function. */
export type HttpMiddleware = (
	_req: RequestInit,
	_url: string,
	_next: () => Promise<Response>,
) => Promise<Response>;

// ── Pipeline ──────────────────────────────────────────────────

/** Composes HttpClient with a middleware stack. Implements HttpClient for drop-in replacement. */
export class HttpPipeline implements HttpClient {
	constructor(
		private readonly _base: HttpClient,
		private readonly _middlewares: readonly HttpMiddleware[],
		private readonly _requestDiagnostics?: RequestDiagnostics,
	) {}

	async fetch(url: string, init?: RequestInit): Promise<Response> {
		this._requestDiagnostics?.recordRequest(redactUrl(url));
		let next = () => this._base.fetch(url, init);
		for (let i = this._middlewares.length - 1; i >= 0; i--) {
			const mw = this._middlewares[i];
			const prev = next;
			next = () => mw(init ?? {}, url, prev);
		}
		return next();
	}
}

/**
 * Execute a request using an endpoint contract. The endpoint ID is carried
 * only in RequestInit metadata and is removed before the base client sees it.
 */
export async function fetchEndpoint(
	client: HttpClient,
	url: string,
	endpointId: EndpointId,
	init: RequestInit,
	providers: EndpointCredentialProviders,
): Promise<Response> {
	const request: EndpointRequestWithMetadata = { ...init, endpointId };
	await applyEndpointPolicy(request, providers);
	delete request.endpointId;
	return client.fetch(url, request);
}

// ── Built-in middleware ────────────────────────────────────────

/**
 * Inject an Authorization header from an async key provider.
 * Called on every request so key rotations are picked up automatically.
 */
export function withAuth(keyProvider: () => Promise<string>): HttpMiddleware {
	return async (req, _url, next) => {
		const key = await keyProvider();
		if (key) {
			req.headers = {
				...(req.headers as Record<string, string> | undefined),
				Authorization: `Bearer ${key}`,
			};
		}
		return next();
	};
}

/**
 * Apply the authentication and method policy declared by an endpoint contract.
 * Public endpoints explicitly discard ambient credentials so callers cannot
 * accidentally broaden the credential boundary by reusing request options.
 */
export function withEndpointPolicy(providers: EndpointCredentialProviders): HttpMiddleware {
	return async (req, _url, next) => {
		await applyEndpointPolicy(req as EndpointRequestWithMetadata, providers);
		return next();
	};
}

/**
 * Apply an AbortController timeout to every request.
 * Prevents hanging requests beyond `ms` milliseconds.
 *
 * The external abort listener is removed in the shared cleanup path so
 * completed requests do not retain closures through caller-owned signals
 * during long-lived polling sessions.
 */
export function withTimeout(ms: number): HttpMiddleware {
	return (req, _url, next) => {
		const controller = new AbortController();
		const existingSignal = req.signal;
		const timeout = setTimeout(() => controller.abort(), ms);

		const onExternalAbort = () => controller.abort();
		if (existingSignal) {
			if (existingSignal.aborted) {
				controller.abort();
			} else {
				existingSignal.addEventListener("abort", onExternalAbort, { once: true });
			}
		}

		const cleanup = () => {
			clearTimeout(timeout);
			existingSignal?.removeEventListener("abort", onExternalAbort);
		};
		req.signal = controller.signal;

		return next().then(
			(res) => {
				cleanup();
				return res;
			},
			(err) => {
				cleanup();
				throw err;
			},
		);
	};
}

/**
 * Log request/response metadata via a logger interface.
 */
export function withLogging(log: PipelineLogger): HttpMiddleware {
	return async (req, url, next) => {
		const method = (req.method ?? "GET") as string;
		const refreshId =
			(req as RequestInit & RequestMetadata).refreshId ??
			(req.signal as (AbortSignal & RequestMetadata) | undefined)?.refreshId;
		const correlation = refreshId === undefined ? "" : ` refresh=${refreshId}`;
		const safeUrl = redactUrl(url);
		const start = Date.now();
		try {
			const res = await next();
			const ms = Date.now() - start;
			const level = res.ok ? "info" : "warn";
			(level === "warn" ? log.warn : log.info)(
				`[http]${correlation} ${method} ${safeUrl} → ${res.status} (${ms}ms)`,
			);
			return res;
		} catch (err) {
			const ms = Date.now() - start;
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(`[http]${correlation} ${method} ${safeUrl} → FAIL (${ms}ms): ${msg}`);
			throw err;
		}
	};
}

/**
 * Inject common request headers (Accept, Accept-Encoding, Content-Type).
 */
export function withDefaultHeaders(headers: Record<string, string>): HttpMiddleware {
	return (req, _url, next) => {
		req.headers = {
			...headers,
			...(req.headers as Record<string, string> | undefined),
		};
		return next();
	};
}
