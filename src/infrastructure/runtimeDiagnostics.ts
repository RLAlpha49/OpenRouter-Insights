import { redact } from "../api/redaction";

export type RuntimeFailureKind = "command" | "config" | "background" | "activation";

/** Final outcome of a recorded request observation. */
export type RequestOutcome =
	| "success"
	| "rate-limited"
	| "server-error"
	| "transport-error"
	| "auth-error"
	| "client-error"
	| "malformed-response"
	| "cancelled";

/** Bounded per-request observation retained in the snapshot. */
export interface RequestObservation {
	endpoint: string;
	durationMs: number;
	outcome: RequestOutcome;
	retries: number;
	cancelled: boolean;
}

/** Bounded diagnostic context for a state-DB or cache boundary operation. */
export interface BoundaryDiagnostic {
	kind: "state-db" | "cache";
	operation: string;
	/** Diagnostic classification, e.g. `ok`, `busy`, `unreadable`, `oversized-after-trim`. */
	diagnostic: string;
	/** Optional bounded byte/count bucket (never raw values). */
	sizeBucket?: string;
	/** Optional fallback path taken, e.g. `stale-cache`, `preserved-previous`. */
	fallback?: string;
}

export interface RuntimeDiagnosticsSnapshot {
	requests: {
		total: number;
		byEndpoint: Record<string, number>;
		observations: RequestObservation[];
	};
	cache: { hits: number; misses: number; writes: number };
	refresh: { started: number; completed: number; failed: number; deduplicated: number };
	failures: Record<RuntimeFailureKind, number>;
	recentFailures: Array<{ kind: RuntimeFailureKind; message: string }>;
	boundary: BoundaryDiagnostic[];
}

interface RuntimeDiagnosticsOptions {
	maxRecentFailures?: number;
	maxEndpoints?: number;
	maxObservations?: number;
	maxBoundary?: number;
}

/** Process-local, bounded counters for runtime health inspection and tests. */
export class RuntimeDiagnostics {
	private readonly maxRecentFailures: number;
	private readonly maxEndpoints: number;
	private readonly maxObservations: number;
	private readonly maxBoundary: number;
	private readonly recentFailures: Array<{ kind: RuntimeFailureKind; message: string }> = [];
	private readonly endpointCounts = new Map<string, number>();
	private readonly observations: RequestObservation[] = [];
	private readonly boundary: BoundaryDiagnostic[] = [];
	private readonly inFlight = new Map<string, Promise<unknown>>();
	private requestTotal = 0;
	private cacheHits = 0;
	private cacheMisses = 0;
	private cacheWrites = 0;
	private refreshStarted = 0;
	private refreshCompleted = 0;
	private refreshFailed = 0;
	private refreshDeduplicated = 0;
	private readonly failureCounts: Record<RuntimeFailureKind, number> = {
		command: 0,
		config: 0,
		background: 0,
		activation: 0,
	};

	constructor(options: RuntimeDiagnosticsOptions = {}) {
		this.maxRecentFailures = Math.max(0, options.maxRecentFailures ?? 20);
		this.maxEndpoints = Math.max(1, options.maxEndpoints ?? 20);
		this.maxObservations = Math.max(0, options.maxObservations ?? 25);
		this.maxBoundary = Math.max(0, options.maxBoundary ?? 25);
	}

