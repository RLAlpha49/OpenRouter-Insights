/**
 * Structured OpenRouter HTTP error — the canonical failure type for all
 * OpenRouter API interactions.
 *
 * Replaces ad-hoc `Object.assign(new Error(...), { statusCode, body })`
 * across services with a typed error carrying:
 *   - endpoint label (e.g. "key", "models", "analytics")
 *   - HTTP status
 *   - the OpenRouter error envelope (`error.type` / `error.message`) when
 *     the server returns one
 *   - retryability + retry-after deadline (from Retry-After or X-RateLimit-Reset)
 *   - a sanitized body snippet (bounded, redacted — never full payloads)
 *
 * @see https://openrouter.ai/docs/api-reference (error envelope)
 */

import { redact, redactBodySnippet } from "../redaction";

/** Classify why an OpenRouter request failed. */
export type OpenRouterErrorClass =
	| "rate-limit" // 429 — retry after honoring Retry-After
	| "auth" // 401 — bad/expired key
	| "permission" // 403 — key lacks the required permission (e.g. management-only endpoint)
	| "insufficient-credit" // 402 — payment required
	| "not-found" // 404
	| "server" // 5xx — transient, retry with budget
	| "malformed-response" // valid HTTP, invalid schema/JSON
	| "transport" // network / timeout / abort
	| "client"; // other 4xx — do not retry

/** Retry policy attached to an error class. */
export type RetryPolicy = "retry-with-backoff" | "retry-after" | "no-retry";

const CLASS_RETRY: Record<OpenRouterErrorClass, RetryPolicy> = {
	"rate-limit": "retry-after",
	auth: "no-retry",
	permission: "no-retry",
	"insufficient-credit": "no-retry",
	"not-found": "no-retry",
	server: "retry-with-backoff",
	"malformed-response": "no-retry",
	transport: "retry-with-backoff",
	client: "no-retry",
};

/** Map an HTTP status to an error class. */
export function classifyHttpStatus(status: number): OpenRouterErrorClass {
	if (status === 401) return "auth";
	if (status === 402) return "insufficient-credit";
	if (status === 403) return "permission";
	if (status === 404) return "not-found";
	if (status === 429) return "rate-limit";
	if (status >= 500 && status < 600) return "server";
	if (status >= 400 && status < 500) return "client";
	return "transport";
}

/**
 * Parse the OpenRouter JSON error envelope from a response body if present.
 * The envelope shape is `{ error: { message?: string, type?: string } }`.
 * Returns `{ message, type }` with only string values (empty when absent).
 */
export function parseOpenRouterErrorEnvelope(body: string): { message: string; type: string } {
	const fallback = { message: "", type: "" };
	if (!body) return fallback;
	try {
		const parsed = JSON.parse(body) as unknown;
		if (typeof parsed !== "object" || parsed === null) return fallback;
		const err = (parsed as { error?: unknown }).error;
		if (typeof err !== "object" || err === null) return fallback;
		const rec = err as Record<string, unknown>;
		return {
			message: typeof rec.message === "string" ? rec.message.slice(0, 300) : "",
			type: typeof rec.type === "string" ? rec.type.slice(0, 100) : "",
		};
	} catch {
		return fallback; // not JSON — caller falls back to a bounded text snippet
	}
}

/** Options for constructing an OpenRouterHttpError. */
export interface OpenRouterHttpErrorOptions {
	label: string;
	cause?: unknown;
	status?: number;
	/** Explicit failure class for valid HTTP responses with malformed payloads. */
	errorClass?: OpenRouterErrorClass;
	/** OpenRouter error envelope values (already parsed/sanitized). */
	envelope?: { message?: string; type?: string };
	/** Bounded body snippet (raw text, sanitized by the caller or here). */
	bodySnippet?: string;
	/** Response headers — used to derive retry-after. */
	headers?: Headers;
	/** True when the failure is an abort (timeout / cancellation). */
	aborted?: boolean;
}

export class OpenRouterHttpError extends Error {
	readonly name = "OpenRouterHttpError";
	readonly label: string;
	readonly status: number;
	readonly errorType: string;
	/** Sanitized OpenRouter `error.message` (bounded, redacted). */
	readonly apiMessage: string;
	readonly errorClass: OpenRouterErrorClass;
	readonly retryPolicy: RetryPolicy;
	/** Retry-after seconds (from Retry-After or X-RateLimit-Reset), undefined when absent. */
	readonly retryAfterSeconds: number | undefined;
	readonly aborted: boolean;
	/** Bounded body snippet for diagnostics (never a full payload). */
	readonly bodySnippet: string;
	readonly cause: unknown;

