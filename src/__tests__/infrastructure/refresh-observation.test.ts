import { describe, expect, it } from "vitest";

import { EventBus } from "../../infrastructure/eventBus";
import { emitRefreshSkipped, observeRefresh } from "../../infrastructure/refreshObservation";

describe("refreshObservation", () => {
	it("emits started then completed with duration for a successful refresh", async () => {
		const bus = new EventBus();
		const events: Array<{ label: string; outcome: string; durationMs?: number }> = [];
		bus.on("refreshTerminal", (e) =>
			events.push({ label: e.label, outcome: e.outcome, durationMs: e.durationMs }),
		);

		const result = await observeRefresh({ label: "pricing", eventBus: bus }, async () => "done");

		expect(result).toBe("done");
		expect(events.map((e) => e.outcome)).toEqual(["started", "completed"]);
		expect(typeof events[1].durationMs).toBe("number");
		expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
	});

	it("emits failed for non-cancellation errors and rethrows", async () => {
		const bus = new EventBus();
		const outcomes: string[] = [];
		bus.on("refreshTerminal", (e) => outcomes.push(e.outcome));

		await expect(
			observeRefresh({ label: "usage", eventBus: bus }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(outcomes).toEqual(["started", "failed"]);
	});

	it("emits cancelled when the error is a cancellation", async () => {
		const bus = new EventBus();
		const outcomes: string[] = [];
		bus.on("refreshTerminal", (e) => outcomes.push(e.outcome));
		const err = new Error("aborted");
		(err as { cancelled?: boolean }).cancelled = true;

		await expect(
			observeRefresh({ label: "statusBar", eventBus: bus }, async () => {
				throw err;
			}),
		).rejects.toThrow("aborted");
		expect(outcomes).toEqual(["started", "cancelled"]);
	});

	it("emits a skipped terminal event without running work", () => {
		const bus = new EventBus();
		const events: Array<{ label: string; outcome: string; reason?: string }> = [];
		bus.on("refreshTerminal", (e) =>
			events.push({ label: e.label, outcome: e.outcome, reason: e.reason }),
		);

		emitRefreshSkipped({ label: "statusBar", eventBus: bus, reason: "window not focused" });

		expect(events).toEqual([
			{ label: "statusBar", outcome: "skipped", reason: "window not focused" },
		]);
	});
});
