/**
 * Unit tests for provider-sort selection — mirrors OpenRouter's
 * provider routing preferences against per-model endpoint data.
 */

import { describe, it, expect } from "vitest";
import {
	selectProviderEndpoint,
	stripVirtualVariant,
	type ProviderEndpoint,
} from "../../api/clients/providerSort";

function ep(overrides: Partial<ProviderEndpoint>): ProviderEndpoint {
	return {
		providerName: "P",
		tag: "p",
		pricing: { prompt: 1, completion: 2 },
		status: 0,
		uptimeLast30m: 100,
		throughputLast30m: null,
		latencyLast30m: null,
		...overrides,
	};
}

describe("selectProviderEndpoint", () => {
	it("returns undefined for default sort", () => {
		const eps = [ep({})];
		expect(selectProviderEndpoint(eps, "default")).toBeUndefined();
	});

	it("returns undefined for empty list", () => {
		expect(selectProviderEndpoint([], "price")).toBeUndefined();
	});

	it("price picks cheapest prompt+completion among active", () => {
		const eps = [
			ep({ providerName: "A", pricing: { prompt: 3, completion: 3 } }),
			ep({ providerName: "B", pricing: { prompt: 1, completion: 1 } }),
			ep({ providerName: "C", status: -5, pricing: { prompt: 0, completion: 0 } }),
		];
		expect(selectProviderEndpoint(eps, "price")?.providerName).toBe("B");
	});

	it("price breaks ties by list order", () => {
		const eps = [
			ep({ providerName: "First", pricing: { prompt: 1, completion: 1 } }),
			ep({ providerName: "Second", pricing: { prompt: 1, completion: 1 } }),
		];
		expect(selectProviderEndpoint(eps, "price")?.providerName).toBe("First");
	});

	it("price ignores endpoints with missing prices", () => {
		const eps = [
			ep({ providerName: "Bad", pricing: { prompt: Number.NaN, completion: 0 } }),
			ep({ providerName: "Good", pricing: { prompt: 2, completion: 2 } }),
		];
		expect(selectProviderEndpoint(eps, "price")?.providerName).toBe("Good");
	});

	it("throughput picks highest metric among uptime>=99 active endpoints", () => {
		const eps = [
			ep({ providerName: "Slow", throughputLast30m: 10 }),
			ep({ providerName: "Fast", throughputLast30m: 50, uptimeLast30m: 99.5 }),
			ep({ providerName: "Unreliable", throughputLast30m: 99, uptimeLast30m: 90 }),
			ep({ providerName: "Inactive", status: -5, throughputLast30m: 200 }),
		];
		expect(selectProviderEndpoint(eps, "throughput")?.providerName).toBe("Fast");
	});

	it("throughput falls back to undefined when all metrics null", () => {
		const eps = [ep({}), ep({ providerName: "Q" })];
		expect(selectProviderEndpoint(eps, "throughput")).toBeUndefined();
	});

	it("latency picks lowest metric among uptime>=99 active endpoints", () => {
		const eps = [
			ep({ providerName: "Laggy", latencyLast30m: 2 }),
			ep({ providerName: "Snappy", latencyLast30m: 0.4, uptimeLast30m: 100 }),
			ep({ providerName: "Down", latencyLast30m: 0.1, uptimeLast30m: 50 }),
		];
		expect(selectProviderEndpoint(eps, "latency")?.providerName).toBe("Snappy");
	});

	it("latency falls back to undefined when no candidate qualifies", () => {
		const eps = [ep({ latencyLast30m: null })];
		expect(selectProviderEndpoint(eps, "latency")).toBeUndefined();
	});
});

describe("stripVirtualVariant", () => {
	it("strips :nitro/:floor/:exacto suffixes", () => {
		expect(stripVirtualVariant("a/b:nitro")).toBe("a/b");
		expect(stripVirtualVariant("a/b:floor")).toBe("a/b");
		expect(stripVirtualVariant("a/b:exacto")).toBe("a/b");
	});

	it("keeps :free and plain ids untouched", () => {
		expect(stripVirtualVariant("a/b:free")).toBe("a/b:free");
		expect(stripVirtualVariant("a/b")).toBe("a/b");
	});
});
