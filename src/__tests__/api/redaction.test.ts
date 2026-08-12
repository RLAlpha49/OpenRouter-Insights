/**
 * Security tests — redaction policy
 *
 * Verifies that bearer tokens, API keys, and created-key values can never
 * appear in logs, errors, exports, or notifications:
 *   - redact() strips keys from arbitrary text
 *   - redactUrl() strips credentials from URLs
 *   - maskKeyLabel() masks sk- labels for display
 *   - containsSecret() detects secrets that slipped through
 *   - the logger boundary redacts everything it writes
 */

import { describe, it, expect } from "vitest";
import {
	redact,
	redactUrl,
	redactBodySnippet,
	redactObject,
	maskKeyLabel,
	containsSecret,
} from "../../api/redaction";
import { Logger } from "../../infrastructure/logger";
import { OpenRouterHttpError } from "../../api/transport/openRouterError";
import { formatError, formatErrorBrief } from "../../infrastructure/logger";
import { withLogging } from "../../api/transport/httpPipeline";

const SAMPLE_KEY = "sk-or-v1-abcdef0123456789abcdef0123456789";

describe("redact", () => {
	it("redacts a bearer token anywhere in text", () => {
		const text = `Authorization: Bearer ${SAMPLE_KEY} in a message`;
		const out = redact(text);
		expect(out).not.toContain(SAMPLE_KEY);
		expect(out).toContain("REDACTED");
	});

	it("redacts a raw key without the Bearer prefix", () => {
		const text = `key=${SAMPLE_KEY}`;
		expect(redact(text)).not.toContain(SAMPLE_KEY);
	});

	it("redacts generic sk- shaped tokens", () => {
		const legacy = "token sk-abcdefghijklmnop123456";
		expect(redact(legacy)).not.toContain("sk-abcdefghijklmnop");
	});

	it("redacts opaque bearer credentials", () => {
		const out = redact("Authorization: Bearer opaque-secret-value");
		expect(out).toBe("Authorization: Bearer …REDACTED");
	});

	it("is idempotent", () => {
		const text = `Authorization: Bearer ${SAMPLE_KEY}`;
		const once = redact(text);
		expect(redact(once)).toBe(once);
	});

	it("leaves safe text untouched", () => {
		expect(redact("no secrets here 12345")).toBe("no secrets here 12345");
	});
});

describe("redactUrl", () => {
	it("strips userinfo credentials", () => {
		const url = "https://user:pass@openrouter.ai/api/v1/models";
		const out = redactUrl(url);
		expect(out).not.toContain("user:pass");
		expect(out).toContain("openrouter.ai");
	});

	it("redacts secret-bearing query params", () => {
		const url = `https://openrouter.ai/api/v1/activity?api_key=${SAMPLE_KEY}`;
		const out = redactUrl(url);
		expect(out).not.toContain(SAMPLE_KEY);
		expect(out).toContain("api_key=");
		expect(out).toContain("REDACTED");
	});

	it("redacts key hashes and credential-like query parameters", () => {
		const url =
			"https://openrouter.ai/api/v1/activity?api_key_hash=hash-abc123&access_token=token-value";
		const out = redactUrl(url);
		expect(out).not.toContain("hash-abc123");
		expect(out).not.toContain("token-value");
		expect(out).toContain("api_key_hash=");
	});

	it("redacts secret-shaped values in unknown query parameters", () => {
		const out = redactUrl(`https://openrouter.ai/api/v1/models?custom=${SAMPLE_KEY}`);
		expect(out).not.toContain(SAMPLE_KEY);
		expect(out).toContain("custom=");
	});

	it("matches sensitive query names case-insensitively", () => {
		const out = redactUrl("https://openrouter.ai/api/v1/models?Api-Key=secret-value");
		expect(out).not.toContain("secret-value");
	});

	it("redacts secret-shaped values in URL paths and remains idempotent", () => {
		const out = redactUrl(`https://openrouter.ai/keys/${SAMPLE_KEY}`);
		expect(out).not.toContain(SAMPLE_KEY);
		expect(redactUrl(out)).toBe(out);
	});

	it("falls back to plain redaction for invalid URLs", () => {
		const bad = `not a url ${SAMPLE_KEY}`;
		expect(redactUrl(bad)).not.toContain(SAMPLE_KEY);
	});
});

