import { describe, it, expect } from "vitest";
import type { HttpClient } from "../../api/transport/httpClient";
import {
	ANALYTICS_ROW_BUDGET,
	clearAnalyticsCache,
	fetchModelSpendBreakdown,
	setCredentialGeneration,
} from "../../api/clients/analyticsService";

import { beforeEach, vi } from "vitest";

beforeEach(() => {
	clearAnalyticsCache();
	setCredentialGeneration(0);
	vi.useRealTimers();
});

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("fetchModelSpendBreakdown", () => {
	it("coalesces identical in-flight requests", async () => {
		let calls = 0;
		let release: (() => void) | undefined;
		const client: HttpClient = {
			fetch: async () => {
				calls++;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return jsonResponse({ data: [] });
			},
		};

		const first = fetchModelSpendBreakdown("sk-coalesced", 30, client);
		const second = fetchModelSpendBreakdown("sk-coalesced", 30, client);
		await vi.waitFor(() => expect(calls).toBe(1));
		release?.();

		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
	});

	it("reuses a recent successful result", async () => {
		let calls = 0;
		const client: HttpClient = {
			fetch: async () => {
				calls++;
				return jsonResponse({ data: [] });
			},
		};

		await fetchModelSpendBreakdown("sk-cached", 30, client);
		await fetchModelSpendBreakdown("sk-cached", 30, client);

		expect(calls).toBe(1);
	});

	it("separates cached results by lookback range", async () => {
		let calls = 0;
		const client: HttpClient = {
			fetch: async () => {
				calls++;
				return jsonResponse({ data: [] });
			},
		};

		await fetchModelSpendBreakdown("sk-range", 7, client);
		await fetchModelSpendBreakdown("sk-range", 30, client);

		expect(calls).toBe(2);
	});

	it("uses current analytics metrics and normalizes token fields", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const client: HttpClient = {
			fetch: async (_url, init) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return jsonResponse({
					data: {
						data: [
							{
								model: "openai/gpt-4o",
								total_usage: "1.25",
								request_count: "3",
								tokens_total: "100",
								tokens_prompt: "80",
								tokens_completion: "20",
								cache_hit_rate: 0.5,
							},
						],
						metadata: { query_time_ms: 1, row_count: 1, truncated: false },
					},
				});
			},
		};

		const result = await fetchModelSpendBreakdown("sk-or-management", 30, client);
		const metrics = requestBody?.metrics as string[];

		expect(metrics).toEqual([
			"total_usage",
			"request_count",
			"tokens_total",
			"tokens_prompt",
			"tokens_completion",
			"cache_hit_rate",
		]);
		expect(result.modelBreakdown[0]).toMatchObject({
			modelId: "openai/gpt-4o",
			totalUsage: 1.25,
			requestCount: 3,
			promptTokens: 80,
			completionTokens: 20,
			cacheHitRate: 50,
		});
		expect(
			Date.parse(String((requestBody?.time_range as { end: string }).end)),
		).toBeLessThanOrEqual(Date.now());
	});

	it("requests only the dashboard row budget and reports a complete result", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const client: HttpClient = {
			fetch: async (_url, init) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return jsonResponse({
					data: {
						data: [{ model: "openai/gpt-4o", total_usage: 1, request_count: 2, tokens_total: 10 }],
						metadata: { row_count: 1, truncated: false },
					},
				});
			},
		};

		const result = await fetchModelSpendBreakdown("sk-budget", 30, client);

		expect(requestBody?.limit).toBe(ANALYTICS_ROW_BUDGET);
		expect(result.rowLimit).toBe(ANALYTICS_ROW_BUDGET);
		expect(result.truncated).toBe(false);
	});

	it("marks a vendor-truncated response as incomplete", async () => {
		const client: HttpClient = {
			fetch: async () =>
				jsonResponse({
					data: {
						data: [{ model: "openai/gpt-4o", total_usage: 1, request_count: 2 }],
						metadata: { truncated: true },
					},
				}),
		};

		const result = await fetchModelSpendBreakdown("sk-truncated", 30, client);

		expect(result.truncated).toBe(true);
	});

	it("marks a response that fills the row budget as incomplete", async () => {
		const rows = Array.from({ length: ANALYTICS_ROW_BUDGET }, (_value, index) => ({
			model: `vendor/model-${index}`,
			total_usage: 1,
			request_count: 1,
			tokens_total: 10,
			cache_hit_rate: 0.5,
		}));
		const client: HttpClient = { fetch: async () => jsonResponse({ data: rows }) };

		const result = await fetchModelSpendBreakdown("sk-capped", 30, client);

		expect(result.modelBreakdown).toHaveLength(ANALYTICS_ROW_BUDGET);
		expect(result.truncated).toBe(true);
		expect(result.overallCacheHitRate).toBeCloseTo(50);
	});

	it("keeps usable rows and reports dropped analytics rows in contract health", async () => {
		const client: HttpClient = {
			fetch: async () =>
				jsonResponse({
					data: [
						{ model: "openai/gpt-4o", total_usage: 2, request_count: 4, tokens_total: 100 },
						{ total_usage: 9, request_count: 9 },
					],
				}),
		};

		const result = await fetchModelSpendBreakdown("sk-partial", 30, client);

		expect(result.modelBreakdown).toHaveLength(1);
		expect(result.totalSpend).toBe(2);
		expect(result.contractHealth).toMatchObject({ status: "partial", issueCount: 1 });
		expect(result.contractHealth?.issues[0].path).toBe("data[1]");
	});

	it("invalidates a cached result when the credential generation changes", async () => {
		let calls = 0;
		const client: HttpClient = {
			fetch: async () => {
				calls++;
				return jsonResponse({ data: [] });
			},
		};

		await fetchModelSpendBreakdown("sk-rotate", 30, client);
		expect(calls).toBe(1);

		setCredentialGeneration(1);

		await fetchModelSpendBreakdown("sk-rotate", 30, client);
		expect(calls).toBe(2);
	});

	it("does not reuse an in-flight request after a credential change", async () => {
		let calls = 0;
		const resolvers: Array<() => void> = [];
		const client: HttpClient = {
			fetch: async () => {
				calls++;
				await new Promise<void>((resolve) => {
					resolvers.push(resolve);
				});
				return jsonResponse({ data: [] });
			},
		};

		const first = fetchModelSpendBreakdown("sk-rotate", 30, client);

		// Rotate the credential while the first request is still in flight. The
		// in-flight map is keyed by credential generation, so the second call
		// must not reuse the previous request and must hit the network again.
		setCredentialGeneration(1);

		const second = fetchModelSpendBreakdown("sk-rotate", 30, client);
		await vi.waitFor(() => expect(calls).toBe(2));

		resolvers.forEach((resolve) => resolve());
		await Promise.all([first, second]);
	});
});
