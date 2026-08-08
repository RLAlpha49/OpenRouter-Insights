/**
 * Tests for the structured OpenRouter error envelope and status policy.
 *
 * Covers: auth, credit (402), rate-limit (429 + Retry-After),
 * permission (403), not-found (404), server (5xx), malformed responses,
 * timeout/abort, and non-JSON error bodies.
 */

import { describe, it, expect } from "vitest";
import {
	OpenRouterHttpError,
	classifyHttpStatus,
	parseOpenRouterErrorEnvelope,
	parseRetryAfterSeconds,
} from "../../api/transport/openRouterError";
import { classifyError, fetchWithRetry, computeRetryDelay } from "../../api/transport/fetchHelpers";

describe("classifyHttpStatus", () => {
	it("maps status codes to error classes", () => {
		expect(classifyHttpStatus(401)).toBe("auth");
		expect(classifyHttpStatus(402)).toBe("insufficient-credit");
		expect(classifyHttpStatus(403)).toBe("permission");
		expect(classifyHttpStatus(404)).toBe("not-found");
		expect(classifyHttpStatus(429)).toBe("rate-limit");
		expect(classifyHttpStatus(500)).toBe("server");
		expect(classifyHttpStatus(503)).toBe("server");
		expect(classifyHttpStatus(422)).toBe("client");
		expect(classifyHttpStatus(0)).toBe("transport");
	});

	it("allows valid HTTP responses to override transport classification", () => {
		const err = new OpenRouterHttpError({
			label: "models.list",
			status: 200,
			errorClass: "malformed-response",
		});
		expect(err.errorClass).toBe("malformed-response");
		expect(err.retryPolicy).toBe("no-retry");
		expect(err.isRetryable).toBe(false);
	});
});

describe("parseOpenRouterErrorEnvelope", () => {
	it("parses message and type from the error envelope", () => {
		const body = JSON.stringify({ error: { message: "Insufficient credits", type: "payment" } });
		expect(parseOpenRouterErrorEnvelope(body)).toEqual({
			message: "Insufficient credits",
			type: "payment",
		});
	});

	it("returns empty strings for non-JSON bodies", () => {
		expect(parseOpenRouterErrorEnvelope("plain text error")).toEqual({ message: "", type: "" });
	});

	it("returns empty strings for non-envelope JSON", () => {
		expect(parseOpenRouterErrorEnvelope('{"data": []}')).toEqual({ message: "", type: "" });
	});

	it("handles missing fields", () => {
		expect(parseOpenRouterErrorEnvelope('{"error": {"type": "x"}}')).toEqual({
			message: "",
			type: "x",
		});
	});

	it("bounds message length", () => {
		const long = "m".repeat(500);
		const body = JSON.stringify({ error: { message: long } });
		expect(parseOpenRouterErrorEnvelope(body).message.length).toBeLessThanOrEqual(300);
	});
});

describe("OpenRouterHttpError", () => {
	it("classifies retry policy by class", () => {
		const rateLimit = new OpenRouterHttpError({ label: "key", status: 429 });
		expect(rateLimit.errorClass).toBe("rate-limit");
		expect(rateLimit.retryPolicy).toBe("retry-after");
		expect(rateLimit.isRetryable).toBe(true);

		const auth = new OpenRouterHttpError({ label: "key", status: 401 });
		expect(auth.retryPolicy).toBe("no-retry");
		expect(auth.isRetryable).toBe(false);

		const credit = new OpenRouterHttpError({ label: "key", status: 402 });
		expect(credit.errorClass).toBe("insufficient-credit");
		expect(credit.isRetryable).toBe(false);

		const permission = new OpenRouterHttpError({ label: "keys", status: 403 });
		expect(permission.errorClass).toBe("permission");
		expect(permission.isRetryable).toBe(false);
	});

	it("carries the sanitized envelope", () => {
		const err = new OpenRouterHttpError({
			label: "analytics",
			status: 402,
			envelope: { message: "Insufficient credits", type: "payment_required" },
			bodySnippet: "sk-or-v1-secret…",
		});
		expect(err.apiMessage).toBe("Insufficient credits");
		expect(err.errorType).toBe("payment_required");
		expect(err.message).toContain("HTTP 402");
	});

	it("derives retry-after from headers", () => {
		const headers = new Headers({ "Retry-After": "12" });
		const err = new OpenRouterHttpError({ label: "key", status: 429, headers });
		expect(err.retryAfterSeconds).toBe(12);
	});

	it("does not retry a 404", () => {
		const err = new OpenRouterHttpError({ label: "models", status: 404 });
		expect(err.isRetryable).toBe(false);
	});
});

