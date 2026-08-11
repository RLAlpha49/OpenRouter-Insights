/**
 * Shared fetch helpers — structured error classification, retry loops,
 * and utilities used by pricingService, usageService, and analyticsService.
 */

import { OpenRouterHttpError, type OpenRouterErrorClass } from "./openRouterError";

/** Classification returned by the shared retry and error-handling pipeline. */
export interface FetchError {
	kind: "transient" | "permanent";
	code: number;
	message: string;
	/** Server-specified retry delay in seconds, parsed from Retry-After header. */
	retryAfterSeconds?: number;
	/** Structured OpenRouter error class when known. */
	errorClass?: OpenRouterErrorClass;
}

/** Final outcome reported for a completed request observation. */
export type RequestOutcome =
	| "success"
	| "rate-limited"
	| "server-error"
	| "transport-error"
	| "auth-error"
	| "client-error"
	| "malformed-response"
	| "cancelled";

/** Bounded dimensions for one request lifecycle, for runtime diagnostics. */
export interface RequestObservation {
	endpoint: string;
	durationMs: number;
	outcome: RequestOutcome;
	retries: number;
	cancelled: boolean;
}

/** Map a structured error class to its retry category. */
export function toFetchKind(errorClass: OpenRouterErrorClass): "transient" | "permanent" {
	switch (errorClass) {
		case "rate-limit":
		case "server":
		case "transport":
			return "transient";
		default:
			return "permanent";
	}
}

/** Convert a structured OpenRouter error to the retry classification shape. */
export function toFetchError(err: OpenRouterHttpError): FetchError {
	return {
		kind: toFetchKind(err.errorClass),
		code: err.status,
		message: err.message,
		retryAfterSeconds: err.retryAfterSeconds,
		errorClass: err.errorClass,
	};
}

/**
 * Unified error classifier shared by pricing, usage, and analytics services.
 *
 * Distinguishes:
 *   - abort/timeout (transient transport)
 *   - HTTP status classes (401 auth, 402 insufficient credit, 403 permission,
 *     404 not-found, 429 rate-limit, 5xx server, other 4xx client)
 *   - network-level failures (transient)
 *   - JSON parse / application errors (permanent)
 *
 * Accepts an optional response body snippet so the OpenRouter error
 * envelope (`error.message` / `error.type`) can be surfaced.
 */
export function classifyError(
	err: unknown,
	responseHeaders?: Headers,
	bodySnippet?: string,
): FetchError {
	const msg = err instanceof Error ? err.message : String(err);
	const code = (err as { statusCode?: number }).statusCode ?? 0;

	// Structured errors first — they already carry the full envelope.
	if (err instanceof OpenRouterHttpError) {
		return toFetchError(err);
	}

	if (
		(err instanceof DOMException && err.name === "AbortError") ||
		(err instanceof Error && err.name === "AbortError")
	) {
		return {
			kind: "transient",
			code: 0,
			message: "Request timed out",
			errorClass: "transport",
		};
	}

	// HTTP status code errors
	if (code > 0) {
		const httpErr = new OpenRouterHttpError({
			label: "api",
			status: code,
			headers: responseHeaders,
			bodySnippet,
			envelope: bodySnippet ? { message: msg } : undefined,
		});
		return toFetchError(httpErr);
	}

	// Network-level errors
	if (err instanceof TypeError) {
		const message = err.message;
		if (
			/fetch failed/i.test(message) ||
			/network/i.test(message) ||
			/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message)
		) {
			return {
				kind: "transient",
				code: 0,
				message: `Network error: ${message}`,
				errorClass: "transport",
			};
		}
		return { kind: "permanent", code: 0, message: `Unexpected error: ${message}` };
	}

	// DNS / connection errors surfaced as generic Errors
	if (/fetch|network|econnrefused|enotfound|dns/i.test(msg)) {
		return { kind: "transient", code: 0, message: msg, errorClass: "transport" };
	}

	// JSON parse failures, application errors — permanent
	return { kind: "permanent", code: 0, message: msg };
}

/** Promise-based sleep for retry backoff. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clock abstraction so retry timing can be deterministic in tests. */
export interface Clock {
	now(): number;
	sleep(_ms: number): Promise<void>;
	randomRatio(): number;
}

