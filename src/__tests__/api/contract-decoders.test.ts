import { describe, expect, it } from "vitest";
import {
	decodeActivityResponse,
	decodeAnalyticsResponse,
	decodeCreditsResponse,
	decodeEndpointResponse,
	decodeKeyResponse,
	decodeKeysResponse,
	decodeModelsResponse,
} from "../../api/contractDecoders";

const model = {
	id: "openai/gpt-4o",
	name: "OpenAI: GPT-4o",
	context_length: 128000,
	pricing: { prompt: "0.000001", completion: "0.000002" },
};

describe("OpenRouter contract decoders", () => {
	it("accepts models with optional fields omitted", () => {
		const decoded = decodeModelsResponse({ data: [model] });
		expect(decoded.status).toBe("valid");
		expect(decoded.value?.data).toHaveLength(1);
	});

	it("retains the complete description and omits obsolete model fields", () => {
		const description = "A complete model description that must not be shortened.";
		const decoded = decodeModelsResponse({
			data: [
				{
					...model,
					description,
					per_request_limits: { max_tokens: 1000 },
					quality_score: 0.9,
					benchmarks: [{ score: 1 }],
					performance: { latency: 10 },
				},
			],
		});

		expect(decoded.value?.data[0]).toMatchObject({ description });
		expect(decoded.value?.data[0]).toMatchObject({ description });
	});

	it("returns a partial model result when one entry is malformed", () => {
		const decoded = decodeModelsResponse({ data: [model, { id: "missing/pricing" }] });
		expect(decoded.status).toBe("partial");
		expect(decoded.value?.data).toHaveLength(1);
		expect(decoded.issues[0].path).toBe("data[1]");
	});

	it("rejects malformed required envelopes", () => {
		expect(decodeKeyResponse({ data: { label: "key" } }).status).toBe("invalid");
		expect(decodeCreditsResponse({ data: { total_credits: "bad" } }).status).toBe("invalid");
		expect(decodeActivityResponse({ data: [{ usage: 1 }] }).status).toBe("partial");
	});

	it("accepts both analytics response variants", () => {
		expect(decodeAnalyticsResponse({ data: [] }).status).toBe("valid");
		expect(
			decodeAnalyticsResponse({ data: { data: [], metadata: { truncated: true } } }).status,
		).toBe("valid");
	});

	it("normalizes analytics rows and preserves the response metadata", () => {
		const decoded = decodeAnalyticsResponse({
			data: {
				data: [
					{
						model: "openai/gpt-4o",
						total_usage: "1.25",
						request_count: "3",
						tokens_total: "100",
						tokens_prompt: 80,
						tokens_completion: 20,
						cache_hit_rate: 0.5,
					},
				],
				metadata: { query_time_ms: 5, row_count: 1, truncated: true },
			},
		});

		expect(decoded.status).toBe("valid");
		expect(decoded.value?.rows[0]).toEqual({
			model: "openai/gpt-4o",
			totalUsage: 1.25,
			requestCount: 3,
			tokensTotal: 100,
			promptTokens: 80,
			completionTokens: 20,
			cacheHitRate: 0.5,
		});
		expect(decoded.value?.metadata).toMatchObject({ truncated: true, rowCount: 1 });
	});

	it("drops analytics rows that cannot support spend calculations", () => {
		const decoded = decodeAnalyticsResponse({
			data: [
				{ model: "openai/gpt-4o", total_usage: 1, request_count: 2 },
				{ total_usage: 1, request_count: 2 },
				{ model: "anthropic/claude", request_count: 2 },
				null,
			],
		});

		expect(decoded.status).toBe("partial");
		expect(decoded.value?.rows).toHaveLength(1);
		expect(decoded.issues.map((issue) => issue.path)).toEqual(["data[1]", "data[2]", "data[3]"]);
		expect(decoded.issues[0].message).toContain("model");
		expect(decoded.issues[1].message).toContain("total_usage");
	});

	it("keeps optional analytics metrics nullable and reports unusable values", () => {
		const decoded = decodeAnalyticsResponse({
			data: [{ model: "openai/gpt-4o", total_usage: 1, request_count: 2, cache_hit_rate: "abc" }],
		});

		expect(decoded.status).toBe("partial");
		expect(decoded.value?.rows[0]).toMatchObject({ cacheHitRate: null, tokensTotal: null });
		expect(decoded.issues[0].path).toBe("data[0].cache_hit_rate");
	});

	it("normalizes numeric model pricing values through the endpoint contract", () => {
		const decoded = decodeEndpointResponse("models.list", {
			data: [{ ...model, pricing: { prompt: 0.000001, completion: 0.000002 } }],
		});
		expect(decoded.status).toBe("valid");
		expect(decoded.value?.data[0].pricing).toEqual({ prompt: 0.000001, completion: 0.000002 });
	});

	it("normalizes numeric strings in usage, credits, activity, and key responses", () => {
		const key = decodeKeyResponse({
			data: {
				label: "key",
				usage: "1.5",
				usage_daily: "0.5",
				usage_weekly: "1",
				usage_monthly: "1.5",
				limit: "10",
				limit_remaining: "8.5",
				limit_reset: null,
				is_free_tier: false,
			},
		});
		const credits = decodeCreditsResponse({ data: { total_credits: "10", total_usage: "2.5" } });
		const keys = decodeKeysResponse({
			data: [
				{
					hash: "hash",
					label: "key",
					name: "name",
					disabled: false,
					usage: "1",
					usage_daily: "1",
					usage_weekly: "1",
					usage_monthly: "1",
					limit: "4",
					limit_remaining: "3",
					limit_reset: null,
					created_at: "",
					updated_at: "",
				},
			],
		});
		const activity = decodeActivityResponse({
			data: [{ date: "2026-08-09", usage: "1.25", requests: "2" }],
		});

		expect(typeof key.value?.data.usage).toBe("number");
		expect(key.value?.data.limit).toBe(10);
		expect(credits.value?.data).toEqual({ total_credits: 10, total_usage: 2.5 });
		expect(keys.value?.data[0].limit_remaining).toBe(3);
		expect(activity.value?.data[0].usage).toBe(1.25);
	});

	it("decodes key-management responses by endpoint ID", () => {
		expect(
			decodeEndpointResponse("keys.create", {
				data: {
					key: "sk-new",
					hash: "hash",
					name: "New",
					label: "New",
					disabled: false,
					limit: null,
					limit_remaining: null,
					limit_reset: null,
				},
			}).status,
		).toBe("valid");
		expect(
			decodeEndpointResponse("keys.update", {
				data: {
					hash: "hash",
					name: "Renamed",
					label: "Renamed",
					disabled: false,
					limit: null,
					limit_remaining: null,
					limit_reset: null,
				},
			}).status,
		).toBe("valid");
		expect(decodeEndpointResponse("keys.delete", { data: { success: true } }).status).toBe("valid");
		expect(decodeEndpointResponse("keys.delete", { data: {} }).status).toBe("invalid");
	});

	it("drops malformed optional collection entries", () => {
		expect(
			decodeKeysResponse({ data: [{ hash: "a", label: "A", disabled: false }, null] }).status,
		).toBe("partial");
	});
});
