/**
 * Tests for fetch helpers (classifyError, fetchWithRetry, sleep).
 */

import { describe, it, expect, vi } from "vitest";
import { classifyError, fetchWithRetry, sleep } from "../../api/transport/fetchHelpers";

describe("sleep", () => {
	it("resolves after specified time", async () => {
		const start = Date.now();
		await sleep(10);
		expect(Date.now() - start).toBeGreaterThanOrEqual(5); // allow slight timer variance
	});
});

describe("fetchWithRetry", () => {
	it("classifies AbortError as an aborted transport failure", () => {
		const result = classifyError(new DOMException("The operation was aborted", "AbortError"));

		expect(result).toMatchObject({ kind: "transient", errorClass: "transport" });
	});

	it("throws a structured aborted error when the caller signal is cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			fetchWithRetry(async () => "unreachable", { signal: controller.signal }),
		).rejects.toMatchObject({
			aborted: true,
			errorClass: "transport",
		});
	});

	it("succeeds on first attempt", async () => {
		const result = await fetchWithRetry(async () => "success", {});
		expect(result).toBe("success");
	});

	it("retries on transient error and succeeds", async () => {
		let attempts = 0;
		const result = await fetchWithRetry(
			async () => {
				attempts++;
				if (attempts < 2) {
					const err = Object.assign(new Error("Server error"), { statusCode: 500 });
					throw err;
				}
				return "recovered";
			},
			{ baseDelayMs: 1 },
		);
		expect(result).toBe("recovered");
		expect(attempts).toBe(2);
	});

	it("does not retry on permanent errors", async () => {
		let attempts = 0;
		const promise = fetchWithRetry(
			async () => {
				attempts++;
				const err = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
				throw err;
			},
			{ baseDelayMs: 1 },
		);
		await expect(promise).rejects.toThrow();
		expect(attempts).toBe(1);
	});

	it("throws after exhausting retries", async () => {
		let attempts = 0;
		const promise = fetchWithRetry(
			async () => {
				attempts++;
				const err = Object.assign(new Error("Rate limited"), { statusCode: 429 });
				throw err;
			},
			{ maxRetries: 2, baseDelayMs: 1 },
		);
		await expect(promise).rejects.toThrow("Operation failed after 2 attempts");
		expect(attempts).toBe(2);
	});

	it("calls onAttempt for each failure", async () => {
		const onAttempt = vi.fn();
		const promise = fetchWithRetry(
			async () => {
				const err = Object.assign(new Error("fail"), { statusCode: 429 });
				throw err;
			},
			{ maxRetries: 2, baseDelayMs: 1, onAttempt },
		);
		await expect(promise).rejects.toThrow();
		expect(onAttempt).toHaveBeenCalledTimes(2);
	});
});
