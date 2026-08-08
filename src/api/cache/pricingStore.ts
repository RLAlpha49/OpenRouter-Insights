/**
 * Cache backend abstraction — decouples the pricing cache from
 * vscode.ExtensionContext.globalState so the cache is testable
 * without a real ExtensionContext and extensible to alternative
 * storage backends (disk, workspace, shared network cache).
 *
 * Split into three interfaces per Interface Segregation Principle:
 *   IPricingStore  — persistence (get/set/staleness)
 *   IPricingIndex  — query (lookup/values/index)
 *   IPricingCache  — combines both for the full cache contract
 *
 * Consumers that only need persistence (e.g. RefreshUseCase) should
 * depend on IPricingStore. Consumers that need lookups (e.g.
 * StatusBarUpdateUseCase) should depend on IPricingIndex. The
 * composition root (services.ts) provides the full IPricingCache.
 */

import type { CachedPricingData, ModelPricingInfo } from "../../types";

/** Persistence-only contract — get, set, staleness, age, clear, info. */
export interface IPricingStore {
	/** Retrieve cached data. Returns undefined when absent or corrupted. */
	get(): CachedPricingData | undefined;

	/** Persist pricing data. */
	set(_data: CachedPricingData): Promise<void>;

	/** True when data is missing or older than the configured max age. */
	isStale(): boolean;

	/** Human-readable age string (e.g. "5m ago", "never"). */
	age(): string;

	/** Clear the cache (in-memory + persisted). */
	clear(): Promise<void>;

	/** Diagnostic info about the cache. */
	cacheInfo(): {
		age: string;
		modelCount: number;
		sizeEstimate: string;
		lastReadMs?: number;
		lastWriteMs?: number;
		lastSerializedBytes?: number;
		ttlHours: number;
		stale: boolean;
		/** True when the last refresh was truncated by the page cap. */
		truncated?: boolean;
		/** Reason for pagination truncation, when truncated. */
		truncationReason?: string;
	};
}

/** Query-only contract — O(1) lookups, values iteration, lowercased index. */
export interface IPricingIndex {
	/** Retrieve the O(1) model-id → pricing lookup map. */
	getLookup(): Map<string, ModelPricingInfo>;

	/** Pre-built values array for efficient iteration. */
	getValues(): readonly ModelPricingInfo[];

	/** Pre-built lowercased-name index for fuzzy matching. */
	getLowercasedIndex(): Map<string, ModelPricingInfo>;
}

/** Full cache contract — combines persistence and query interfaces. */
export interface IPricingCache extends IPricingStore, IPricingIndex {}
