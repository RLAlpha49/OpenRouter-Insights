/**
 * RefreshUseCase — encapsulates the pricing refresh workflow
 * (fetch + persist + notify + trigger UI update).
 *
 * Extracted from extension.ts so it can be unit-tested with a fake
 * pricing service, cache, and UI presenter.
 */

import * as vscode from "vscode";
import type { IPricingStore } from "../api/cache/pricingStore";
import { PricingFetcher } from "../api/clients/pricingService";
import { log, formatError, formatErrorBrief } from "../infrastructure/logger";
import type { ReadonlyConfig } from "../infrastructure/config";
import type { RefreshContext } from "../infrastructure/refreshContext";
import type { HttpClient } from "../api/transport/httpClient";
import type { EventBus } from "../infrastructure/eventBus";
import type { RuntimeDiagnostics } from "../infrastructure/runtimeDiagnostics";

export class RefreshUseCase {
	constructor(
		private readonly _cache: IPricingStore,
		private readonly _config: ReadonlyConfig,
		private readonly _fetcher = new PricingFetcher(),
		private readonly _client?: HttpClient,
		private readonly _eventBus?: EventBus,
		private readonly _diagnostics?: RuntimeDiagnostics,
	) {}

	private _pending: Promise<void> | undefined;

	get isInProgress(): boolean {
		return this._pending !== undefined;
	}

	/**
	 * Fetch latest pricing from OpenRouter, persist to cache, and notify the user.
	 * Coalesces concurrent calls: if a refresh is already in progress, subsequent
	 * callers await the in-flight promise instead of starting a duplicate cycle.
	 * @param ctx Optional refresh context — checked for cancellation at safe points.
	 */
	async execute(ctx?: RefreshContext): Promise<void> {
		if (this._pending) {
			log.info("RefreshUseCase: coalescing into in-flight refresh cycle");
			return this._pending;
		}

		this._pending = this._executeInternal(ctx);
		try {
			await this._pending;
		} finally {
			this._pending = undefined;
		}
	}

	private async _executeInternal(ctx?: RefreshContext): Promise<void> {
		log.info("RefreshUseCase.execute: starting refresh cycle (cache was", this._cache.age(), ")");
		try {
			ctx?.throwIfCancelled();
			log.info("Refreshing pricing from OpenRouter API...");
			const data = await this._fetcher.fetchModelPricing(
				this._client,
				this._config.apiBaseUrl,
				undefined,
				this._config.blendWeights,
				ctx?.signal,
			);
			if (ctx?.isCancelled()) {
				log.info("RefreshUseCase: superseded before publish, discarding result");
				return;
			}
			await this._cache.set(data);
			log.info("Pricing refreshed:", data.models.length, "models, cache now", this._cache.age());
			void vscode.window.showInformationMessage(
				`OpenRouter pricing updated (${data.models.length} models)`,
			);
		} catch (err) {
			// Cancellation is non-error control flow — do not surface it.
			if (ctx?.isCancelled() || (err as { cancelled?: boolean }).cancelled) {
				log.info("RefreshUseCase: refresh cancelled");
				return;
			}
			log.error("Refresh failed:", formatError(err));
			this._diagnostics?.recordFailure("background", err);
			ctx?.markFailed();
			this._eventBus?.emit("refreshFailed", {
				label: "pricing",
				error: formatErrorBrief(err).slice(0, 240),
				refreshId: ctx?.refreshId,
			});
			// ── Graceful degradation: fall back to stale cache ──
			const cachedData = this._cache.get();
			if (cachedData && cachedData.models.length > 0) {
				const cacheAge = this._cache.age();
				log.warn("RefreshUseCase: API unreachable — falling back to cached data from", cacheAge);
				void vscode.window.showWarningMessage(
					`OpenRouter: couldn't fetch pricing — showing cached data from ${cacheAge}. ${formatErrorBrief(err)}`,
				);
			} else {
				void vscode.window.showErrorMessage(
					`OpenRouter: failed to fetch pricing — ${formatErrorBrief(err)}`,
				);
			}
		}

		log.debug("RefreshUseCase._executeInternal: refresh cycle complete");
	}
}
