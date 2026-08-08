import * as vscode from "vscode";
import type { CachedPricingData, ModelPricingInfo } from "../../types";
import { validateCachedModelEntry } from "../../types";
import type { IPricingCache } from "./pricingStore";
import { log, formatError } from "../../infrastructure/logger";
import type { ReadonlyConfig } from "../../infrastructure/config";
import type { RuntimeDiagnostics } from "../../infrastructure/runtimeDiagnostics";

const CACHE_KEY = "openrouterInsights.pricingCache";
/** Temporary staging key for atomic cache writes. */
const CACHE_KEY_TMP = `${CACHE_KEY}.tmp`;
/** Warn when serialized cache exceeds this size (bytes). */
const CACHE_SIZE_WARN_THRESHOLD = 1_000_000;
/** Maximum allowed cache size (2MB). If exceeded, deprecated models are trimmed. */
const CACHE_SIZE_MAX = 2_000_000;

// ── Generalized schema migration ───────────────────────────────

/**
 * Canonical defaults for every `ModelPricingInfo` field that may be
 * absent from cached entries written by older extension versions.
 *
 * When a new field is added to `ModelPricingInfo`, add its default
 * here and stale cache entries are transparently backfilled on next
 * read — no version number or manual migration step needed.
 */
const MODEL_DEFAULTS: Partial<ModelPricingInfo> = {
	maxOutputLength: 0,
	deprecationDate: "",
	isFree: false,
	supportedParameters: [],
	supportedFeatures: [],
	topProviderIsModerated: false,
	topProviderContextLength: 0,
	topProviderMaxCompletionTokens: 0,
	quantization: "",
	detailsLink: "",
	discountToUser: 0,
	topProviderId: "",
	topProviderName: "",
	inputModalities: [] as string[],
	outputModalities: [] as string[],
};

/**
 * Fill in missing fields on a cached model with their canonical
 * defaults.  When a field was not present in an older cache write
 * (or is `undefined` from a stale JSON parse), it picks up the
 * current default — no version-tracking needed.
 */
function normalizeModel(m: ModelPricingInfo): ModelPricingInfo {
	const target = m as unknown as Record<string, unknown>;
	for (const [key, defaultValue] of Object.entries(MODEL_DEFAULTS)) {
		if (target[key] === undefined) {
			target[key] = defaultValue;
		}
	}
	return m;
}

/**
 * Single source of truth for OpenRouter pricing data — wraps
 * ExtensionContext.globalState for persistence AND maintains an
 * in-memory lookup map so consumers never hold their own copies.
 *
 * Validates cached data on read to guard against corruption from
 * partial writes, schema drift, or VS Code globalState quota issues.
 *
 * Caches the last validated CachedPricingData in memory with a dirty flag,
 * so repeated get() / age() / isStale() calls don't re-deserialize from
 * globalState (~450KB JSON parse). The cache is invalidated on set()
 * and refreshed on first access after invalidation.
 */
export class PricingCache implements IPricingCache {
	private readonly lookup: Map<string, ModelPricingInfo> = new Map();

	/**
	 * Lowercased-name → pricing info index built once per cache refresh.
	 * Eliminates O(n) lowercasing and includes() scans in findBestMatch
	 * on every status-bar cycle.
	 */
	private _lowercasedIndex: Map<string, ModelPricingInfo> | undefined;

	/** Cached values array — invalidated alongside the index on set(). */
	private _valuesArray: readonly ModelPricingInfo[] | undefined;

	/** In-memory cache of the last validated CachedPricingData. */
	private _memCache: CachedPricingData | undefined;
	private _memCacheValid = false;
	private _lastReadMs = 0;
	private _lastWriteMs = 0;
	private _lastSerializedBytes = 0;

	constructor(
		// eslint-disable-next-line no-unused-vars
		private readonly ctx: vscode.ExtensionContext,
		// eslint-disable-next-line no-unused-vars
		private readonly config: ReadonlyConfig,
		private readonly _diagnostics?: RuntimeDiagnostics,
	) {
		const data = this.readAndValidate();
		if (data) {
			this.rebuildLookup(data);
			this._memCache = data;
			this._memCacheValid = true;
			this._diagnostics?.recordCacheWrite();
			log.info(
				"PricingCache: initialized from persisted data,",
				data.models.length,
				"models loaded",
			);
		} else {
			log.info("PricingCache: no valid persisted data, starting empty");
		}
	}

