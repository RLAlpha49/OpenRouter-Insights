/**
 * Unit tests for ProviderSortService — endpoint fetching, override
 * computation, caching, and per-model failure isolation.
 */

import { describe, it, expect, vi } from "vitest";
import { ProviderSortService } from "../../api/clients/providerSortService";
import type { HttpClient } from "../../api/transport/httpClient";
import { BLEND } from "../../models/domain";

function jsonResponse(body: unknown): Response {
	const h = new Headers();
	h.set("Content-Type", "application/json");
	return new Response(JSON.stringify(body), { status: 200, headers: h });
}

function clientFor(handler: (_url: string) => Response): HttpClient {
	return { fetch: async (url: string | URL | Request) => handler(String(url)) };
}

const endpointsBody = {
	data: {
		id: "vendor/model",
		name: "Vendor: Model",
		endpoints: [
			{
				provider_name: "Cheap",
				tag: "cheap",
				pricing: { prompt: "0.00000025", completion: "0.00000095" },
				status: 0,
				uptime_last_30m: 100,
				latency_last_30m: null,
				throughput_last_30m: null,
			},
			{
				provider_name: "Pricey",
				tag: "pricey",
				pricing: { prompt: "0.0000025", completion: "0.00001" },
				status: 0,
				uptime_last_30m: 100,
				latency_last_30m: null,
				throughput_last_30m: null,
			},
		],
	},
};

describe("ProviderSortService", () => {
	it("applies price override for tracked ids", async () => {
		const seenUrls: string[] = [];
		const svc = new ProviderSortService();
		const client = clientFor((url) => {
			seenUrls.push(url);
			return jsonResponse(endpointsBody);
		});
		const overrides = await svc.resolveOverrides(
			["vendor/model"],
			"price",
			client,
			"https://openrouter.ai/api/v1/models",
			BLEND,
		);
		const o = overrides.get("vendor/model");
		expect(o).toBeDefined();
		expect(o?.topProviderName).toBe("Cheap");
		expect(o?.topProviderId).toBe("cheap");
		expect(o?.perMillion.prompt).toBeCloseTo(0.25);
		expect(o?.perMillion.completion).toBeCloseTo(0.95);
		expect(o?.blendedRate).toBeGreaterThan(0);
		expect(seenUrls[0]).toContain("/api/v1/models/vendor/model/endpoints");
	});

	it("returns empty map for default sort without fetching", async () => {
		const svc = new ProviderSortService();
		const fetchSpy = vi.fn();
		const client: HttpClient = { fetch: fetchSpy };
		const overrides = await svc.resolveOverrides(
			["vendor/model"],
			"default",
			client,
			"https://x/api/v1/models",
			BLEND,
		);
		expect(overrides.size).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("skips a failing model without rejecting", async () => {
		const svc = new ProviderSortService();
		const client: HttpClient = { fetch: async () => new Response("nope", { status: 500 }) };
		const overrides = await svc.resolveOverrides(
			["bad/model"],
			"price",
			client,
			"https://x/api/v1/models",
			BLEND,
		);
		expect(overrides.size).toBe(0);
	});

	it("caches endpoint responses within TTL", async () => {
		let calls = 0;
		const svc = new ProviderSortService();
		const client = clientFor(() => {
			calls++;
			return jsonResponse(endpointsBody);
		});
		await svc.resolveOverrides(["vendor/model"], "price", client, "https://x/api/v1/models", BLEND);
		await svc.resolveOverrides(["vendor/model"], "price", client, "https://x/api/v1/models", BLEND);
		expect(calls).toBe(1);
	});

	it("strips virtual variants before lookup and keys results by requested id", async () => {
		const seenUrls: string[] = [];
		const svc = new ProviderSortService();
		const client = clientFor((url) => {
			seenUrls.push(url);
			return jsonResponse(endpointsBody);
		});
		const overrides = await svc.resolveOverrides(
			["vendor/model:nitro"],
			"price",
			client,
			"https://x/api/v1/models",
			BLEND,
		);
		expect(seenUrls[0]).toContain("/models/vendor/model/endpoints");
		expect(overrides.has("vendor/model:nitro")).toBe(true);
	});

	it("clearCache forces a refetch", async () => {
		let calls = 0;
		const svc = new ProviderSortService();
		const client = clientFor(() => {
			calls++;
			return jsonResponse(endpointsBody);
		});
		await svc.resolveOverrides(["vendor/model"], "price", client, "https://x/api/v1/models", BLEND);
		svc.clearCache();
		await svc.resolveOverrides(["vendor/model"], "price", client, "https://x/api/v1/models", BLEND);
		expect(calls).toBe(2);
	});

	it("no override when selection returns nothing (all metrics null for throughput)", async () => {
		const svc = new ProviderSortService();
		const client = clientFor(() => jsonResponse(endpointsBody));
		const overrides = await svc.resolveOverrides(
			["vendor/model"],
			"throughput",
			client,
			"https://x/api/v1/models",
			BLEND,
		);
		expect(overrides.size).toBe(0);
	});
});
