/**
 * Integration tests for the usage service.
 * Uses fake HttpClient returning canned responses.
 */

import { describe, it, expect, vi } from "vitest";
import type { HttpClient } from "../../api/transport/httpClient";
import { ANALYTICS_ROW_BUDGET } from "../../api/clients/analyticsService";
import { createApiKey, deleteApiKey, updateApiKey } from "../../api/clients/usageKeyManagement";
import { getEndpointRetryPolicy } from "../../api/endpoint/endpointCatalog";

function jsonResponse(body: unknown, status = 200): Response {
	const h = new Headers({ "Content-Type": "application/json" });
	return new Response(JSON.stringify(body), { status, headers: h });
}

function errorResponse(status: number): Response {
	return new Response("Error", { status, statusText: "Error" });
}

const regularKeyResponse = {
	data: {
		label: "My Key",
		usage: 1.5,
		usage_daily: 0.05,
		usage_weekly: 0.3,
		usage_monthly: 1.2,
		limit: 10,
		limit_remaining: 8.5,
		limit_reset: null,
		is_free_tier: false,
		is_management_key: false,
	},
};

const managementKeyResponse = {
	data: {
		label: "Management",
		usage: 5,
		usage_daily: 0.2,
		usage_weekly: 1.5,
		usage_monthly: 4,
		limit: null,
		limit_remaining: null,
		limit_reset: null,
		is_free_tier: false,
		is_management_key: true,
	},
};

const keysListResponse = {
	data: [
		{
			hash: "hash-abc",
			name: "Key 1",
			label: "Key 1",
			disabled: false,
			usage: 3,
			usage_daily: 0.1,
			usage_weekly: 1,
			usage_monthly: 2.5,
			limit: 10,
			limit_remaining: 7,
			limit_reset: null,
		},
	],
};

const creditsResponse = {
	data: {
		total_credits: 100,
		total_usage: 25,
	},
};

const activityResponse = {
	data: [
		{ date: "2026-07-28", usage: 0.1, requests: 5 },
		{ date: "2026-07-29", usage: 0.15, requests: 8 },
	],
};

const perKeyActivityResponse = {
	data: [{ date: "2026-07-29", usage: 0.07, requests: 3 }],
};

const analyticsResponse = {
	data: [
		{
			model: "openai/gpt-4o",
			total_usage: 0.4,
			request_count: 4,
			tokens_total: 1000,
			tokens_prompt: 700,
			tokens_completion: 300,
			cache_hit_rate: 0.25,
		},
	],
};

import { fetchUsageStats } from "../../api/clients/usageService";
import { fetchUsageDetails } from "../../api/clients/usageDetailsService";