/** Production clock — real wall time, setTimeout, crypto randomness. */
export const systemClock: Clock = {
	now: () => Date.now(),
	sleep,
	randomRatio: () => cryptoRandomRatio(),
};

/** Maximum single retry delay (30s) — protects users from unbounded waits. */
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Compute the delay before a retry attempt.
 *   - respects server `Retry-After` as a floor (with an upper cap)
 *   - exponential backoff with jitter
 *   - honors a valid `0` retry-after (checked with !== undefined)
 *   - bounded by `maxDelayMs`
 */
export function computeRetryDelay(
	attempt: number,
	baseDelayMs: number,
	retryAfterSeconds: number | undefined,
	now: number,
	clock: { now(): number; randomRatio(): number } = systemClock,
	maxDelayMs: number = MAX_RETRY_DELAY_MS,
): number {
	// Server-specified delay as a floor — capped to avoid infinite waits.
	const retryAfterMs =
		retryAfterSeconds !== undefined ? Math.min(retryAfterSeconds * 1000, maxDelayMs) : 0;
	// Exponential backoff with jitter: base * 2^(attempt-1) * (0.5..1)
	const jitter = clock.randomRatio();
	const exponentialDelay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + jitter * 0.5);
	return Math.min(Math.max(retryAfterMs, exponentialDelay), maxDelayMs);
}

/** Options for fetchWithRetry. */
export interface FetchWithRetryOptions {
	maxRetries?: number;
	baseDelayMs?: number;
	/** Called on each failed attempt with the error annotation. */
	onAttempt?: (_attempt: number, _error: FetchError) => void;
	/**
	 * Called once when the full retry lifecycle completes (success or final
	 * failure). Carries bounded latency and outcome dimensions for diagnostics.
	 */
	onRequestObservation?: (_observation: RequestObservation) => void;
	/** Optional error classifier override. Defaults to classifyError. */
	classify?: (_err: unknown) => FetchError;
	/** Injectable clock for deterministic retry timing. */
	clock?: Clock;
	/** True when the operation should not be retried (e.g. aborted by caller). */
	isAborted?: () => boolean;
	/** Caller-owned cancellation signal for the complete retry lifecycle. */
	signal?: AbortSignal;
	/** Endpoint label for the request observation (diagnostics only). */
	endpoint?: string;
}

/** Create a timeout controller that also follows a caller-owned signal. */
export function createAbortController(
	timeoutMs: number,
	externalSignal?: AbortSignal,
): { controller: AbortController; dispose: () => void } {
	const controller = new AbortController();
	const refreshId = (externalSignal as (AbortSignal & { refreshId?: number }) | undefined)
		?.refreshId;
	if (refreshId !== undefined) {
		Object.defineProperty(controller.signal, "refreshId", {
			value: refreshId,
			enumerable: false,
		});
	}
	const onAbort = () => controller.abort(externalSignal?.reason);
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (externalSignal) {
		if (externalSignal.aborted) onAbort();
		else externalSignal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		controller,
		dispose: () => {
			clearTimeout(timer);
			externalSignal?.removeEventListener("abort", onAbort);
		},
	};
}

function cancelledError(): OpenRouterHttpError {
	const error = new OpenRouterHttpError({
		label: "api",
		errorClass: "transport",
		aborted: true,
		envelope: { message: "Operation cancelled" },
	});
	Object.defineProperty(error, "cancelled", { value: true, enumerable: true });
	return error;
}

function isCancelled(options: FetchWithRetryOptions): boolean {
	return Boolean(options.isAborted?.() || options.signal?.aborted);
}

async function waitBeforeRetry(
	clock: Clock,
	delayMs: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal?.aborted) throw cancelledError();
	await clock.sleep(delayMs);
	if (signal?.aborted) throw cancelledError();
}

function getRetryDelay(
	attempt: number,
	baseDelayMs: number,
	error: FetchError,
	clock: Clock,
): number {
	return computeRetryDelay(attempt, baseDelayMs, error.retryAfterSeconds, clock.now(), clock);
}