describe("parseRetryAfterSeconds", () => {
	it("parses delta-seconds (integer)", () => {
		expect(parseRetryAfterSeconds(new Headers({ "Retry-After": "5" }))).toBe(5);
	});

	it("honors a valid 0 value", () => {
		expect(parseRetryAfterSeconds(new Headers({ "Retry-After": "0" }))).toBe(0);
	});

	it("parses HTTP-date format", () => {
		const future = new Date(Date.now() + 30_000).toUTCString();
		const seconds = parseRetryAfterSeconds(new Headers({ "Retry-After": future }));
		expect(seconds).toBeGreaterThanOrEqual(25);
		expect(seconds).toBeLessThanOrEqual(35);
	});

	it("falls back to X-RateLimit-Reset (epoch seconds)", () => {
		const futureEpoch = Math.floor(Date.now() / 1000) + 60;
		const seconds = parseRetryAfterSeconds(
			new Headers({ "X-RateLimit-Reset": String(futureEpoch) }),
		);
		expect(seconds).toBeGreaterThanOrEqual(55);
		expect(seconds).toBeLessThanOrEqual(65);
	});

	it("returns undefined when headers absent", () => {
		expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
	});
});

describe("classifyError", () => {
	it("classifies 401 as permanent", () => {
		const err = Object.assign(new Error("unauthorized"), { statusCode: 401 });
		const cls = classifyError(err);
		expect(cls.kind).toBe("permanent");
		expect(cls.errorClass).toBe("auth");
	});

	it("classifies 429 as transient with retry-after", () => {
		const headers = new Headers({ "Retry-After": "9" });
		const err = Object.assign(new Error("rate limited"), { statusCode: 429 });
		const cls = classifyError(err, headers);
		expect(cls.kind).toBe("transient");
		expect(cls.errorClass).toBe("rate-limit");
		expect(cls.retryAfterSeconds).toBe(9);
	});

	it("classifies 5xx as transient server", () => {
		const err = Object.assign(new Error("boom"), { statusCode: 503 });
		const cls = classifyError(err);
		expect(cls.kind).toBe("transient");
		expect(cls.errorClass).toBe("server");
	});

	it("classifies aborts as transient transport", () => {
		const domErr = new DOMException("Aborted", "AbortError");
		const cls = classifyError(domErr);
		expect(cls.kind).toBe("transient");
		expect(cls.errorClass).toBe("transport");
	});

	it("classifies network failures as transient", () => {
		const cls = classifyError(new TypeError("fetch failed: ECONNREFUSED"));
		expect(cls.kind).toBe("transient");
		expect(cls.errorClass).toBe("transport");
	});

	it("classifies malformed response as permanent", () => {
		const cls = classifyError(new Error("Unexpected token < in JSON"));
		expect(cls.kind).toBe("permanent");
	});
});

describe("fetchWithRetry structured policy", () => {
	it("preserves malformed response identity after exhaustion", async () => {
		let attempts = 0;
		const malformed = new OpenRouterHttpError({
			label: "models.list",
			status: 200,
			errorClass: "malformed-response",
			envelope: { message: "Invalid response schema" },
		});

		await expect(
			fetchWithRetry(
				async () => {
					attempts++;
					throw malformed;
				},
				{ maxRetries: 3, baseDelayMs: 1 },
			),
		).rejects.toBe(malformed);
		expect(attempts).toBe(1);
	});

	it("does not retry insufficient-credit (402)", async () => {
		let attempts = 0;
		await expect(
			fetchWithRetry(
				async () => {
					attempts++;
					throw new OpenRouterHttpError({ label: "key", status: 402 });
				},
				{ maxRetries: 3, baseDelayMs: 1 },
			),
		).rejects.toThrow();
		expect(attempts).toBe(1);
	});

	it("retries rate-limit and honors retry-after as floor", async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		const fakeClock = {
			now: () => 0,
			randomRatio: () => 0.5,
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
		};
		const headers = new Headers({ "Retry-After": "2" });
		await expect(
			fetchWithRetry(
				async () => {
					attempts++;
					throw Object.assign(new Error("rate limited"), { statusCode: 429, headers });
				},
				{ maxRetries: 2, baseDelayMs: 100, clock: fakeClock },
			),
		).rejects.toThrow();
		expect(attempts).toBe(2);
		// Retry-After (2000ms) is the floor over the exponential (100 * 2^0 * 0.75 = 75ms).
		expect(sleeps[0]).toBe(2000);
	});

	it("does not retry after cancellation", async () => {
		let attempts = 0;
		await expect(
			fetchWithRetry(
				async () => {
					attempts++;
					throw new Error("boom");
				},
				{ maxRetries: 5, isAborted: () => true },
			),
		).rejects.toMatchObject({ cancelled: true });
		expect(attempts).toBe(0);
	});
});

describe("computeRetryDelay", () => {
	it("caps server-specified delays at the max", () => {
		const clock = { now: () => 0, randomRatio: () => 0.5 };
		const delay = computeRetryDelay(1, 1000, 3600, 0, clock, 30_000);
		expect(delay).toBe(30_000);
	});

	it("honors a zero retry-after (immediate retry, still > 0)", () => {
		const clock = { now: () => 0, randomRatio: () => 0.5 };
		const delay = computeRetryDelay(1, 1000, 0, 0, clock);
		expect(delay).toBeGreaterThan(0);
		expect(delay).toBeLessThan(1000);
	});

	it("grows exponentially per attempt", () => {
		const clock = { now: () => 0, randomRatio: () => 0.5 };
		const d1 = computeRetryDelay(1, 1000, undefined, 0, clock);
		const d2 = computeRetryDelay(2, 1000, undefined, 0, clock);
		expect(d2).toBeGreaterThan(d1);
	});
});