	recordRequest(endpoint: string): void {
		this.requestTotal++;
		const safeEndpoint = endpoint.split(/[?#]/, 1)[0].slice(0, 160) || "unknown";
		if (!this.endpointCounts.has(safeEndpoint) && this.endpointCounts.size >= this.maxEndpoints)
			return;
		this.endpointCounts.set(safeEndpoint, (this.endpointCounts.get(safeEndpoint) ?? 0) + 1);
	}

	/**
	 * Record a completed request with its duration and outcome dimensions.
	 * Kept bounded: only the most recent `maxObservations` are retained and
	 * endpoint identity is preserved (no query strings, no payloads).
	 */
	recordRequestObservation(observation: RequestObservation): void {
		if (this.maxObservations === 0) return;
		const safeEndpoint = observation.endpoint.split(/[?#]/, 1)[0].slice(0, 160) || "unknown";
		const entry: RequestObservation = {
			endpoint: safeEndpoint,
			durationMs: Math.max(0, Math.round(observation.durationMs)),
			outcome: observation.outcome,
			retries: Math.max(0, observation.retries | 0),
			cancelled: observation.cancelled === true,
		};
		this.observations.push(entry);
		while (this.observations.length > this.maxObservations) this.observations.shift();
		// Keep endpoint cardinality counters in sync for the summary view.
		if (!this.endpointCounts.has(safeEndpoint) && this.endpointCounts.size >= this.maxEndpoints)
			return;
		this.endpointCounts.set(safeEndpoint, (this.endpointCounts.get(safeEndpoint) ?? 0) + 1);
	}

	recordCacheHit(): void {
		this.cacheHits++;
	}

	recordCacheMiss(): void {
		this.cacheMisses++;
	}

	recordCacheWrite(): void {
		this.cacheWrites++;
	}

	recordRefreshStarted(_label: string): void {
		this.refreshStarted++;
	}

	recordRefreshCompleted(_label: string): void {
		this.refreshCompleted++;
	}

	recordRefreshFailed(_label: string): void {
		this.refreshFailed++;
	}

	recordRefreshDeduplicated(): void {
		this.refreshDeduplicated++;
	}

	recordFailure(kind: RuntimeFailureKind, message: unknown): void {
		this.failureCounts[kind]++;
		if (this.maxRecentFailures === 0) return;
		this.recentFailures.push({ kind, message: redact(String(message)).slice(0, 240) });
		while (this.recentFailures.length > this.maxRecentFailures) this.recentFailures.shift();
	}

	/**
	 * Record a bounded diagnostic at a state-DB or cache boundary. Never stores
	 * model values or database contents — only the diagnostic kind, operation,
	 * a size bucket, and any fallback path taken.
	 */
	recordBoundary(diagnostic: BoundaryDiagnostic): void {
		if (this.maxBoundary === 0) return;
		this.boundary.push({
			kind: diagnostic.kind,
			operation: diagnostic.operation.slice(0, 80),
			diagnostic: diagnostic.diagnostic.slice(0, 80),
			sizeBucket: diagnostic.sizeBucket?.slice(0, 40),
			fallback: diagnostic.fallback?.slice(0, 80),
		});
		while (this.boundary.length > this.maxBoundary) this.boundary.shift();
	}

	async coalesce<T>(key: string, work: () => Promise<T>): Promise<T> {
		const existing = this.inFlight.get(key);
		if (existing !== undefined) {
			this.recordRefreshDeduplicated();
			return (await existing) as T;
		}
		this.recordRefreshStarted(key);
		const pending = work();
		this.inFlight.set(key, pending);
		try {
			const result = await pending;
			this.recordRefreshCompleted(key);
			return result;
		} catch (error) {
			this.recordRefreshFailed(key);
			throw error;
		} finally {
			if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
		}
	}

	snapshot(): RuntimeDiagnosticsSnapshot {
		return {
			requests: {
				total: this.requestTotal,
				byEndpoint: Object.fromEntries(this.endpointCounts),
				observations: this.observations.map((observation) => ({ ...observation })),
			},
			cache: { hits: this.cacheHits, misses: this.cacheMisses, writes: this.cacheWrites },
			refresh: {
				started: this.refreshStarted,
				completed: this.refreshCompleted,
				failed: this.refreshFailed,
				deduplicated: this.refreshDeduplicated,
			},
			failures: { ...this.failureCounts },
			recentFailures: this.recentFailures.map((failure) => ({ ...failure })),
			boundary: this.boundary.map((diagnostic) => ({ ...diagnostic })),
		};
	}

	/**
	 * Render a concise, fully redacted support report suitable for copy/paste
	 * into a support ticket. Contains only bounded counters, endpoint paths,
	 * outcome dimensions, and diagnostic kinds — no secrets or payload data.
	 */
	report(): string {
		const snap = this.snapshot();
		const lines: string[] = ["OpenRouter Insights — Runtime Diagnostics"];
		lines.push(`Generated: ${new Date().toISOString()}`);
		lines.push("");
		lines.push("Requests");
		lines.push(`  total: ${snap.requests.total}`);
		const endpoints = Object.entries(snap.requests.byEndpoint);
		lines.push(
			endpoints.length > 0
				? `  byEndpoint: ${endpoints.map(([e, c]) => `${e}=${c}`).join(", ")}`
				: "  byEndpoint: (none)",
		);
		if (snap.requests.observations.length > 0) {
			lines.push("  recent observations:");
			for (const o of snap.requests.observations) {
				lines.push(
					`    - ${o.endpoint} ${o.durationMs}ms ${o.outcome}` +
						(o.retries > 0 ? ` retries=${o.retries}` : "") +
						(o.cancelled ? " cancelled" : ""),
				);
			}
		}
		lines.push("");
		lines.push("Cache");
		lines.push(
			`  hits: ${snap.cache.hits} misses: ${snap.cache.misses} writes: ${snap.cache.writes}`,
		);
		lines.push("");
		lines.push("Refresh");
		lines.push(
			`  started: ${snap.refresh.started} completed: ${snap.refresh.completed} ` +
				`failed: ${snap.refresh.failed} deduplicated: ${snap.refresh.deduplicated}`,
		);
		lines.push("");
		lines.push("Failures");
		lines.push(`  ${JSON.stringify(snap.failures)}`);
		if (snap.boundary.length > 0) {
			lines.push("");
			lines.push("Boundary diagnostics");
			for (const b of snap.boundary) {
				lines.push(
					`  - ${b.kind}/${b.operation}: ${b.diagnostic}` +
						(b.sizeBucket ? ` (${b.sizeBucket})` : "") +
						(b.fallback ? ` [${b.fallback}]` : ""),
				);
			}
		}
		if (snap.recentFailures.length > 0) {
			lines.push("");
			lines.push("Recent failures");
			for (const f of snap.recentFailures) {
				lines.push(`  - [${f.kind}] ${f.message}`);
			}
		}
		return lines.join("\n");
	}
}
