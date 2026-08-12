import { describe, expect, it } from "vitest";
import {
	NO_RETRY_POLICY,
	OPENROUTER_ENDPOINTS,
	TRANSIENT_RETRY_POLICY,
	buildAnalyticsRequest,
	buildEndpointRequest,
	buildKeyManagementRequest,
	buildModelMetricsQuery,
	getEndpointContract,
	getEndpointRetryPolicy,
} from "../../api/endpoint/endpointCatalog";

describe("OpenRouter endpoint catalog", () => {
	it("maps every supported endpoint to documentation and a decoder", () => {
		expect(OPENROUTER_ENDPOINTS.length).toBeGreaterThanOrEqual(9);
		for (const endpoint of OPENROUTER_ENDPOINTS) {
			expect(endpoint.docsUrl).toMatch(/^https:\/\/openrouter\.ai\/docs\//);
			expect(endpoint.decoder).toBeTruthy();
			expect(endpoint.path).toMatch(/^\/api\/v1\//);
			expect(endpoint.responseLimitBytes).toBeGreaterThan(0);
			expect(endpoint.requestBuilder).toBeTypeOf("function");
		}
	});

	it("builds endpoint requests through the typed catalog mapping", () => {
		expect(buildEndpointRequest("models.list")).toMatchObject({
			method: "GET",
			path: "/api/v1/models",
		});
		expect(
			buildEndpointRequest("analytics.query", {
				start: "2026-08-01T00:00:00.000Z",
				end: "2026-08-09T00:00:00.000Z",
				limit: 25,
			}),
		).toMatchObject({ method: "POST", path: "/api/v1/analytics/query" });
	});

	it("builds the analytics request from its endpoint contract", () => {
		const request = buildAnalyticsRequest({
			start: "2026-08-01T00:00:00.000Z",
			end: "2026-08-09T00:00:00.000Z",
			limit: 25,
		});

		expect(request).toMatchObject({
			method: "POST",
			path: "/api/v1/analytics/query",
			body: expect.objectContaining({
				dimensions: ["model"],
				limit: 25,
			}),
		});
	});

	it("builds validated key-management requests", () => {
		expect(buildKeyManagementRequest("keys.create", { name: "new-key", limit: 10 })).toMatchObject({
			method: "POST",
			body: { name: "new-key", limit: 10 },
		});
		expect(() => buildKeyManagementRequest("keys.update", { hash: "bad/hash", name: "x" })).toThrow(
			"Invalid API key hash",
		);
	});

	it("builds model metrics query parameters from the endpoint contract", () => {
		expect(buildModelMetricsQuery("openai/gpt-4o")).toBe("?max_results=100");
	});

	it("marks administrative endpoints as management-key protected", () => {
		const management = OPENROUTER_ENDPOINTS.filter((endpoint) => endpoint.auth === "managementKey");
		expect(management.map((endpoint) => endpoint.id)).toEqual([
			"keys.list",
			"credits.get",
			"activity.list",
			"analytics.query",
			"keys.create",
			"keys.update",
			"keys.delete",
		]);
	});

	it("assigns distinct typed decoders to key-management endpoints", () => {
		expect(getEndpointContract("keys.create").decoder).toBe("createKey");
		expect(getEndpointContract("keys.update").decoder).toBe("updateKey");
		expect(getEndpointContract("keys.delete").decoder).toBe("deleteKey");
	});

	it("assigns timeout policy to every endpoint", () => {
		for (const endpoint of OPENROUTER_ENDPOINTS) {
			expect(endpoint.timeoutMs).toBeGreaterThan(0);
		}
	});

	it("turns every declared retry mode into a runtime request policy", () => {
		for (const endpoint of OPENROUTER_ENDPOINTS) {
			const policy = getEndpointRetryPolicy(endpoint.id);
			if (endpoint.retry === "transient") {
				expect(policy).toEqual(TRANSIENT_RETRY_POLICY);
				expect(policy.maxRetries).toBeGreaterThan(1);
			} else {
				expect(policy).toEqual(NO_RETRY_POLICY);
				expect(policy.maxRetries).toBe(1);
			}
		}
	});

	it("lets a service tighten a transient budget but clamps the attempt floor", () => {
		expect(getEndpointRetryPolicy("keys.current", { baseDelayMs: -1 }).baseDelayMs).toBe(0);
	});
});
