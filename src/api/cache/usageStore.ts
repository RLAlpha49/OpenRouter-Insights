/**
 * UsageCache — mutable store for OpenRouter usage/credits data.
 * Lives in-memory for the session lifetime; not persisted to disk.
 *
 * Implements a simple age-based staleness check independent of the
 * pricing cache. Callers should check isStale() before fetching and
 * use set() to update.
 */

import type { UsageStats } from "../../types-usage";
import { isValidUsageFetchedAt } from "../../types-usage";

/** Maximum age before usage data is considered stale (5 minutes). */
const USAGE_MAX_AGE_MS = 5 * 60 * 1000;

export interface IUsageStore {
	/** Get the current usage data, or undefined if not yet loaded. */
	get(): UsageStats | undefined;
	/** Replace the current usage data. */
	set(_usage: UsageStats): void;
	/** Clear the cache (e.g., API key removed). */
	clear(): void;
	/** Millisecond age of the cached data. */
	ageMs(): number;
	/** Whether the cache is stale (>5 minutes old) or not loaded. */
	isStale(): boolean;
	/** Clear all in-memory usage and detail state. */
	clearDetails?(): void;
}

export class UsageCache implements IUsageStore {
	private _data: UsageStats | undefined;

	get(): UsageStats | undefined {
		return this._data;
	}

	set(usage: UsageStats): void {
		// Fail closed on malformed timestamps: a usage snapshot with
		// an invalid `fetchedAt` must not be treated as fresh. Rejecting it
		// here keeps `ageMs()`/`isStale()` from ever seeing a NaN age.
		if (!isValidUsageFetchedAt(usage.fetchedAt)) {
			this._data = undefined;
			return;
		}
		this._data = usage;
	}

	clear(): void {
		this._data = undefined;
	}

	clearDetails(): void {
		if (!this._data) return;
		const baseline = { ...this._data };
		delete baseline.dailyUsageHistory;
		delete baseline.perKeyActivityHistory;
		delete baseline.analytics;
		delete baseline.analyticsUnavailableReason;
		delete baseline.detailState;
		this._data = {
			...baseline,
			dailyUsageHistory: null,
			perKeyActivityHistory: null,
			analytics: null,
			analyticsUnavailableReason: "disabled",
			detailState: { status: "notLoaded", lastAttemptAt: undefined },
		};
	}

	ageMs(): number {
		if (!this._data) return Infinity;
		const fetchedAt = new Date(this._data.fetchedAt).getTime();
		// Invalid timestamps fail closed as stale (Infinity) instead of NaN.
		if (Number.isNaN(fetchedAt)) return Infinity;
		return Date.now() - fetchedAt;
	}

	isStale(): boolean {
		if (!this._data) return true;
		return this.ageMs() > USAGE_MAX_AGE_MS;
	}
}
