/**
 * Unit tests for the HTTP pipeline — middleware composition, endpoint policy,
 * logging, request diagnostics, and external abort listener cleanup.
 */

import { describe, it, expect, vi } from "vitest";
import {
	HttpPipeline,
	withAuth,
	withDefaultHeaders,
	withEndpointPolicy,
	withLogging,
	withTimeout,
} from "../../api/transport/httpPipeline";
import type { HttpClient } from "../../api/transport/httpClient";

function fakeClient(response: Response): HttpClient {
	return { fetch: async () => response };
}

/** Capture the RequestInit the base client finally receives. */
function recordingClient(response: () => Response | Promise<Response>): {
	client: HttpClient;
	requests: Array<{ url: string; init?: RequestInit }>;
} {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	return {
		requests,
		client: {
			fetch: async (url, init) => {
				requests.push({ url, init });
				return response();
			},
		},
	};
}

describe("withTimeout: external abort listener cleanup", () => {
	it("removes the external abort listener after a successful request", async () => {
		const external = new AbortController();
		const addSpy = vi.spyOn(external.signal, "addEventListener");
		const removeSpy = vi.spyOn(external.signal, "removeEventListener");

		const pipeline = new HttpPipeline(fakeClient(new Response("ok", { status: 200 })), [
			withTimeout(1000),
		]);
		const res = await pipeline.fetch("https://example.com", { signal: external.signal });
		expect(res.status).toBe(200);

		expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("removes the external abort listener after a rejected request", async () => {
		const external = new AbortController();
		const removeSpy = vi.spyOn(external.signal, "removeEventListener");

		const failingClient: HttpClient = {
			fetch: async () => {
				throw new Error("network down");
			},
		};
		const pipeline = new HttpPipeline(failingClient, [withTimeout(1000)]);

		await expect(
			pipeline.fetch("https://example.com", { signal: external.signal }),
		).rejects.toThrow("network down");

		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("aborts the request when the external signal aborts", async () => {
		const external = new AbortController();
		let requestSignal: AbortSignal | undefined;
		const client: HttpClient = {
			fetch: async (_url, init) => {
				requestSignal = init?.signal ?? undefined;
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				});
			},
		};
		const pipeline = new HttpPipeline(client, [withTimeout(5000)]);

		const pending = pipeline.fetch("https://example.com", { signal: external.signal });
		external.abort();
		await expect(pending).rejects.toThrow();
		expect(requestSignal?.aborted).toBe(true);
	});

	it("does not attach a listener when the external signal is already aborted", async () => {
		const external = new AbortController();
		external.abort();
		const addSpy = vi.spyOn(external.signal, "addEventListener");

		const pipeline = new HttpPipeline(fakeClient(new Response("ok", { status: 200 })), [
			withTimeout(1000),
		]);
		await pipeline.fetch("https://example.com", { signal: external.signal });

		expect(addSpy).not.toHaveBeenCalled();
	});
});

describe("withEndpointPolicy", () => {
	it("does not inject Authorization for public endpoints", async () => {
		let request: RequestInit | undefined;
		const client: HttpClient = {
			fetch: async (_url, init) => {
				request = init;
				return new Response("{}", { status: 200 });
			},
		};
		const pipeline = new HttpPipeline(client, [
			withEndpointPolicy({
				apiKeyProvider: async () => "sk-or-v1-api-key-12345678901234567890",
				managementKeyProvider: async () => "sk-or-v1-management-key-12345678901234567890",
			}),
		]);

		await pipeline.fetch("https://openrouter.ai/api/v1/models", {
			method: "POST",
			endpointId: "models.list",
			headers: { Authorization: "Bearer ambient-secret" },
		} as RequestInit & { endpointId: string });

		expect(request?.method).toBe("GET");
		expect(new Headers(request?.headers).has("authorization")).toBe(false);
	});

	it("injects the contract-selected management key", async () => {
		let request: RequestInit | undefined;
		const client: HttpClient = {
			fetch: async (_url, init) => {
				request = init;
				return new Response("{}", { status: 200 });
			},
		};
		const pipeline = new HttpPipeline(client, [
			withEndpointPolicy({
				apiKeyProvider: async () => "sk-or-v1-api-key-12345678901234567890",
				managementKeyProvider: async () => "sk-or-v1-management-key-12345678901234567890",
			}),
		]);

		await pipeline.fetch("https://openrouter.ai/api/v1/credits", {
			endpointId: "credits.get",
		} as RequestInit & { endpointId: string });

		expect(new Headers(request?.headers).get("authorization")).toBe(
			"Bearer sk-or-v1-management-key-12345678901234567890",
		);
	});

	it("fails closed before network I/O when a required key is missing", async () => {
		const client: HttpClient = { fetch: vi.fn() };
		const pipeline = new HttpPipeline(client, [
			withEndpointPolicy({ apiKeyProvider: async () => "", managementKeyProvider: async () => "" }),
		]);

		await expect(
			pipeline.fetch("https://openrouter.ai/api/v1/credits", {
				endpointId: "credits.get",
			} as RequestInit & { endpointId: string }),
		).rejects.toMatchObject({ errorClass: "auth", status: 0 });
		expect(client.fetch).not.toHaveBeenCalled();
	});

	it("injects the api key for apiKey endpoints and leaves requests without metadata alone", async () => {
		const { client, requests } = recordingClient(() => new Response("{}", { status: 200 }));
		const pipeline = new HttpPipeline(client, [
			withEndpointPolicy({
				apiKeyProvider: async () => "  sk-or-v1-api-key-12345678901234567890  ",
				managementKeyProvider: async () => "sk-or-v1-management-key-12345678901234567890",
			}),
		]);

		await pipeline.fetch("https://openrouter.ai/api/v1/key", {
			endpointId: "keys.current",
		} as RequestInit & { endpointId: string });
		await pipeline.fetch("https://example.com/anything", {
			headers: { Authorization: "Bearer caller-owned" },
		});

		expect(new Headers(requests[0].init?.headers).get("authorization")).toBe(
			"Bearer sk-or-v1-api-key-12345678901234567890",
		);
		expect(requests[0].init).not.toHaveProperty("endpointId");
		// Requests without endpoint metadata keep the caller's own headers.
		expect(new Headers(requests[1].init?.headers).get("authorization")).toBe("Bearer caller-owned");
	});
});

describe("pipeline composition", () => {
	it("preserves caller headers over defaults and records the redacted request", async () => {
		const { client, requests } = recordingClient(() => new Response("{}", { status: 200 }));
		const pipeline = new HttpPipeline(client, [
			withDefaultHeaders({ Accept: "application/json", "Accept-Encoding": "gzip" }),
			withAuth(async () => "sk-or-v1-rotating-key-12345678901234567890"),
		]);

		await pipeline.fetch("https://openrouter.ai/api/v1/models?api_key=secret-value", {
			headers: { Accept: "text/plain" },
		});

		const headers = new Headers(requests[0].init?.headers);
		expect(headers.get("accept")).toBe("text/plain");
		expect(headers.get("accept-encoding")).toBe("gzip");
		expect(headers.get("authorization")).toBe("Bearer sk-or-v1-rotating-key-12345678901234567890");
	});

	it("skips the Authorization header when the key provider returns nothing", async () => {
		const { client, requests } = recordingClient(() => new Response("{}", { status: 200 }));
		const pipeline = new HttpPipeline(client, [withAuth(async () => "")]);

		await pipeline.fetch("https://openrouter.ai/api/v1/models");

		expect(new Headers(requests[0].init?.headers).has("authorization")).toBe(false);
	});

	it("runs middleware outermost first and reaches the base client last", async () => {
		const order: string[] = [];
		const client: HttpClient = {
			fetch: async () => {
				order.push("base");
				return new Response("{}", { status: 200 });
			},
		};
		const trace =
			(label: string) => async (_req: RequestInit, _url: string, next: () => Promise<Response>) => {
				order.push(`${label}:before`);
				const res = await next();
				order.push(`${label}:after`);
				return res;
			};
		const pipeline = new HttpPipeline(client, [trace("outer"), trace("inner")]);

		await pipeline.fetch("https://openrouter.ai/api/v1/models");

		expect(order).toEqual(["outer:before", "inner:before", "base", "inner:after", "outer:after"]);
	});
});

describe("withLogging", () => {
	function logger() {
		return { info: vi.fn(), warn: vi.fn() };
	}

	it("logs successful responses at info with the redacted URL", async () => {
		const log = logger();
		const pipeline = new HttpPipeline(fakeClient(new Response("{}", { status: 200 })), [
			withLogging(log),
		]);

		await pipeline.fetch("https://openrouter.ai/api/v1/activity?api_key_hash=secret-hash");

		expect(log.warn).not.toHaveBeenCalled();
		const message = String(log.info.mock.calls[0][0]);
		expect(message).toContain("GET");
		expect(message).toContain("→ 200");
		expect(message).not.toContain("secret-hash");
	});

	it("logs non-OK responses at warn and includes the refresh correlation id", async () => {
		const log = logger();
		const pipeline = new HttpPipeline(fakeClient(new Response("nope", { status: 503 })), [
			withLogging(log),
		]);

		await pipeline.fetch("https://openrouter.ai/api/v1/models", {
			method: "POST",
			refreshId: 7,
		} as RequestInit & { refreshId: number });

		expect(log.info).not.toHaveBeenCalled();
		expect(String(log.warn.mock.calls[0][0])).toContain("refresh=7");
		expect(String(log.warn.mock.calls[0][0])).toContain("→ 503");
	});

	it("reads the refresh correlation id from the request signal", async () => {
		const log = logger();
		const controller = new AbortController();
		Object.defineProperty(controller.signal, "refreshId", { value: 42, enumerable: false });
		const pipeline = new HttpPipeline(fakeClient(new Response("{}", { status: 200 })), [
			withLogging(log),
		]);

		await pipeline.fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });

		expect(String(log.info.mock.calls[0][0])).toContain("refresh=42");
	});

	it("logs and rethrows transport failures", async () => {
		const log = logger();
		const failing: HttpClient = {
			fetch: async () => {
				throw new Error("socket hang up");
			},
		};
		const pipeline = new HttpPipeline(failing, [withLogging(log), withTimeout(1000)]);

		await expect(pipeline.fetch("https://openrouter.ai/api/v1/models")).rejects.toThrow(
			"socket hang up",
		);
		expect(String(log.warn.mock.calls[0][0])).toContain("FAIL");
		expect(String(log.warn.mock.calls[0][0])).toContain("socket hang up");
	});

	it("logs non-Error rejections without losing the failure", async () => {
		const log = logger();
		const failing: HttpClient = {
			fetch: async () => {
				throw "string failure";
			},
		};
		const pipeline = new HttpPipeline(failing, [withLogging(log)]);

		await expect(pipeline.fetch("https://openrouter.ai/api/v1/models")).rejects.toBe(
			"string failure",
		);
		expect(String(log.warn.mock.calls[0][0])).toContain("string failure");
	});
});

describe("credential redaction in diagnostics", () => {
	function logger() {
		return { info: vi.fn(), warn: vi.fn() };
	}

	it("redacts a secret-bearing query parameter from the logged URL", async () => {
		const log = logger();
		const pipeline = new HttpPipeline(fakeClient(new Response("{}", { status: 200 })), [
			withLogging(log),
		]);

		const secret = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789";
		await pipeline.fetch(`https://openrouter.ai/api/v1/key?api_key=${secret}`);

		const message = String(log.info.mock.calls[0][0]);
		expect(message).not.toContain(secret);
		expect(message).toContain("REDACTED");
	});

	it("does not expose request credentials through a removed diagnostics hook", async () => {
		let calls = 0;
		const client: HttpClient = {
			fetch: async () => {
				calls++;
				return new Response("{}", { status: 200 });
			},
		};
		const pipeline = new HttpPipeline(client, []);

		await pipeline.fetch("https://openrouter.ai/api/v1/key?api_key=sk-or-v1-SECRETS", {
			headers: { Authorization: "Bearer sk-or-v1-OTHERSECRET" },
		});

		expect(calls).toBe(1);
	});
});