	constructor(options: OpenRouterHttpErrorOptions) {
		const envelope = {
			message: redact(options.envelope?.message ?? ""),
			type: options.envelope?.type ?? "",
		};
		const status = options.status ?? 0;
		const errorClass = options.errorClass ?? classifyHttpStatus(status);
		const retryAfter = options.headers ? parseRetryAfterSeconds(options.headers) : undefined;

		super(buildMessage(labelFor(options.label), status, envelope, options.bodySnippet));
		this.label = labelFor(options.label);
		this.status = status;
		this.errorType = envelope.type;
		this.apiMessage = envelope.message;
		this.errorClass = errorClass;
		this.retryPolicy = CLASS_RETRY[errorClass];
		this.retryAfterSeconds = retryAfter;
		this.aborted = options.aborted ?? false;
		this.bodySnippet = redactBodySnippet(options.bodySnippet ?? "");
		this.cause = options.cause;
	}

	/** True when this error should be retried (with budget/backoff). */
	get isRetryable(): boolean {
		return this.retryPolicy !== "no-retry";
	}

	/** Legacy aliases retained for callers that still inspect usage error fields. */
	get _kind(): "transient" | "permanent" {
		return this.isRetryable ? "transient" : "permanent";
	}

	get _code(): number {
		return this.status;
	}

	get _errorClass(): OpenRouterErrorClass {
		return this.errorClass;
	}

	get _errorType(): string {
		return this.errorType || this.errorClass;
	}

	/** Short single-line summary for logs and user messages. */
	toSummary(): string {
		const parts = [`${this.label}`, this.status > 0 ? `HTTP ${this.status}` : "transport"];
		if (this.errorType) parts.push(`type=${this.errorType}`);
		if (this.apiMessage) parts.push(this.apiMessage);
		if (this.retryAfterSeconds !== undefined) {
			parts.push(`retry-after=${this.retryAfterSeconds}s`);
		}
		return parts.join(" · ");
	}
}

function labelFor(label: string): string {
	return label.length > 40 ? `${label.slice(0, 40)}…` : label;
}

function buildMessage(
	label: string,
	status: number,
	envelope: { message?: string; type?: string },
	bodySnippet?: string,
): string {
	const statusPart = status > 0 ? ` (HTTP ${status})` : "";
	let msg = `OpenRouter ${label} failed${statusPart}`;
	if (envelope.type) msg += `: ${envelope.type}`;
	if (envelope.message) {
		msg += envelope.message.length > 0 ? ` — ${envelope.message}` : "";
	}
	if (!envelope.message && bodySnippet) {
		msg += ` — ${bodySnippet.slice(0, 120)}`;
	}
	return msg;
}

/**
 * Parse Retry-After header value into seconds.
 * Handles both delta-seconds (integer) and HTTP-date formats, then falls
 * back to X-RateLimit-Reset (Unix epoch seconds).
 *
 * Time-unit correctness:
 *   const nowEpochSeconds = Date.now() / 1000;
 *   const delay = Math.max(0, resetEpochSeconds - nowEpochSeconds);
 *
 * `retryAfterSeconds !== undefined` distinguishes a valid 0 from absence.
 */
export function parseRetryAfterSeconds(headers: Headers | undefined): number | undefined {
	if (!headers) return undefined;

	const retryAfter = headers.get("Retry-After");
	if (retryAfter) {
		const delta = Number(retryAfter);
		if (Number.isFinite(delta) && delta >= 0) {
			return Math.floor(delta);
		}
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date)) {
			const nowEpochSeconds = Date.now() / 1000;
			const resetEpochSeconds = date / 1000;
			return Math.max(0, Math.ceil(resetEpochSeconds - nowEpochSeconds));
		}
	}

	const resetAt = headers.get("X-RateLimit-Reset");
	if (resetAt) {
		const resetTs = Number(resetAt);
		if (Number.isFinite(resetTs) && resetTs > 0) {
			const nowEpochSeconds = Date.now() / 1000;
			return Math.max(0, Math.ceil(resetTs - nowEpochSeconds));
		}
	}

	return undefined;
}