	/**
	 * Retrieve the O(1) model-id → pricing lookup map.
	 * Always reflects the current cache state — no stale copies.
	 */
	getLookup(): Map<string, ModelPricingInfo> {
		return this.lookup;
	}

	/**
	 * Retrieve cached data with structural validation.
	 * Uses an in-memory cache to avoid redundant globalState deserialization.
	 * Returns undefined for missing, corrupted, or schema-incompatible data
	 * so downstream code never sees malformed objects.
	 */
	get(): CachedPricingData | undefined {
		if (this._memCacheValid && this._memCache) {
			this._diagnostics?.recordCacheHit();
			return this._memCache;
		}
		this._memCache = this.readAndValidate();
		this._memCacheValid = true;
		if (this._memCache) this._diagnostics?.recordCacheHit();
		else this._diagnostics?.recordCacheMiss();
		return this._memCache;
	}

	private readAndValidate(): CachedPricingData | undefined {
		const startedAt = Date.now();
		const raw = this.ctx.globalState.get<CachedPricingData>(CACHE_KEY);
		this._lastReadMs = Date.now() - startedAt;

		// Recover staged pricing data after an interrupted write:
		// a host crash between the temp write and the primary write can leave
		// a valid staged value while the primary key still holds older data.
		const recovered = this.recoverStagedData(raw);
		if (recovered) return recovered;

		if (!raw) return undefined;
		return this.validateAndNormalize(raw);
	}

	/**
	 * Recover a valid staged cache value after an interrupted write.
	 *
	 * When a staged value exists, validate both candidates and prefer the
	 * valid one with the newer `fetchedAt`. On successful promotion the
	 * temporary key is removed. Returns the selected candidate, or undefined
	 * when no recovery applies.
	 */
	private recoverStagedData(primary: CachedPricingData | undefined): CachedPricingData | undefined {
		const staged = this.ctx.globalState.get<CachedPricingData>(CACHE_KEY_TMP);
		if (staged === undefined) return undefined;

		const stagedValid = this.validateAndNormalize(staged);
		const primaryValid = primary ? this.validateAndNormalize(primary) : undefined;

		let selected: CachedPricingData | undefined;
		let recoveredStaged = false;
		if (stagedValid && primaryValid) {
			recoveredStaged =
				new Date(stagedValid.fetchedAt).getTime() >= new Date(primaryValid.fetchedAt).getTime();
			selected = recoveredStaged ? stagedValid : primaryValid;
		} else if (stagedValid) {
			recoveredStaged = true;
			selected = stagedValid;
		} else if (primaryValid) {
			selected = primaryValid;
		}

		if (recoveredStaged && selected) {
			log.info(
				"PricingCache: recovered staged pricing data after interrupted write",
				`(${selected.models.length} models, fetchedAt ${selected.fetchedAt})`,
			);
			// Promote the staged value to the primary key, then remove the temp key.
			void this.ctx.globalState.update(CACHE_KEY, selected).then(() => {
				void this.ctx.globalState.update(CACHE_KEY_TMP, undefined);
			});
		} else if (selected === primaryValid) {
			// Primary is newer/valid — just clean up the stale temp key.
			void this.ctx.globalState.update(CACHE_KEY_TMP, undefined);
		}

		return selected;
	}

	/**
	 * Validate a full cache candidate and normalize stale models.
	 * Returns undefined when the candidate is missing or malformed.
	 */
	private validateAndNormalize(raw: CachedPricingData | undefined): CachedPricingData | undefined {
		if (!raw) return undefined;

		// Structural validation — guard against partial writes and schema drift
		if (!Array.isArray(raw.models)) {
			log.warn("Cache validation failed: models is not an array, discarding");
			return undefined;
		}
		if (typeof raw.fetchedAt !== "string") {
			log.warn("Cache validation failed: fetchedAt is not a string, discarding");
			return undefined;
		}
		if (raw.pagination !== undefined) {
			if (
				typeof raw.pagination !== "object" ||
				raw.pagination === null ||
				typeof raw.pagination.pagesFetched !== "number" ||
				typeof raw.pagination.truncated !== "boolean"
			) {
				log.warn("Cache validation failed: pagination metadata is invalid, discarding");
				return undefined;
			}
		}
		if (!isValidDate(raw.fetchedAt)) {
			log.warn("Cache validation failed: fetchedAt is not a valid ISO date, discarding");
			return undefined;
		}

		// Schema migration: normalize stale cached models to current schema
		// BEFORE validation so older entries missing newer fields are
		// backfilled with canonical defaults rather than rejected.
		for (let i = 0; i < raw.models.length; i++) {
			raw.models[i] = normalizeModel(raw.models[i]);
		}

		// Nested value validation: reject entries with malformed
		// numeric pricing, timestamps, or collection fields. A single bad
		// entry is discarded; the rest of the cache is retained.
		const validModels: ModelPricingInfo[] = [];
		for (const m of raw.models) {
			const rejectedPath = validateCachedModelEntry(m);
			if (rejectedPath !== undefined) {
				log.warn(
					`Cache validation failed: model entry rejected at "${rejectedPath}", discarding entry`,
				);
				continue;
			}
			validModels.push(m);
		}
		if (validModels.length === 0) {
			log.warn("Cache validation failed: no valid model entries remain, discarding");
			return undefined;
		}
		raw.models = validModels;

		return raw;
	}

