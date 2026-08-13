/**
 * API service composition — stores, secrets, and the shared HTTP pipeline.
 *
 * This factory owns the credential-change invalidation boundary: rotation or
 * removal advances the SecretStorageService generation and clears process-local
 * authenticated derived data before any later request can publish it.
 */

import type { ExtensionContext } from "vscode";
import { PricingCache } from "../../api/cache/pricingCache";
import type { IPricingCache } from "../../api/cache/pricingStore";
import { UsageCache } from "../../api/cache/usageStore";
import { SecretStorageService } from "../../api/secretStorageService";
import { defaultHttpClient } from "../../api/transport/httpClient";
import { HttpPipeline, withEndpointPolicy, withLogging } from "../../api/transport/httpPipeline";
import { clearAnalyticsCache, setCredentialGeneration } from "../../api/clients/analyticsService";
import { configureStateDbDiagnostics } from "../../models/stateDbReader";
import { ConfigService } from "../config";
import { log } from "../logger";
import { RuntimeDiagnostics } from "../runtimeDiagnostics";
import type { RuntimeDisposables } from "./runtimeDisposables";

export interface ApiServices {
	readonly diagnostics: RuntimeDiagnostics;
	readonly cache: IPricingCache;
	readonly usageCache: UsageCache;
	readonly secrets: SecretStorageService;
	readonly httpPipeline: HttpPipeline;
}

/**
 * Create the API-facing singletons and register their disposal.
 * @param context     Extension context supplying global state and secrets.
 * @param disposables Ownership record for everything created here.
 */
export function createApiServices(
	context: ExtensionContext,
	disposables: RuntimeDisposables,
): ApiServices {
	const diagnostics = new RuntimeDiagnostics();
	const cache = new PricingCache(context, ConfigService.instance, diagnostics);
	configureStateDbDiagnostics(diagnostics);
	const usageCache = new UsageCache();
	const secrets = disposables.add(new SecretStorageService(context));

	// Single credential-change invalidation boundary for authenticated derived
	// data. Registered after `secrets` so it is released first on disposal.
	disposables.add(
		secrets.onCredentialChange((event) => {
			setCredentialGeneration(event.generation);
			clearAnalyticsCache();
		}),
	);

	const httpPipeline = new HttpPipeline(defaultHttpClient, [
		withLogging(log),
		withEndpointPolicy({
			apiKeyProvider: () => secrets.get(),
			managementKeyProvider: () => secrets.get(),
		}),
	]);

	return { diagnostics, cache, usageCache, secrets, httpPipeline };
}