describe("fetchUsageStats", () => {
	it("returns regular key stats", async () => {
		const client: HttpClient = {
			fetch: async () => jsonResponse(regularKeyResponse),
		};
		const result = await fetchUsageStats("sk-test", undefined, client);
		expect(result.mode).toBe("regular");
		expect(result.totalUsed).toBe(1.5);
		expect(result.dailyUsage).toBe(0.05);
		expect(result.limit).toBe(10);
		expect(result.usagePercent).toBe(15);
		expect(result.capabilities.analytics).toBe("notApplicable");
	});

	it("uses reset-period remaining credits instead of all-time usage", async () => {
		const client: HttpClient = {
			fetch: async () =>
				jsonResponse({
					data: {
						...regularKeyResponse.data,
						usage: 15.5,
						limit: 15,
						limit_remaining: 15,
						limit_reset: "monthly",
					},
				}),
		};
		const result = await fetchUsageStats("sk-test", undefined, client);

		expect(result.totalUsed).toBe(15.5);
		expect(result.usagePercent).toBe(0);
	});

	it("returns management key stats with keys list", async () => {
		const requestedPaths: string[] = [];
		const client: HttpClient = {
			fetch: async (url) => {
				requestedPaths.push(new URL(url).pathname);
				if (requestedPaths.length === 1) return jsonResponse(managementKeyResponse);
				if (url.endsWith("/keys")) return jsonResponse(keysListResponse);
				return jsonResponse(creditsResponse);
			},
		};
		const result = await fetchUsageStats("sk-mgmt", undefined, client);
		expect(result.mode).toBe("management");
		expect(result.allKeys).toHaveLength(1);
		expect(result.allKeys![0].hash).toBe("hash-abc");
		expect(result.capabilities.keys).toBe("available");
		expect(result.capabilities.credits).toBe("available");
		expect(requestedPaths).not.toContain("/api/v1/activity");
	});

	it("asserts the complete management usage enrichment contract", async () => {
		const requests: Array<{ path: string; method: string; body?: string }> = [];
		const client: HttpClient = {
			fetch: async (url, init) => {
				const parsed = new URL(url);
				requests.push({
					path: parsed.pathname,
					method: init?.method ?? "GET",
					body: typeof init?.body === "string" ? init.body : undefined,
				});
				if (parsed.pathname.endsWith("/key")) return jsonResponse(managementKeyResponse);
				if (parsed.pathname.endsWith("/keys")) return jsonResponse(keysListResponse);
				if (parsed.pathname.endsWith("/credits")) return jsonResponse(creditsResponse);
				if (parsed.pathname.endsWith("/analytics/query")) return jsonResponse(analyticsResponse);
				if (parsed.searchParams.get("api_key_hash") === "hash-abc")
					return jsonResponse(perKeyActivityResponse);
				return jsonResponse(activityResponse);
			},
		};

		const result = await fetchUsageDetails(
			"sk-mgmt",
			undefined,
			{ includeAnalytics: true },
			client,
			undefined,
			undefined,
			undefined,
			undefined,
		);

		expect(result.dailyUsageHistory).toHaveLength(3);
		expect(result.dailyUsageHistory?.[0]).toMatchObject({ date: "2026-07-28", usage: 0.1 });
		expect(result.perKeyActivityHistory?.["hash-abc"]).toHaveLength(2);
		expect(result.perKeyActivityHistory?.["hash-abc"]?.[0]).toMatchObject({ usage: 0.07 });
		expect(result.analytics?.modelBreakdown[0]).toMatchObject({
			modelId: "openai/gpt-4o",
			totalUsage: 0.4,
		});
		expect(requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "/api/v1/key", method: "GET" }),
				expect.objectContaining({ path: "/api/v1/keys", method: "GET" }),
				expect.objectContaining({ path: "/api/v1/credits", method: "GET" }),
				expect.objectContaining({ path: "/api/v1/activity", method: "GET" }),
				expect.objectContaining({ path: "/api/v1/analytics/query", method: "POST" }),
				expect.objectContaining({ path: "/api/v1/activity", method: "GET" }),
			]),
		);
		const perKeyRequest = requests.find(
			(request) => request.path === "/api/v1/activity" && request !== requests[3],
		);
		expect(perKeyRequest).toBeDefined();
		expect(requests.filter((request) => request.path === "/api/v1/activity")).toHaveLength(2);
		const analyticsRequest = requests.find((request) => request.path.endsWith("/analytics/query"));
		expect(JSON.parse(analyticsRequest?.body ?? "{}")).toMatchObject({
			dimensions: ["model"],
			limit: ANALYTICS_ROW_BUDGET,
		});
	});

	it("keeps primary details when optional analytics fails", async () => {
		const client: HttpClient = {
			fetch: async (url, init) => {
				const parsed = new URL(url);
				if (parsed.pathname.endsWith("/key")) return jsonResponse(managementKeyResponse);
				if (parsed.pathname.endsWith("/keys")) return jsonResponse(keysListResponse);
				if (parsed.pathname.endsWith("/credits")) return jsonResponse(creditsResponse);
				if (parsed.pathname.endsWith("/analytics/query")) return errorResponse(403);
				if (parsed.searchParams.has("api_key_hash")) return jsonResponse(perKeyActivityResponse);
				if (init?.method === "GET") return jsonResponse(activityResponse);
				return jsonResponse(activityResponse);
			},
		};

		const result = await fetchUsageDetails(
			"sk-mgmt",
			undefined,
			{ includeAnalytics: true },
			client,
			undefined,
			undefined,
			undefined,
			undefined,
		);

		expect(result.allKeys).toHaveLength(1);
		expect(result.dailyUsageHistory).toHaveLength(3);
		expect(result.analytics).toBeNull();
		expect(result.analyticsUnavailableReason).toBe("managementKeyRequired");
		expect(result.endpointDiagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ endpoint: "analytics.query", errorClass: "permission" }),
			]),
		);
	});

	it("preserves the affected key in per-key activity diagnostics", async () => {
		const client: HttpClient = {
			fetch: async (url, init) => {
				const parsed = new URL(url);
				if (parsed.pathname.endsWith("/key")) return jsonResponse(managementKeyResponse);
				if (parsed.pathname.endsWith("/keys")) return jsonResponse(keysListResponse);
				if (parsed.pathname.endsWith("/credits")) return jsonResponse(creditsResponse);
				if (parsed.searchParams.has("api_key_hash")) return errorResponse(500);
				if (init?.method === "GET") return jsonResponse(activityResponse);
				return jsonResponse(activityResponse);
			},
		};

		const result = await fetchUsageDetails(
			"sk-mgmt",
			undefined,
			{ includeAnalytics: false },
			client,
			undefined,
			undefined,
			undefined,
			undefined,
		);

		expect(result.endpointDiagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ endpoint: "activity.list", resourceId: "hash-abc" }),
			]),
		);
	});

	it("surfaces partial contract health for a mixed management-key response", async () => {
		let call = 0;
		const client: HttpClient = {
			fetch: async () => {
				call++;
				if (call === 1) return jsonResponse(managementKeyResponse);
				if (call === 2)
					return jsonResponse({ data: [keysListResponse.data[0], { hash: "invalid" }] });
				if (call === 3) return jsonResponse(creditsResponse);
				return jsonResponse(activityResponse);
			},
		};
		const result = await fetchUsageStats("sk-mgmt", undefined, client);
		expect(result.allKeys).toHaveLength(1);
		expect(result.contractHealth?.["keys.list"]).toMatchObject({
			status: "partial",
			issueCount: 1,
		});
	});

	it("validates key-management response contracts", async () => {
		const client: HttpClient = {
			fetch: async (_url, init) => {
				if (init?.method === "POST") return jsonResponse({ data: { hash: "missing-key" } });
				return jsonResponse({ data: { success: true } });
			},
		};
		await expect(createApiKey("sk-mgmt", { name: "New key" }, client)).rejects.toMatchObject({
			errorClass: "malformed-response",
		});
	});

	it("throws on 401", async () => {
		const client: HttpClient = {
			fetch: async () => errorResponse(401),
		};
		await expect(fetchUsageStats("sk-bad", undefined, client)).rejects.toThrow("OpenRouter API");
	});

	it("throws on network error after retries", async () => {
		const client: HttpClient = {
			fetch: async () => {
				throw new TypeError("fetch failed: ECONNREFUSED");
			},
		};
		await expect(fetchUsageStats("sk-test", undefined, client)).rejects.toThrow("OpenRouter API");
	});

	it("spends exactly the catalog retry budget on transient transport failures", async () => {
		let attempts = 0;
		const client: HttpClient = {
			fetch: async () => {
				attempts++;
				throw new TypeError("fetch failed: ECONNREFUSED");
			},
		};

		await expect(fetchUsageStats("sk-test", undefined, client)).rejects.toThrow("OpenRouter API");

		expect(attempts).toBe(getEndpointRetryPolicy("keys.current").maxRetries);
	}, 20_000);

	it("preserves the original transport error as the failure cause", async () => {
		const transportFailure = new TypeError("fetch failed: ECONNRESET");
		const client: HttpClient = {
			fetch: async () => {
				throw transportFailure;
			},
		};

		const err = (await fetchUsageStats("sk-test", undefined, client).catch(
			(error: unknown) => error,
		)) as Error & { cause?: unknown; _kind?: string };

		expect(err._kind).toBe("transient");
		const wrapper = err.cause as Error & { cause?: unknown; statusCode?: number };
		expect(wrapper).toBeInstanceOf(Error);
		expect(wrapper.statusCode).toBe(0);
		expect(wrapper.message).toContain("keys.current");
		expect(wrapper.cause).toBe(transportFailure);
	});

	it("uses the endpoint catalog method for key-management requests", async () => {
		const requests: Array<{ path: string; method: string }> = [];
		const client: HttpClient = {
			fetch: async (url, init) => {
				requests.push({ path: new URL(url).pathname, method: init?.method ?? "GET" });
				if (init?.method === "DELETE") return jsonResponse({ data: { success: true } });
				return jsonResponse({
					data: {
						hash: "hash-abc",
						name: "Renamed",
						label: "Renamed",
						disabled: false,
						limit: null,
						limit_remaining: null,
						limit_reset: null,
					},
				});
			},
		};
		await updateApiKey("sk-mgmt", "hash-abc", { name: "Renamed" }, client);
		await deleteApiKey("sk-mgmt", "hash-abc", client);

		expect(requests).toEqual([
			{ path: "/api/v1/keys/hash-abc", method: "PATCH" },
			{ path: "/api/v1/keys/hash-abc", method: "DELETE" },
		]);
	});

	it("stops optional management requests when cancellation occurs", async () => {
		const controller = new AbortController();
		let calls = 0;
		const client: HttpClient = {
			fetch: async (_url, init) => {
				calls++;
				if (calls === 1) return jsonResponse(managementKeyResponse);
				await new Promise<never>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
				throw new Error("unreachable");
			},
		};

		const pending = fetchUsageStats("sk-mgmt", undefined, client, undefined, controller.signal);
		await vi.waitFor(() => expect(calls).toBe(3));
		controller.abort();

		await expect(pending).rejects.toMatchObject({ cancelled: true });
		expect(calls).toBe(3);
	});

	it("parses the OpenRouter error envelope (error.type) for 402", async () => {
		const envelopeBody = JSON.stringify({
			error: { message: "Insufficient credits", type: "payment_required" },
		});
		const client: HttpClient = {
			fetch: async () =>
				new Response(envelopeBody, {
					status: 402,
					headers: { "Content-Type": "application/json" },
				}),
		};
		const err = await fetchUsageStats("sk-test", undefined, client).catch((e) => e);
		expect(err._code).toBe(402);
		expect(err._errorClass).toBe("insufficient-credit");
		expect(err._errorType).toBe("payment_required");
		expect(err._kind).toBe("permanent");
	});

	it("surfaces permission (403) distinctly from a generic failure", async () => {
		const client: HttpClient = {
			fetch: async () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
		};
		const err = await fetchUsageStats("sk-test", undefined, client).catch((e) => e);
		expect(err._code).toBe(403);
		expect(err._errorClass).toBe("permission");
		expect(err._errorType).toBe("permission");
		expect(err._kind).toBe("permanent");
	});

	it("keeps authenticated usage on the trusted OpenRouter host", async () => {
		let requestedUrl = "";
		const client: HttpClient = {
			fetch: async (url) => {
				requestedUrl = url;
				return jsonResponse(regularKeyResponse);
			},
		};
		await fetchUsageStats("sk-test", undefined, client, "https://untrusted.example/api/v1");
		expect(new URL(requestedUrl).origin).toBe("https://openrouter.ai");
	});

	it("preserves permission diagnostics for optional management endpoints", async () => {
		let call = 0;
		const client: HttpClient = {
			fetch: async () => {
				call++;
				if (call === 1) return jsonResponse(managementKeyResponse);
				if (call === 2) return errorResponse(403);
				if (call === 3) return jsonResponse(creditsResponse);
				return jsonResponse(activityResponse);
			},
		};
		const result = await fetchUsageStats("sk-mgmt", undefined, client);
		expect(result.capabilities.keys).toBe("permissionDenied");
		expect(result.endpointDiagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ endpoint: "keys.list", errorClass: "permission", status: 403 }),
			]),
		);
		expect(result.refreshSummary).toMatchObject({
			failedEndpoints: expect.arrayContaining(["keys.list"]),
			successfulEndpoints: expect.arrayContaining(["keys.current", "credits.get"]),
		});
	});
});

describe("fetchUsageStats authenticated-response safety", () => {
	it("rejects an oversized authenticated response before decoding", async () => {
		const client: HttpClient = {
			fetch: async () =>
				new Response("{}", {
					status: 200,
					headers: new Headers({
						"Content-Type": "application/json",
						"Content-Length": "999999999",
					}),
				}),
		};

		const err = (await fetchUsageStats("sk-test", undefined, client).catch((e) => e)) as {
			_errorClass?: string;
		};

		expect(err._errorClass).toBe("malformed-response");
	});

	it("rejects a non-JSON (HTML) authenticated response as malformed", async () => {
		const client: HttpClient = {
			fetch: async () =>
				new Response("<html><body>login required</body></html>", {
					status: 200,
					headers: new Headers({ "Content-Type": "text/html" }),
				}),
		};

		const err = (await fetchUsageStats("sk-test", undefined, client).catch((e) => e)) as {
			_errorClass?: string;
		};

		expect(err._errorClass).toBe("malformed-response");
	});
});