function classifyAttempt(
	err: unknown,
	classify: (_err: unknown, _headers?: Headers, _body?: string) => FetchError,
): FetchError {
	const errHeaders = (err as { headers?: Headers }).headers;
	const errBody = (err as { bodySnippet?: string }).bodySnippet;
	return classify(err, errHeaders, errBody);
}

async function runAttempt<T>(
	fn: () => Promise<T>,
	classify: (_err: unknown, _headers?: Headers, _body?: string) => FetchError,
): Promise<{ value?: T; error?: FetchError; rawError?: unknown }> {
	try {
		return { value: await fn() };
	} catch (err) {
		return { error: classifyAttempt(err, classify), rawError: err };
	}
}

/**
 * Execute a fetch with exponential-backoff retry.
 *
 * @param fn      The async operation to retry
 * @param options Retry configuration
 * @returns The result of `fn` on success
 * @throws The last error if all retries are exhausted
 */
export async function fetchWithRetry<T>(
	fn: () => Promise<T>,
	options: FetchWithRetryOptions,
): Promise<T> {
	const maxRetries = options.maxRetries ?? 3;
	const baseDelayMs = options.baseDelayMs ?? 1000;
	const classify = options.classify ?? classifyError;
	const clock = options.clock ?? systemClock;
	const startedAt = clock.now();

	let lastError: FetchError | undefined;
	let lastRawError: unknown;
	let attempts = 0;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		attempts = attempt;
		if (isCancelled(options)) break;
		const attemptResult = await runAttempt(fn, classify);
		if (!attemptResult.error) {
			if (options.onRequestObservation) {
				options.onRequestObservation({
					endpoint: options.endpoint ?? "unknown",
					durationMs: clock.now() - startedAt,
					outcome: "success",
					retries: attempt - 1,
					cancelled: false,
				});
			}
			return attemptResult.value as T;
		}
		if (isCancelled(options)) break;
		lastError = attemptResult.error;
		lastRawError = attemptResult.rawError;
		options.onAttempt?.(attempt, lastError);
		if (lastError.kind === "permanent" || attempt === maxRetries) break;
		const delay = getRetryDelay(attempt, baseDelayMs, lastError, clock);
		await waitBeforeRetry(clock, delay, options.signal);
	}

	const durationMs = clock.now() - startedAt;
	const cancelled = isCancelled(options);
	const outcome = outcomeForError(lastError, cancelled);
	options.onRequestObservation?.({
		endpoint: options.endpoint ?? "unknown",
		durationMs,
		outcome,
		retries: attempts - 1,
		cancelled,
	});

	const detail = lastError?.message ?? "unknown error";
	// Preserve the original structured error when available so the envelope
	// (error.type / error.message) survives the retry loop.
	if (cancelled) throw cancelledError();
	if (lastRawError instanceof OpenRouterHttpError) {
		throw lastRawError;
	}
	throw new OpenRouterHttpError({
		label: "api",
		cause: lastRawError,
		status: lastError?.code ?? 0,
		errorClass: lastError?.errorClass ?? "malformed-response",
		envelope: {
			message:
				`Operation failed after ${maxRetries} attempt${maxRetries > 1 ? "s" : ""}: ${detail}` +
				(lastError?.errorClass === "server" || lastError?.errorClass === "transport"
					? `; OpenRouter API unreachable after ${maxRetries} attempts`
					: ""),
		},
	});
}

/** Map a final terminal error (or cancellation) to a bounded outcome dimension. */
function outcomeForError(error: FetchError | undefined, cancelled: boolean): RequestOutcome {
	if (cancelled) return "cancelled";
	if (!error) return "transport-error";
	switch (error.errorClass) {
		case "rate-limit":
			return "rate-limited";
		case "server":
			return "server-error";
		case "transport":
			return "transport-error";
		case "auth":
			return "auth-error";
		case "permission":
		case "insufficient-credit":
		case "not-found":
		case "client":
			return "client-error";
		case "malformed-response":
			return "malformed-response";
		default:
			return error.kind === "transient" ? "transport-error" : "client-error";
	}
}

/** Return a ratio in [0, 1) using crypto-quality randomness. */
function cryptoRandomRatio(): number {
	const crypto = require("node:crypto") as typeof import("node:crypto");
	return crypto.randomBytes(4).readUInt32BE(0) / 4294967296;
}
