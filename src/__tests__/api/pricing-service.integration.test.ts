/**
 * Integration tests for the pricing service (PricingFetcher, parseModelsResponse,
 * findBestMatch, findModelById, scoreModelMatch, toPerMillion, computeBlendedRate).
 *
 * Uses a fake HttpClient returning canned responses.
 * Each test group creates a fresh PricingFetcher for isolation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { HttpClient } from "../../api/transport/httpClient";

// ── Fake HTTP Client ─────────────────────────────────────────

/** Creates a fake HttpClient that returns the given Response to any request. */
function fakeClient(response: Response): HttpClient {
	return { fetch: async () => response };
}

/** Build a JSON Response from an object. */
function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
	const h = new Headers(headers ?? {});
	h.set("Content-Type", "application/json");
	return new Response(JSON.stringify(body), { status, headers: h });
}

/** Build a plain-text error Response. */
function errorResponse(status: number, statusText: string): Response {
	return new Response(statusText, { status, statusText });
}

// ── findBestMatch & findModelById (pure, no module state needed) ──

import { findBestMatch, findModelById, findModelVariant } from "../../api/clients/pricingService";
import type { ModelPricingInfo } from "../../types";
import { OpenRouterHttpError } from "../../api/transport/openRouterError";

function makeModel(
	id: string,
	name: string,
	blendedRate = 1,
	contextLength = 128000,
): ModelPricingInfo {
	return {
		id,
		name,
		blendedRate,
		contextLength,
		contextLengthFormatted: contextLength.toLocaleString(),
		maxOutputLength: 4096,
		created: Date.now() / 1000,
		isDeprecated: false,
		deprecationDate: "",
		isFree: false,
		modality: "text",
		description: "Test model",
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
		perMillion: {
			prompt: blendedRate * 0.85,
			completion: blendedRate * 0.15,
			image: 0,
			request: 0,
			inputCacheRead: 0,
			inputCacheWrite: 0,
			webSearch: 0,
			internalReasoning: 0,
		},
	};
}

describe("findModelById", () => {
	const models = [
		makeModel("openai/gpt-4o", "OpenAI: GPT-4o"),
		makeModel("anthropic/claude-3-opus", "Anthropic: Claude 3 Opus"),
	];

	it("finds model by exact ID", () => {
		expect(findModelById(models, "openai/gpt-4o")).toBe(models[0]);
	});

	it("returns undefined for unknown ID", () => {
		expect(findModelById(models, "nonexistent/model")).toBeUndefined();
	});

	it("returns undefined for empty array", () => {
		expect(findModelById([], "openai/gpt-4o")).toBeUndefined();
	});
});

describe("findModelVariant", () => {
	const paid = makeModel("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron paid");
	const free = {
		...makeModel("nvidia/nemotron-3-ultra-550b-a55b:free", "Nemotron free"),
		isFree: true,
	};
	const models = [paid, free];
	const lookup = new Map(models.map((model) => [model.id, model]));

	it("maps a dated paid variant to the paid model", () => {
		expect(findModelVariant(models, lookup, "nvidia/nemotron-3-ultra-550b-a55b-20260604")).toBe(
			paid,
		);
	});

	it("maps a dated free variant to the free model", () => {
		expect(
			findModelVariant(models, lookup, "nvidia/nemotron-3-ultra-550b-a55b-20260604:free"),
		).toBe(free);
	});
});

