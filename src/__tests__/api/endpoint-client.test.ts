import { describe, expect, it, vi } from "vitest";
import { EndpointClient } from "../../api/transport/endpointClient";
import type { HttpClient } from "../../api/transport/httpClient";

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

describe("EndpointClient", () => {
	it("enforces endpoint method and credentials before decoding", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const http: HttpClient = {
			fetch: async (url, init) => {
				requests.push({ url, init });
				return jsonResponse({ data: { total_credits: "12.5", total_usage: "2.5" } });
			},
		};
		const client = new EndpointClient(http, {
			apiKeyProvider: async () => "api-key",
			managementKeyProvider: async () => "management-key",
		});

		const result = await client.request("credits.get", { baseUrl: "https://openrouter.ai/api/v1" });

		expect(result?.value.data.total_credits).toBe(12.5);
		expect(requests[0].init?.method).toBe("GET");
		expect(new Headers(requests[0].init?.headers).get("authorization")).toBe(
			"Bearer management-key",
		);
	});

	it("rejects non-JSON responses without calling Response.json", async () => {
		const http: HttpClient = {
			fetch: vi.fn(async () => new Response("<html>proxy</html>", { status: 200 })),
		};
		const client = new EndpointClient(http, {
			apiKeyProvider: async () => "api-key",
			managementKeyProvider: async () => "management-key",
		});

		await expect(client.request("credits.get")).rejects.toMatchObject({
			errorClass: "malformed-response",
			status: 0,
			responseStatus: 200,
		});
	});

	it("rejects oversized response bodies before JSON parsing", async () => {
		const http: HttpClient = {
			fetch: vi.fn(
				async () =>
					new Response(JSON.stringify({ data: { total_credits: 1, total_usage: 1 } }), {
						status: 200,
						headers: { "Content-Type": "application/json", "Content-Length": "999999999" },
					}),
			),
		};
		const client = new EndpointClient(http, {
			apiKeyProvider: async () => "api-key",
			managementKeyProvider: async () => "management-key",
		});

		await expect(client.request("credits.get")).rejects.toMatchObject({
			errorClass: "malformed-response",
			status: 0,
		});
	});
});
