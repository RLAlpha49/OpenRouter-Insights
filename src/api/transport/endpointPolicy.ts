import {
	getEndpointContract,
	type EndpointAuth,
	type EndpointId,
} from "../endpoint/endpointCatalog";
import { OpenRouterHttpError } from "./openRouterError";

export interface EndpointRequestWithMetadata extends RequestInit {
	endpointId?: EndpointId;
}

export interface EndpointCredentialProviders {
	apiKeyProvider: () => Promise<string>;
	managementKeyProvider: () => Promise<string>;
}

/** Apply catalog authentication and method policy before an endpoint request. */
export async function applyEndpointPolicy(
	req: EndpointRequestWithMetadata,
	providers: EndpointCredentialProviders,
): Promise<void> {
	const endpointId = req.endpointId;
	if (!endpointId) return;

	const endpoint = getEndpointContract(endpointId);
	req.method = endpoint.method;
	const headers = new Headers(req.headers);
	headers.delete("authorization");

	const provider = credentialProviderFor(endpoint.auth, providers);
	if (provider) {
		const key = (await provider()).trim();
		if (!key) {
			throw new OpenRouterHttpError({
				label: endpoint.id,
				errorClass: "auth",
				envelope: { message: `Missing credential for ${endpoint.id}` },
			});
		}
		headers.set("Authorization", `Bearer ${key}`);
	}

	req.headers = headers;
	delete req.endpointId;
}

function credentialProviderFor(
	auth: EndpointAuth,
	providers: EndpointCredentialProviders,
): (() => Promise<string>) | undefined {
	if (auth === "apiKey") return providers.apiKeyProvider;
	if (auth === "managementKey") return providers.managementKeyProvider;
	return undefined;
}