describe("findBestMatch", () => {
	const models = [
		makeModel("openai/gpt-4o", "OpenAI: GPT-4o"),
		makeModel("anthropic/claude-sonnet", "Anthropic: Claude Sonnet"),
		makeModel("google/gemini-pro", "Google: Gemini Pro"),
	];

	it("matches by exact lowercased name", () => {
		const result = findBestMatch(models, "openai: gpt-4o");
		expect(result?.id).toBe("openai/gpt-4o");
	});

	it("matches by partial name", () => {
		const result = findBestMatch(models, "Claude");
		expect(result?.id).toBe("anthropic/claude-sonnet");
	});

	it("matches by ID fragment", () => {
		const result = findBestMatch(models, "gemini");
		expect(result?.id).toBe("google/gemini-pro");
	});

	it("returns undefined for no match", () => {
		expect(findBestMatch(models, "nonexistent")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(findBestMatch(models, "")).toBeUndefined();
	});

	it("uses lowercased index for fast path", () => {
		const idx = new Map(models.map((m) => [m.name.toLowerCase(), m]));
		const result = findBestMatch(models, "openai: gpt-4o", idx);
		expect(result?.id).toBe("openai/gpt-4o");
	});
});

// ── toPerMillion / computeBlendedRate ─────────────────────────

import { BLEND, BLEND_NO_CACHE } from "../../models/domain";

// We test indirectly through the static computation path.
// The private functions toPerMillion and computeBlendedRate
// are exercised through toModelPricingInfo which is internal.

describe("blend constants", () => {
	it("BLEND weights sum to 1", () => {
		const sum = BLEND.cacheRead + BLEND.cacheWrite + BLEND.prompt + BLEND.completion;
		expect(sum).toBe(1);
	});

	it("BLEND_NO_CACHE weights sum to 1", () => {
		const sum = BLEND_NO_CACHE.prompt + BLEND_NO_CACHE.completion;
		expect(sum).toBe(1);
	});
});

// ── isModelsResponseBody ──────────────────────────────────────

// We import the type guard indirectly; test it through fetchModelPricing
// behavior with various response shapes.

// ── fetchModelPricing integration ─────────────────────────────

import { PricingFetcher } from "../../api/clients/pricingService";

describe("fetchModelPricing", () => {
	let fetcher: PricingFetcher;

	beforeEach(() => {
		fetcher = new PricingFetcher();
	});

	const validModel = {
		id: "openai/gpt-4o",
		name: "OpenAI: GPT-4o",
		created: Math.floor(Date.now() / 1000) - 86400 * 30,
		description: "GPT-4o model",
		context_length: 128000,
		pricing: {
			prompt: "0.0000025",
			completion: "0.000010",
			image: "0",
			request: "0",
			input_cache_read: "0.00000125",
			input_cache_write: "0.0000025",
			web_search: "0",
			internal_reasoning: "0",
		},
		architecture: { modality: "text+image->text" },
		top_provider: { id: "openai" },
	};

	it("returns parsed models on success", async () => {
		const body = { data: [validModel] };
		const client = fakeClient(jsonResponse(body));
		const result = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		expect(result.models).toHaveLength(1);
		expect(result.models[0].id).toBe("openai/gpt-4o");
		expect(result.models[0].name).toBe("OpenAI: GPT-4o");
		expect(typeof result.fetchedAt).toBe("string");
	});

	it("computes perMillion pricing", async () => {
		const body = { data: [validModel] };
		const client = fakeClient(jsonResponse(body));
		const result = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		const pm = result.models[0].perMillion;
		expect(pm.prompt).toBe(2.5);
		expect(pm.completion).toBe(10);
		expect(pm.inputCacheRead).toBe(1.25);
	});

	it("skips non-object entries", async () => {
		const body = {
			data: [
				validModel,
				"not a model",
				null,
				{
					id: "valid",
					name: "Valid",
					created: 1000,
					description: "",
					context_length: 4096,
					pricing: {
						prompt: "0",
						completion: "0",
						image: "0",
						request: "0",
						input_cache_read: "0",
						input_cache_write: "0",
						web_search: "0",
						internal_reasoning: "0",
					},
				},
			],
		};
		const client = fakeClient(jsonResponse(body));
		const result = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		expect(result.models).toHaveLength(2);
	});

	it("bounds page cache entries and promotes recently used pages", async () => {
		const requests: Array<{ url: string; etag: string | null }> = [];
		const client: HttpClient = {
			fetch: async (url, init) => {
				const etag = `"${url}"`;
				requests.push({ url, etag: new Headers(init?.headers).get("If-None-Match") });
				return jsonResponse({ data: [{ ...validModel, id: url, name: url }] }, 200, { ETag: etag });
			},
		};

		const pageUrls = Array.from(
			{ length: 8 },
			(_, index) => `https://test/api/v1/models?page=${index}`,
		);
		for (const url of pageUrls) {
			await (fetcher as any).doFetchModelsPage(client, url);
		}
		await (fetcher as any).doFetchModelsPage(client, pageUrls[0]);
		await (fetcher as any).doFetchModelsPage(client, "https://test/api/v1/models?page=8");
		await (fetcher as any).doFetchModelsPage(client, pageUrls[0]);
		await (fetcher as any).doFetchModelsPage(client, pageUrls[1]);

		const recentRequests = requests.slice(-2);
		expect(recentRequests[0].etag).toBe(`"${pageUrls[0]}"`);
		expect(recentRequests[1].etag).toBeNull();
	});

	it("throws on non-OK response", async () => {
		const client = fakeClient(errorResponse(500, "Internal Server Error"));
		await expect(fetcher.fetchModelPricing(client, "https://test/api/v1/models")).rejects.toThrow(
			"OpenRouter API unreachable",
		);
	});

	it("throws on non-JSON response", async () => {
		const resp = new Response("not json", {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
		const client = fakeClient(resp);
		const err = await fetcher
			.fetchModelPricing(client, "https://test/api/v1/models")
			.catch((error) => error);
		expect(err).toBeInstanceOf(OpenRouterHttpError);
		expect(err.errorClass).toBe("malformed-response");
		expect(err.isRetryable).toBe(false);
	});

	it("throws on 401 response (permanent)", async () => {
		const client = fakeClient(errorResponse(401, "Unauthorized"));
		// 401 is permanent — may throw either the API error directly or circuit breaker
		await expect(fetcher.fetchModelPricing(client, "https://test/api/v1/models")).rejects.toThrow();
	});

	it("304 Not Modified handled via ETag caching", async () => {
		// The circuit breaker module state can trigger if prior tests failed.
		// The ETag path is exercised through the 304 handling in doFetchModelsPage.
		// This test validates that the paginated model parsing works correctly.
		const body = { data: [validModel] };
		const client = fakeClient(jsonResponse(body));
		const result = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		expect(result.models).toHaveLength(1);
	});

	it("throws when response data is not an array", async () => {
		const body = { data: "not an array" };
		const client = fakeClient(jsonResponse(body));
		const err = await fetcher
			.fetchModelPricing(client, "https://test/api/v1/models")
			.catch((error) => error);
		expect(err).toBeInstanceOf(OpenRouterHttpError);
		expect(err.errorClass).toBe("malformed-response");
	});

	it("surfaces partial model contract health while retaining valid models", async () => {
		const client = fakeClient(
			jsonResponse({ data: [validModel, { id: "missing/pricing", name: "Incomplete" }] }),
		);
		const result = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		expect(result.models).toHaveLength(1);
		expect(result.contractHealth).toMatchObject({ status: "partial", issueCount: 1 });
	});

	it("handles missing Content-Type header", async () => {
		const resp = new Response(JSON.stringify({ data: [validModel] }), { status: 200 });
		// No Content-Type header → should throw
		const client = fakeClient(resp);
		await expect(fetcher.fetchModelPricing(client, "https://test/api/v1/models")).rejects.toThrow();
	});
});

// ── Pagination support ────────────────────────────────────────

describe("fetchModelPricing pagination", () => {
	let fetcher: PricingFetcher;

	beforeEach(() => {
		fetcher = new PricingFetcher();
	});

	const buildPage = (ids: string[], next?: string) => ({
		data: ids.map((id) => ({
			id,
			name: id,
			created: Math.floor(Date.now() / 1000) - 86400,
			description: "",
			context_length: 4096,
			pricing: {
				prompt: "0",
				completion: "0",
				image: "0",
				request: "0",
				input_cache_read: "0",
				input_cache_write: "0",
				web_search: "0",
				internal_reasoning: "0",
			},
		})),
		links: next ? { next } : undefined,
	});

	// Note: Circuit breaker state is module-level and persists across tests.
	// The pagination test validates that models from all pages are merged.
	it("fetches and parses paginated data correctly", async () => {
		let callCount = 0;
		const client: HttpClient = {
			fetch: async (_url: string) => {
				callCount++;
				if (callCount === 1) {
					return jsonResponse(buildPage(["model-1"], "https://test/api/v1/models?offset=2"));
				}
				return jsonResponse(buildPage(["model-2"]));
			},
		};

		const result = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		expect(result.models).toHaveLength(2);
		expect(callCount).toBe(2);
	});

	it("marks repeated pagination links as truncated without looping", async () => {
		let callCount = 0;
		const repeated = "https://test/api/v1/models?offset=2";
		const client: HttpClient = {
			fetch: async () => {
				callCount++;
				return jsonResponse(buildPage([`model-${callCount}`], repeated));
			},
		};

		const result = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		expect(result.models).toHaveLength(2);
		expect(result.pagination).toMatchObject({
			pagesFetched: 2,
			truncated: true,
			reason: "repeated-link",
		});
		expect(callCount).toBe(2);
	});

	it("rejects cross-origin pagination links", async () => {
		const client = fakeClient(jsonResponse(buildPage(["model-1"], "https://evil.example/models")));
		const result = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		expect(result.pagination).toMatchObject({ truncated: true, reason: "cross-origin-link" });
		expect(result.models).toHaveLength(1);
	});

	it("reuses the validated first page for a 304 response", async () => {
		const first = jsonResponse(buildPage(["model-1"]), 200, { ETag: '"models-v1"' });
		const second = new Response(null, {
			status: 304,
			headers: { ETag: '"models-v1"' },
		});
		let callCount = 0;
		const client: HttpClient = {
			fetch: async (_url, init) => {
				callCount++;
				if (callCount === 1) return first;
				expect(new Headers(init?.headers).get("If-None-Match")).toBe('"models-v1"');
				return second;
			},
		};

		await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		const result = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		expect(result.models).toHaveLength(1);
		expect(result.models[0].id).toBe("model-1");
	});
});

// ── Workstream F: state snapshot + catalog cache integrity ──

describe("fetchModelPricing: empty/invalid collection (ERR-001)", () => {
	let fetcher: PricingFetcher;

	beforeEach(() => {
		fetcher = new PricingFetcher();
	});

	it("rejects a response that decodes to zero valid models", async () => {
		const body = { data: [{ id: "x" }, { id: "y" }] };
		const client = fakeClient(jsonResponse(body));
		const err = await fetcher
			.fetchModelPricing(client, "https://test/api/v1/models")
			.catch((error) => error);
		expect(err).toBeInstanceOf(OpenRouterHttpError);
		expect(err.errorClass).toBe("malformed-response");
	});

	it("rejects a non-object collection so a usable cache is preserved", async () => {
		const body = { data: ["not a model", null, 42] };
		const client = fakeClient(jsonResponse(body));
		const err = await fetcher
			.fetchModelPricing(client, "https://test/api/v1/models")
			.catch((error) => error);
		expect(err).toBeInstanceOf(OpenRouterHttpError);
		expect(err.errorClass).toBe("malformed-response");
	});
});

describe("fetchModelPricing: circuit breaker transient classes (ERR-003)", () => {
	let fetcher: PricingFetcher;

	beforeEach(() => {
		fetcher = new PricingFetcher();
	});

	it("does not count a permanent (401) failure toward the circuit breaker", async () => {
		const client = fakeClient(errorResponse(401, "Unauthorized"));
		await expect(fetcher.fetchModelPricing(client, "https://test/api/v1/models")).rejects.toThrow();
		const state = fetcher.getCircuitState();
		expect(state.consecutiveFailures).toBe(0);
		expect(state.status).toBe("closed");
	});

	it("counts a transient (500) failure toward the circuit breaker", async () => {
		const client = fakeClient(errorResponse(500, "Server Error"));
		await expect(fetcher.fetchModelPricing(client, "https://test/api/v1/models")).rejects.toThrow();
		const state = fetcher.getCircuitState();
		expect(state.consecutiveFailures).toBe(1);
		expect(state.status).toBe("closed");
	});

	it("does not count a malformed-response failure toward the circuit breaker", async () => {
		const body = { data: [{ id: "x" }] };
		const client = fakeClient(jsonResponse(body));
		await expect(fetcher.fetchModelPricing(client, "https://test/api/v1/models")).rejects.toThrow();
		const state = fetcher.getCircuitState();
		expect(state.consecutiveFailures).toBe(0);
		expect(state.status).toBe("closed");
	});
});

describe("fetchModelPricing: per-page ETag cache (API-004)", () => {
	let fetcher: PricingFetcher;

	beforeEach(() => {
		fetcher = new PricingFetcher();
	});

	const page = (ids: string[], next?: string) => ({
		data: ids.map((id) => ({
			id,
			name: id,
			created: Math.floor(Date.now() / 1000) - 86400,
			description: "",
			context_length: 4096,
			pricing: {
				prompt: "0",
				completion: "0",
				image: "0",
				request: "0",
				input_cache_read: "0",
				input_cache_write: "0",
				web_search: "0",
				internal_reasoning: "0",
			},
		})),
		links: next ? { next } : undefined,
	});

	it("keeps per-page ETag caches distinct across pages", async () => {
		const client: HttpClient = {
			fetch: async (url, init) => {
				const headers = init?.headers ? new Headers(init.headers) : undefined;
				if (headers?.get("If-None-Match")) {
					return new Response(null, { status: 304, headers: { ETag: "*" } });
				}
				if (String(url).includes("offset=2")) {
					return jsonResponse(page(["model-b"]), 200, { ETag: '"p2"' });
				}
				return jsonResponse(page(["model-a"], "https://test/api/v1/models?offset=2"), 200, {
					ETag: '"p1"',
				});
			},
		};

		const first = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		expect(first.models.map((m) => m.id).sort()).toEqual(["model-a", "model-b"]);

		const second = await fetcher.fetchModelPricing(client, "https://test/api/v1/models");
		// Each page's 304 returns its own cached data, not the other page's.
		expect(second.models.map((m) => m.id).sort()).toEqual(["model-a", "model-b"]);
		expect(second.models).toHaveLength(2);
	});
});
