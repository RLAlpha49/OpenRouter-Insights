import { describe, expect, it } from "vitest";
import { RuntimeDiagnostics } from "../../infrastructure/runtimeDiagnostics";

describe("RuntimeDiagnostics", () => {
	it("keeps bounded counters and redacted recent failures in process-local memory", () => {
		const diagnostics = new RuntimeDiagnostics({ maxRecentFailures: 2 });

		diagnostics.recordRequest("https://openrouter.ai/api/v1/models?api_key=secret");
		diagnostics.recordCacheHit();
		diagnostics.recordCacheMiss();
		diagnostics.recordRefreshStarted("pricing");
		diagnostics.recordRefreshCompleted("pricing");
		diagnostics.recordFailure("command", "Bearer secret-token");
		diagnostics.recordFailure("config", "second failure");
		diagnostics.recordFailure("background", "third failure");

		expect(diagnostics.snapshot()).toEqual({
			requests: { total: 1, byEndpoint: { "https://openrouter.ai/api/v1/models": 1 } },
			cache: { hits: 1, misses: 1, writes: 0 },
			refresh: { started: 1, completed: 1, failed: 0, deduplicated: 0 },
			failures: { command: 1, config: 1, background: 1, activation: 0 },
			recentFailures: [
				{ kind: "config", message: "second failure" },
				{ kind: "background", message: "third failure" },
			],
		});
	});

	it("coalesces refresh work and records the deduplicated call", async () => {
		const diagnostics = new RuntimeDiagnostics();
		let executions = 0;
		const work = diagnostics.coalesce("pricing", async () => {
			executions++;
			await Promise.resolve();
			return "ok";
		});

		await expect(
			Promise.all([work, diagnostics.coalesce("pricing", async () => "other")]),
		).resolves.toEqual(["ok", "ok"]);
		expect(executions).toBe(1);
		expect(diagnostics.snapshot().refresh.deduplicated).toBe(1);
	});
});
