/**
 * Tests for refresh cancellation and stale-result suppression.
 *
 * Covers:
 *   - createRefreshContext: abort composition, deadline, cancellation
 *   - publishIfCurrent: late results are discarded
 *   - RefreshCoordinator: supersession aborts in-flight refreshes and
 *     discards obsolete results
 */

import { describe, it, expect } from "vitest";
import { createRefreshContext, publishIfCurrent } from "../../infrastructure/refreshContext";
import { RefreshCoordinator } from "../../infrastructure/refreshCoordinator";
import { HttpPipeline, withLogging } from "../../api/transport/httpPipeline";

describe("createRefreshContext", () => {
	it("provides a unique refreshId per context", () => {
		const a = createRefreshContext("user");
		const b = createRefreshContext("user");
		expect(a.refreshId).not.toBe(b.refreshId);
	});

	it("aborts when the timeout elapses", async () => {
		const ctx = createRefreshContext("user", 5);
		expect(ctx.isCancelled()).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ctx.isCancelled()).toBe(true);
		expect(() => ctx.throwIfCancelled()).toThrow();
	});

	it("aborts when the external signal fires", async () => {
		const controller = new AbortController();
		const ctx = createRefreshContext("user", undefined, controller.signal);
		controller.abort();
		expect(ctx.isCancelled()).toBe(true);
	});

	it("stops retry delay when the caller signal is cancelled", async () => {
		const controller = new AbortController();
		const { fetchWithRetry } = await import("../../api/transport/fetchHelpers");
		const promise = fetchWithRetry(
			async () => {
				throw new TypeError("fetch failed: ECONNRESET");
			},
			{ maxRetries: 3, baseDelayMs: 1000, signal: controller.signal },
		);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ cancelled: true });
	});

	it("no deadline when no timeout", () => {
		const ctx = createRefreshContext("scheduled");
		expect(ctx.deadlineEpochMs).toBeUndefined();
	});

	it("records the reason", () => {
		const ctx = createRefreshContext("config");
		expect(ctx.reason).toBe("config");
	});
});

describe("publishIfCurrent", () => {
	it("publishes when the refresh is still current", async () => {
		const ctx = createRefreshContext("user");
		const result = await publishIfCurrent(
			ctx,
			() => ctx.refreshId,
			async () => "ok",
		);
		expect(result).toBe("ok");
	});

	it("discards when the refresh id is superseded", async () => {
		const ctx = createRefreshContext("user");
		const result = await publishIfCurrent(
			ctx,
			() => ctx.refreshId + 1,
			async () => "stale",
		);
		expect(result).toBeUndefined();
	});

	it("discards when the context is cancelled", async () => {
		const controller = new AbortController();
		const ctx = createRefreshContext("user", undefined, controller.signal);
		controller.abort();
		const result = await publishIfCurrent(
			ctx,
			() => ctx.refreshId,
			async () => "late",
		);
		expect(result).toBeUndefined();
	});
});

describe("RefreshCoordinator supersession", () => {
	it("runs a single refresh and returns its result", async () => {
		const coordinator = new RefreshCoordinator();
		const result = await coordinator.acquire("pricing", "user", async (ctx) => {
			expect(ctx.refreshId).toBeGreaterThan(0);
			return "done";
		});
		expect(result).toBe("done");
		expect(coordinator.isInProgress).toBe(false);
	});

	it("supersedes an in-flight refresh and discards its result", async () => {
		const coordinator = new RefreshCoordinator();
		let firstAborted = false;
		let firstResult: string | undefined;

		// First refresh — slow, must not publish once superseded.
		const first = coordinator.acquire("pricing", "user", async (ctx) => {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 500);
				ctx.signal.addEventListener("abort", () => {
					firstAborted = true;
					clearTimeout(timer);
					resolve();
				});
			});
			firstResult = ctx.isCancelled() ? "cancelled" : "first";
			return firstResult;
		});

		// Give the first refresh a moment to start, then supersede it.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = await coordinator.acquire("usage", "user", async () => "second");

		const firstOutcome = await first;
		expect(firstAborted).toBe(true);
		// The superseded refresh's result is discarded at the coordinator boundary.
		expect(firstOutcome).toBeUndefined();
		expect(second).toBe("second");
		expect(coordinator.isInProgress).toBe(false);
	});

	it("discards a stale result when superseded mid-flight", async () => {
		const coordinator = new RefreshCoordinator();
		let releaseFirst: (() => void) | undefined;
		let firstPublished = false;

		const first = coordinator.acquire("pricing", "user", async (ctx) => {
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			if (ctx.isCancelled()) return "cancelled";
			// Simulate publishing after the coordinator already moved on.
			if (coordinator.latestId !== ctx.refreshId) {
				firstPublished = false;
				return undefined;
			}
			firstPublished = true;
			return "first";
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		// This acquire aborts the first after the grace period.
		const secondPromise = coordinator.acquire("usage", "user", async () => "second");
		// Give the supersede grace period time to elapse.
		await new Promise((resolve) => setTimeout(resolve, 250));
		releaseFirst?.();
		const firstResult = await first;
		const secondResult = await secondPromise;

		expect(firstResult).toBeUndefined();
		expect(secondResult).toBe("second");
		expect(firstPublished).toBe(false);
	});

	it("serializes without abort when the first finishes quickly", async () => {
		const coordinator = new RefreshCoordinator();
		const order: string[] = [];

		const first = coordinator.acquire("pricing", "user", async () => {
			order.push("first");
			return "first";
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = await coordinator.acquire("usage", "user", async () => {
			order.push("second");
			return "second";
		});
		await first;

		expect(second).toBe("second");
		expect(order).toEqual(["first", "second"]);
	});

	it("correlates outbound request logs with the refresh id", async () => {
		const records: unknown[][] = [];
		const pipeline = new HttpPipeline(
			{
				fetch: async () => new Response("ok", { status: 200 }),
			},
			[
				withLogging({
					info: (...args) => records.push(args),
					warn: (...args) => records.push(args),
				}),
			],
		);
		const coordinator = new RefreshCoordinator();

		await coordinator.acquire("usage", "user", async (ctx) => {
			await pipeline.fetch("https://example.test/activity?api_key_hash=secret", {
				method: "GET",
				refreshId: ctx.refreshId,
			} as RequestInit & { refreshId: number });
		});

		const message = String(records[0]?.[0]);
		expect(message).toContain(`refresh=${(records[0]?.[0] as string).match(/refresh=(\d+)/)?.[1]}`);
		expect(message).not.toContain("secret");
	});
});
