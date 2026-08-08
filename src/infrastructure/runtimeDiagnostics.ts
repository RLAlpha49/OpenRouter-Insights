import { redact } from "../api/redaction";

export type RuntimeFailureKind = "command" | "config" | "background" | "activation";

export interface RuntimeDiagnosticsSnapshot {
	requests: { total: number; byEndpoint: Record<string, number> };
	cache: { hits: number; misses: number; writes: number };
	refresh: { started: number; completed: number; failed: number; deduplicated: number };
	failures: Record<RuntimeFailureKind, number>;
	recentFailures: Array<{ kind: RuntimeFailureKind; message: string }>;
}

interface RuntimeDiagnosticsOptions {
	maxRecentFailures?: number;
	maxEndpoints?: number;
}

/** Process-local, bounded counters for runtime health inspection and tests. */
export class RuntimeDiagnostics {
	private readonly maxRecentFailures: number;
	private readonly maxEndpoints: number;
	private readonly recentFailures: Array<{ kind: RuntimeFailureKind; message: string }> = [];
	private readonly endpointCounts = new Map<string, number>();
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
	}

	recordRequest(endpoint: string): void {
		this.requestTotal++;
		const safeEndpoint = endpoint.split(/[?#]/, 1)[0].slice(0, 160) || "unknown";
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
			requests: { total: this.requestTotal, byEndpoint: Object.fromEntries(this.endpointCounts) },
			cache: { hits: this.cacheHits, misses: this.cacheMisses, writes: this.cacheWrites },
			refresh: {
				started: this.refreshStarted,
				completed: this.refreshCompleted,
				failed: this.refreshFailed,
				deduplicated: this.refreshDeduplicated,
			},
			failures: { ...this.failureCounts },
			recentFailures: this.recentFailures.map((failure) => ({ ...failure })),
		};
	}
}
