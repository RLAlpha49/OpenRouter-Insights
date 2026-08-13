/**
 * RefreshUseCase — encapsulates the pricing refresh workflow
 * (fetch + persist + publish outcome + trigger UI update).
 *
 * Extracted from extension.ts so it can be unit-tested with a fake
 * pricing service, cache, and presenter. Terminal outcomes are published
 * through `PricingRefreshPresenter`; this module never talks to the host.
 */

import type { IPricingStore } from "../api/cache/pricingStore";
import { PricingFetcher } from "../api/clients/pricingService";
import { log, formatError, formatErrorBrief } from "../infrastructure/logger";
import type { ReadonlyConfig } from "../infrastructure/config";
import type { RefreshContext } from "../infrastructure/refreshContext";
import { isCancellationError } from "../api/transport/fetchHelpers";
import type { HttpClient } from "../api/transport/httpClient";
import type { EventBus } from "../infrastructure/eventBus";
import type { RuntimeDiagnostics } from "../infrastructure/runtimeDiagnostics";
import type { PricingRefreshPresenter } from "./ports";

export class RefreshUseCase {
	constructor(
		private readonly _cache: IPricingStore,
		private readonly _config: ReadonlyConfig,
		private readonly _fetcher = new PricingFetcher(log, this._diagnostics),
		private readonly _client?: HttpClient,
		private readonly _eventBus?: EventBus,
		private readonly _diagnostics?: RuntimeDiagnostics,
		private readonly _presenter?: PricingRefreshPresenter,
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
			this._presenter?.pricingUpdated(data.models.length);
		} catch (err) {
			// Cancellation is non-error control flow — do not surface it.
			if (isCancellationError(err, ctx?.signal)) {
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
				this._presenter?.pricingStale(cacheAge, formatErrorBrief(err));
			} else {
				this._presenter?.pricingUnavailable(formatErrorBrief(err));
			}
		}

		log.debug("RefreshUseCase._executeInternal: refresh cycle complete");
	}
}