	/**
	 * Persist fresh pricing data with error recovery and size trimming.
	 * Wraps the globalState write in try/catch to handle quota exceeded
	 * and serialization errors gracefully.
	 *
	 * If the estimated serialized size exceeds CACHE_SIZE_MAX, deprecated
	 * models are trimmed before persist to avoid quota violations.
	 * A second pass trims pricing history when the payload is still too large.
	 */
	async set(data: CachedPricingData): Promise<void> {
		const startedAt = Date.now();
		let modelsToWrite = data.models;

		let serialized = JSON.stringify(data);
		this._lastSerializedBytes = Buffer.byteLength(serialized, "utf8");
		if (this._lastSerializedBytes > CACHE_SIZE_MAX) {
			const nonDeprecated = modelsToWrite.filter((m) => !m.isDeprecated);
			if (nonDeprecated.length > 0) {
				log.warn(
					`Cache too large (${modelsToWrite.length} models, ${(serialized.length / 1_000_000).toFixed(1)} MB). ` +
						`Dropping ${modelsToWrite.length - nonDeprecated.length} deprecated models.`,
				);
				modelsToWrite = nonDeprecated;
				data = { ...data, models: modelsToWrite };
				serialized = JSON.stringify(data);
				this._lastSerializedBytes = Buffer.byteLength(serialized, "utf8");
			}
		}

		try {
			await this.ctx.globalState.update(CACHE_KEY_TMP, data);
			// Swap: copy the temp key value to the real key
			const staged = this.ctx.globalState.get<CachedPricingData>(CACHE_KEY_TMP);
			if (!staged) {
				throw new Error(
					"Staged cache data was null after write — globalState write may have failed silently",
				);
			}
			await this.ctx.globalState.update(CACHE_KEY, staged);
			try {
				await this.ctx.globalState.update(CACHE_KEY_TMP, undefined);
			} catch {}
			const finalSerialized = JSON.stringify(data);
			this._lastSerializedBytes = Buffer.byteLength(finalSerialized, "utf8");
			this._lastWriteMs = Date.now() - startedAt;
			log.info(
				"Cache written:",
				this._lastSerializedBytes,
				"bytes,",
				modelsToWrite.length,
				"models",
				`in ${this._lastWriteMs}ms`,
			);
			if (this._lastSerializedBytes > CACHE_SIZE_WARN_THRESHOLD) {
				log.warn(
					`Cache size ~${(this._lastSerializedBytes / 1_000_000).toFixed(1)} MB exceeds ` +
						`${(CACHE_SIZE_WARN_THRESHOLD / 1_000_000).toFixed(1)} MB threshold. ` +
						"Consider trimming or compression if this grows further.",
				);
			}
			this.rebuildLookup(data);
			this._memCache = data;
			this._memCacheValid = true;
		} catch (err) {
			this._lastWriteMs = Date.now() - startedAt;
			log.error("Failed to persist cache:", formatError(err));
			void vscode.window.showWarningMessage(
				"OpenRouter Insights: Pricing updated but couldn't be saved. " +
					"Data may be lost after restart. Check disk space.",
			);
		}
	}

	/** Rebuild the in-memory lookup map and pre-built indices from cached data. */
	private rebuildLookup(data: CachedPricingData): void {
		this.lookup.clear();
		this._lowercasedIndex = undefined;
		this._valuesArray = undefined;
		for (const m of data.models) {
			this.lookup.set(m.id, m);
		}
	}

