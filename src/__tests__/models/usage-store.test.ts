/**
 * Unit tests for UsageCache — timestamp validation fail-closed behavior.
 */

import { describe, it, expect } from "vitest";
import { UsageCache } from "../../api/cache/usageStore";
import type { UsageStats } from "../../types-usage";

function makeUsageStats(fetchedAt: string): UsageStats {
	return {
		mode: "regular",
		isManagementKey: false,
		capabilities: {
			keys: "notApplicable",
			credits: "notApplicable",
			activity: "notApplicable",
			perKeyActivity: "notApplicable",
			analytics: "notApplicable",
			keyManagement: "notApplicable",
		},
		totalUsed: 0,
		dailyUsage: 0,
		weeklyUsage: 0,
		monthlyUsage: 0,
		limit: null,
		limitRemaining: null,
		limitReset: null,
		isFreeTier: false,
		usagePercent: null,
		allKeys: null,
		selectedKeyHash: null,
		accountCredits: null,
		fetchedAt,
	};
}

describe("UsageCache: timestamp validation", () => {
	it("stores valid usage data", () => {
		const cache = new UsageCache();
		cache.set(makeUsageStats(new Date().toISOString()));
		expect(cache.get()).toBeDefined();
		expect(cache.isStale()).toBe(false);
	});

	it("fails closed on an invalid fetchedAt (not a date)", () => {
		const cache = new UsageCache();
		cache.set(makeUsageStats("not-a-date"));
		expect(cache.get()).toBeUndefined();
		expect(cache.isStale()).toBe(true);
	});

	it("fails closed on an empty fetchedAt", () => {
		const cache = new UsageCache();
		cache.set(makeUsageStats(""));
		expect(cache.get()).toBeUndefined();
		expect(cache.isStale()).toBe(true);
	});

	it("returns Infinity age for invalid timestamps", () => {
		const cache = new UsageCache();
		cache.set(makeUsageStats("garbage"));
		expect(cache.ageMs()).toBe(Infinity);
	});

	it("returns a finite age for valid timestamps", () => {
		const cache = new UsageCache();
		cache.set(makeUsageStats(new Date(Date.now() - 10_000).toISOString()));
		expect(cache.ageMs()).toBeGreaterThan(0);
		expect(Number.isFinite(cache.ageMs())).toBe(true);
	});

	it("is stale when empty", () => {
		const cache = new UsageCache();
		expect(cache.isStale()).toBe(true);
		expect(cache.ageMs()).toBe(Infinity);
	});

	it("is stale after the five-minute freshness window", () => {
		const cache = new UsageCache();
		cache.set(makeUsageStats(new Date(Date.now() - 5 * 60 * 1000 - 1).toISOString()));
		expect(cache.isStale()).toBe(true);
	});

	it("clears data", () => {
		const cache = new UsageCache();
		cache.set(makeUsageStats(new Date().toISOString()));
		cache.clear();
		expect(cache.get()).toBeUndefined();
		expect(cache.isStale()).toBe(true);
	});
});
