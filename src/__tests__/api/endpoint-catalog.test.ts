import { describe, expect, it } from "vitest";
import {
	NO_RETRY_POLICY,
	OPENROUTER_ENDPOINTS,
	TRANSIENT_RETRY_POLICY,
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
		}
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