	/**
	 * Return the pre-built values array, lazily constructed.
	 * Used by FuzzyMatchDetector to avoid `[...this.lookup.values()]`
	 * on every poll cycle.
	 */
	getValues(): readonly ModelPricingInfo[] {
		this._valuesArray ??= [...this.lookup.values()];
		return this._valuesArray;
	}

	/**
	 * Return a lowercased-name → pricing lookup, lazily constructed.
	 * Used by findBestMatch to avoid per-model `.toLowerCase()` calls
	 * on every poll cycle (300+ models × 2 calls).
	 */
	getLowercasedIndex(): Map<string, ModelPricingInfo> {
		this._lowercasedIndex ??= new Map(this.getValues().map((m) => [m.name.toLowerCase(), m]));
		return this._lowercasedIndex;
	}

	/** True when cached data is missing or older than the configured TTL. */
	isStale(): boolean {
		const cached = this.get();
		if (!cached) {
			return true;
		}
		const age = Date.now() - new Date(cached.fetchedAt).getTime();
		const maxAge = this._getMaxAgeMs();
		return age > maxAge;
	}

	/** How long ago the cache was last updated (human-readable). */
	age(): string {
		const cached = this.get();
		if (!cached) {
			return "never";
		}
		const diffMs = Date.now() - new Date(cached.fetchedAt).getTime();
		const mins = Math.floor(diffMs / 60000);
		if (mins < 1) {
			return "just now";
		}
		if (mins < 60) {
			return `${mins}m ago`;
		}
		const hours = Math.floor(mins / 60);
		if (hours < 24) {
			return `${hours}h ago`;
		}
		return `${Math.floor(hours / 24)}d ago`;
	}

	/**
	 * Return the raw `fetchedAt` ISO timestamp from the cache, or undefined
	 * when the cache is absent. Callers use this for stable cache keys
	 * (avoiding locale-formatted strings that change every minute).
	 */
	fetchedAt(): string | undefined {
		return this.get()?.fetchedAt;
	}

	/** Clear the in-memory and persisted cache. Irreversible. */
	async clear(): Promise<void> {
		this.lookup.clear();
		this._lowercasedIndex = undefined;
		this._valuesArray = undefined;
		this._memCache = undefined;
		this._memCacheValid = false;
		try {
			await this.ctx.globalState.update(CACHE_KEY, undefined);
			log.info("PricingCache: cleared");
		} catch (err) {
			log.error("PricingCache: clear failed:", formatError(err));
		}
	}

	/**
	 * Return diagnostic information about the cache for display.
	 * Used by the "Show Cache Info" command.
	 *
	 * Exposes pagination truncation as a first-class data-health signal
	 * so a page-cap partial catalog is distinguishable from a
	 * complete one.
	 */
	cacheInfo(): {
		age: string;
		modelCount: number;
		sizeEstimate: string;
		lastReadMs: number;
		lastWriteMs: number;
		lastSerializedBytes: number;
		ttlHours: number;
		stale: boolean;
		truncated?: boolean;
		truncationReason?: string;
	} {
		const cached = this.get();
		const modelCount = cached?.models.length ?? 0;
		const sizeEstimate =
			this._lastSerializedBytes > 0
				? `${(this._lastSerializedBytes / 1024).toFixed(1)} KB`
				: "0 KB";
		const truncated = cached?.pagination?.truncated ?? cached?.truncated ?? false;
		return {
			age: this.age(),
			modelCount,
			sizeEstimate,
			ttlHours: this._getTtlHours(),
			stale: this.isStale(),
			lastReadMs: this._lastReadMs,
			lastWriteMs: this._lastWriteMs,
			lastSerializedBytes: this._lastSerializedBytes,
			truncated,
			truncationReason: truncated ? cached?.pagination?.reason : undefined,
		};
	}

	/** Read the configured cache TTL in hours, clamped. */
	private _getTtlHours(): number {
		return this.config.cacheTtlHours;
	}

	/** Compute the max cache age in milliseconds from config. */
	private _getMaxAgeMs(): number {
		return this._getTtlHours() * 60 * 60 * 1000;
	}
}

/** Returns true if the string parses to a valid, non-NaN Date. */
function isValidDate(s: string): boolean {
	const d = new Date(s);
	return !Number.isNaN(d.getTime());
}
