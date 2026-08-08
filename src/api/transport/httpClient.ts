/**
 * HTTP client abstraction — decouples network calls from the global
 * `fetch` so the pricing service can be tested with a fake client
 * returning canned responses, and the runtime default is the browser
 * `fetch` available in the VS Code extension host.
 */

export type HttpRequestInit = RequestInit & { endpointId?: string };

export interface HttpClient {
	fetch(_url: string, _init?: HttpRequestInit): Promise<Response>;
}

/** Default HTTP client backed by global `fetch`. */
export const defaultHttpClient: HttpClient = {
	fetch: (_url, _init) => fetch(_url, _init),
};
