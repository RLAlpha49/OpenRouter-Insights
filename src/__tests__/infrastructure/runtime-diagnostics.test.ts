import { describe, expect, it } from "vitest";
import { RuntimeDiagnostics } from "../../infrastructure/runtimeDiagnostics";

describe("RuntimeDiagnostics", () => {
	it("keeps bounded counters and redacted recent failures in process-local memory", () => {
		const diagnostics = new RuntimeDiagnostics({ maxRecentFailures: 2 });

		diagnostics.recordRequestObservation({
			endpoint: "https://openrouter.ai/api/v1/models?api_key=secret",
			durationMs: 1,
			outcome: "success",
			retries: 0,
			cancelled: false,
		});
		diagnostics.recordCacheHit();
		diagnostics.recordCacheMiss();
		diagnostics.recordRefreshStarted("pricing");
		diagnostics.recordRefreshCompleted("pricing");
		diagnostics.recordFailure("command", "Bearer secret-token");
		diagnostics.recordFailure("config", "second failure");
		diagnostics.recordFailure("background", "third failure");

		expect(diagnostics.snapshot()).toEqual({
			requests: {
				total: 1,
				byEndpoint: { "https://openrouter.ai/api/v1/models": 1 },
				observations: [
					{
						endpoint: "https://openrouter.ai/api/v1/models",
						durationMs: 1,
						outcome: "success",
						retries: 0,
						cancelled: false,
					},
				],
			},
			cache: { hits: 1, misses: 1, writes: 0 },
			refresh: { started: 1, completed: 1, failed: 0, cancelled: 0, deduplicated: 0 },
			failures: { command: 1, config: 1, background: 1, activation: 0 },
			recentFailures: [
				{ kind: "config", message: "second failure" },
				{ kind: "background", message: "third failure" },
			],
			boundary: [],
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

	it("counts one completed logical request and retains bounded correlation metadata", () => {
		const diagnostics = new RuntimeDiagnostics();
		diagnostics.recordRequestObservation({
			endpoint: "models.list",
			durationMs: 12,
			outcome: "success",
			retries: 2,
			cancelled: false,
			observedAt: 1_700_000_000_000,
			refreshId: 42,
		});

		const snapshot = diagnostics.snapshot();
		expect(snapshot.requests.total).toBe(1);
		expect(snapshot.requests.byEndpoint).toEqual({ "models.list": 1 });
		expect(snapshot.requests.observations[0]).toMatchObject({
			observedAt: 1_700_000_000_000,
			refreshId: 42,
		});
	});

	it("records bounded request observations with outcome dimensions and drops query strings", () => {
		const diagnostics = new RuntimeDiagnostics({ maxObservations: 2 });
		diagnostics.recordRequestObservation({
			endpoint: "https://openrouter.ai/api/v1/models?api_key=secret",
			durationMs: 1234,
			outcome: "success",
			retries: 2,
			cancelled: false,
			observedAt: 1_700_000_000_000,
			refreshId: 123,
		});
		diagnostics.recordRequestObservation({
			endpoint: "keys.current",
			durationMs: 50,
			outcome: "rate-limited",
			retries: 3,
			cancelled: false,
			observedAt: 1_700_000_000_001,
		});
		// A third observation past the cap evicts the oldest (models.list).
		diagnostics.recordRequestObservation({
			endpoint: "analytics.query",
			durationMs: 9,
			outcome: "success",
			retries: 0,
			cancelled: false,
			observedAt: 1_700_000_000_002,
		});

		const snap = diagnostics.snapshot();
		expect(snap.requests.observations).toHaveLength(2);
		// Oldest (models.list) was evicted past the cap; newest two remain.
		expect(snap.requests.observations[0].endpoint).toBe("keys.current");
		expect(snap.requests.observations[0]).toMatchObject({
			durationMs: 50,
			outcome: "rate-limited",
			retries: 3,
		});
		expect(snap.requests.observations[1].endpoint).toBe("analytics.query");
	});

	it("records bounded boundary diagnostics and keeps them redacted", () => {
		const diagnostics = new RuntimeDiagnostics({ maxBoundary: 2 });
		diagnostics.recordBoundary({ kind: "state-db", operation: "resolve", diagnostic: "busy" });
		diagnostics.recordBoundary({
			kind: "cache",
			operation: "set",
			diagnostic: "rejected",
			sizeBucket: "2.4MB",
			fallback: "preserved-previous",
		});
		diagnostics.recordBoundary({
			kind: "cache",
			operation: "validate",
			diagnostic: "no-valid-entries",
			fallback: "discarded",
		});

		const boundary = diagnostics.snapshot().boundary;
		expect(boundary).toHaveLength(2);
		expect(boundary[0]).toMatchObject({
			kind: "cache",
			operation: "set",
			diagnostic: "rejected",
			sizeBucket: "2.4MB",
			fallback: "preserved-previous",
		});
		expect(boundary[0].observedAt).toEqual(expect.any(Number));
	});

	it("renders a redacted support report without secrets", () => {
		const diagnostics = new RuntimeDiagnostics();
		diagnostics.recordRequestObservation({
			endpoint: "models.list",
			durationMs: 1,
			outcome: "success",
			retries: 0,
			cancelled: false,
		});
		diagnostics.recordCacheWrite();
		diagnostics.recordFailure("command", "Bearer sk-or-v1-secret-token");
		diagnostics.recordBoundary({ kind: "cache", operation: "set", diagnostic: "written" });

		const report = diagnostics.report();
		expect(report).toContain("Runtime Diagnostics");
		expect(report).toContain("models.list");
		// Secrets are redacted out of the report entirely.
		expect(report).not.toContain("secret-token");
		expect(report).not.toContain("sk-or-v1");
	});
});
