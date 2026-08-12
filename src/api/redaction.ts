/**
 * Redaction utility — central policy for keeping secrets out of logs,
 * errors, exports, and telemetry.
 *
 * Applied at the boundary: URLs, error bodies, request bodies, and
 * structured diagnostics pass through redact() before being logged or
 * surfaced. Newly created API keys and bearer tokens are the primary
 * concern; OpenRouter key labels (`sk-or-v1-…`) are masked to a short
 * prefix + hash suffix so support diagnostics stay actionable without
 * leaking the key.
 */

/** Matches an OpenRouter API key anywhere in a string. */
const BEARER_PATTERN = /sk-or-v1-[A-Za-z0-9_-]+/g;
/** Matches a bearer Authorization header value. */
const AUTH_HEADER_PATTERN = /(Bearer\s+)(?!…REDACTED\b)([^\s"',\]}]+)/gi;
/** Matches any sk-…-shaped token (defense in depth for legacy formats). */
const GENERIC_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}/g;

/** Default replacement for a matched key: `sk-or-v1-…REDACTED`. */
const REDACTED = "sk-or-v1-…REDACTED";

/**
 * Redact API keys and bearer credentials from arbitrary text.
 * Idempotent and safe to apply to URLs, JSON body snippets, and messages.
 */
export function redact(text: string): string {
	if (!text) return text;
	return text
		.replace(AUTH_HEADER_PATTERN, "$1…REDACTED")
		.replace(BEARER_PATTERN, REDACTED)
		.replace(GENERIC_KEY_PATTERN, "sk-…REDACTED");
}

/** Sanitize a URL for logging — strips credentials, keeps path + query keys. */
export function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		// Redact common secret-bearing query params.
		for (const key of [
			"api_key",
			"api_key_hash",
			"access_token",
			"refresh_token",
			"key",
			"token",
			"apikey",
			"api-key",
			"authorization",
			"signature",
		]) {
			for (const actualKey of parsed.searchParams.keys()) {
				if (actualKey.toLowerCase() === key) {
					parsed.searchParams.set(actualKey, "…REDACTED");
				}
			}
		}
		return redact(decodeURI(parsed.toString()));
	} catch {
		// Not a valid URL — strip anything that looks like a key.
		return redact(url);
	}
}

/**
 * Mask an API key label for display, e.g. `sk-or-v1-abcdef123…wxyz`.
 * Keeps the first 12 characters and the last 4 so users can recognize
 * the key without the secret being recoverable.
 */
export function maskKeyLabel(label: string | undefined | null): string {
	if (!label?.startsWith("sk-")) return label ?? "";
	if (label.length <= 20) return REDACTED;
	return `${label.slice(0, 12)}…${label.slice(-4)}`;
}

/**
 * Redact a JSON body snippet. Bounded length (callers should already
 * truncate); strips bearer values and key-shaped tokens. If the snippet
 * is not JSON it is redacted as plain text.
 */
export function redactBodySnippet(body: string): string {
	const bounded = body.slice(0, 400);
	return redact(bounded);
}

/**
 * Redact structured diagnostics recursively.
 * Use for values that may embed request/response data at any depth.
 * Cycles are preserved without recursing forever.
 */
export function redactObject<T extends Record<string, unknown>>(obj: T): T {
	const seen = new WeakMap<object, unknown>();

	const visit = (value: unknown): unknown => {
		if (typeof value === "string") return redact(value);
		if (value === null || typeof value !== "object") return value;

		const existing = seen.get(value);
		if (existing !== undefined) return existing;

		if (Array.isArray(value)) {
			const output: unknown[] = [];
			seen.set(value, output);
			for (const item of value) output.push(visit(item));
			return output;
		}

		const output: Record<string, unknown> = {};
		seen.set(value, output);
		for (const [key, nested] of Object.entries(value)) {
			output[key] = visit(nested);
		}
		return output;
	};

	return visit(obj) as T;
}

/** True when the string contains anything that looks like an API key. */
export function containsSecret(text: string): boolean {
	return /sk-or-v1-[A-Za-z0-9_-]+/.test(text) || /\bsk-[A-Za-z0-9_-]{12,}/.test(text);
}