describe("redactBodySnippet", () => {
	it("redacts keys inside a JSON error envelope", () => {
		const body = JSON.stringify({ error: { message: `bad key ${SAMPLE_KEY}`, type: "auth" } });
		const out = redactBodySnippet(body);
		expect(out).not.toContain(SAMPLE_KEY);
	});

	it("bounds the snippet length", () => {
		const long = "x".repeat(2000);
		expect(redactBodySnippet(long).length).toBeLessThanOrEqual(400);
	});
});

describe("redactObject", () => {
	it("redacts string fields recursively-ish", () => {
		const obj = { url: `https://x?token=${SAMPLE_KEY}`, list: [SAMPLE_KEY, "ok"] };
		const out = redactObject(obj);
		expect(JSON.stringify(out)).not.toContain(SAMPLE_KEY);
	});

	it("redacts nested records and arrays", () => {
		const input = {
			request: { headers: { Authorization: `Bearer ${SAMPLE_KEY}` } },
			items: [{ token: SAMPLE_KEY }, "safe"],
		};

		const output = redactObject(input);

		expect(output.request.headers.Authorization).toBe("Bearer …REDACTED");
		expect(output.items[0]).toEqual({ token: "sk-or-v1-…REDACTED" });
	});

	it("preserves cyclic structure while redacting strings", () => {
		const input: Record<string, unknown> = { secret: SAMPLE_KEY };
		input.self = input;

		const output = redactObject(input);

		expect(output.secret).toBe("sk-or-v1-…REDACTED");
		expect(output.self).toBe(output);
	});
});

describe("maskKeyLabel", () => {
	it("masks an sk-or label to a short prefix + suffix", () => {
		const label = "sk-or-v1-abcdef0123456789-xyz";
		const out = maskKeyLabel(label);
		expect(out).not.toBe(label);
		expect(out.length).toBeLessThan(label.length);
		expect(out).toContain("…");
	});

	it("leaves non-key strings alone", () => {
		expect(maskKeyLabel("My Key")).toBe("My Key");
		expect(maskKeyLabel(undefined)).toBe("");
	});

	it("fully masks short key-shaped strings", () => {
		expect(maskKeyLabel("sk-or-v1-abc")).toContain("REDACTED");
	});
});

describe("containsSecret", () => {
	it("detects raw keys", () => {
		expect(containsSecret(`x ${SAMPLE_KEY} y`)).toBe(true);
	});

	it("returns false for clean text", () => {
		expect(containsSecret("no secrets")).toBe(false);
	});
});

describe("logger redaction boundary", () => {
	it("redacts URLs at the HTTP middleware boundary on success and failure", async () => {
		const lines: string[] = [];
		const logger = {
			info: (...args: unknown[]) => lines.push(args.join(" ")),
			warn: (...args: unknown[]) => lines.push(args.join(" ")),
		};
		const middleware = withLogging(logger);
		await middleware(
			{},
			"https://openrouter.ai/api/v1/activity?api_key_hash=hash-abc123",
			async () => new Response("ok", { status: 200 }),
		);
		await expect(
			middleware({}, "https://openrouter.ai/api/v1/activity?api_key_hash=hash-abc123", async () => {
				throw new Error("network failure");
			}),
		).rejects.toThrow("network failure");
		expect(lines.join("\n")).not.toContain("hash-abc123");
	});

	it("never writes a raw bearer token through the Logger", () => {
		const lines: string[] = [];
		const channel = {
			appendLine: (line: string) => lines.push(line),
			show: () => {},
			dispose: () => {},
		} as never;
		const logger = new Logger("test", channel as never);
		logger.info(`Bearer ${SAMPLE_KEY}`);
		logger.warn({ token: SAMPLE_KEY });
		expect(lines.join("\n")).not.toContain(SAMPLE_KEY);
	});

	it("redacts errors in formatError / formatErrorBrief", () => {
		const err = new Error(`Request failed: ${SAMPLE_KEY}`);
		expect(formatError(err)).not.toContain(SAMPLE_KEY);
		expect(formatErrorBrief(err)).not.toContain(SAMPLE_KEY);
	});

	it("redacts OpenRouterHttpError summaries", () => {
		const err = new OpenRouterHttpError({
			label: "key",
			status: 401,
			envelope: { message: `invalid key ${SAMPLE_KEY}`, type: "auth" },
			bodySnippet: SAMPLE_KEY,
		});
		const summary = err.toSummary();
		expect(summary).not.toContain(SAMPLE_KEY);
		expect(summary).toContain("HTTP 401");
	});
});
