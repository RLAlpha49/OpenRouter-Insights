/**
 * StatusBarUpdateUseCase — coordinates model resolution, pricing lookup,
 * filtering, and status-bar publication.
 *
 * Extracted from extension.ts so it can be unit-tested with a fake
 * cache, resolver, and presenter. The resolved state is published through
 * `StatusBarPresenter`; view-model construction belongs to the host adapter.
 */

import type { IPricingCache } from "../api/cache/pricingStore";
import type { ModelPricingInfo } from "../types";
import { resolveModelId } from "../models/modelResolver";
import { getLastStateDbDiagnostic } from "../models/stateDbReader";
import type { ReadonlyConfig } from "../infrastructure/config";
import type { EventBus } from "../infrastructure/eventBus";
import { log } from "../infrastructure/logger";
import type { ModelSelectionCache, StatusBarPresenter } from "./ports";

/** Compile-time exhaustive switch guard — throws at runtime if reached. */
function assertNever(value: never): never {
	throw new Error(`Unexpected status bar click action: ${String(value)}`);
}

export class StatusBarUpdateUseCase {
	private _lastResolvedModel: string | undefined;
	private _lastPricingStatus: "found" | "missing" | undefined;
	private _pending: Promise<void> | undefined;
	private readonly _cache: IPricingCache;
	private readonly _statusBar: StatusBarPresenter;
	private readonly _modelPicker: ModelSelectionCache;

	constructor(
		cache: IPricingCache,
		statusBar: StatusBarPresenter,
		modelPicker: ModelSelectionCache,
		private readonly _config: ReadonlyConfig,
		private readonly _eventBus: EventBus,
	) {
		this._cache = cache;
		this._statusBar = statusBar;
		this._modelPicker = modelPicker;
	}

	/**
	 * Execute a full status-bar update cycle with change detection.
	 * Coalesces concurrent calls: if a cycle is already in progress,
	 * subsequent callers await the in-flight promise rather than
	 * starting a redundant second cycle. See ANALYSIS §3.4.
	 */
	async execute(): Promise<void> {
		if (this._pending) {
			log.debug("StatusBarUpdateUseCase.execute: coalescing into in-flight cycle");
			return this._pending;
		}

		this._pending = this._executeInternal();
		try {
			await this._pending;
		} finally {
			this._pending = undefined;
		}
	}

	private async _executeInternal(): Promise<void> {
		log.debug("StatusBarUpdateUseCase.execute: starting update cycle");
		const show = this._config.showInStatusBar;
		this._statusBar.setEnabled(show);

		if (!show) {
			log.debug("updateStatusBar: hidden per config");
			return;
		}

		const lookup = this._cache.getLookup();
		if (lookup.size === 0) {
			log.debug("updateStatusBar: pricing lookup is empty, cache may not be loaded");
		}

		const result = await resolveModelId(
			lookup,
			this._cache.getValues.bind(this._cache),
			this._cache.getLowercasedIndex.bind(this._cache),
		);
		const modelId = result?.id;
		const displayName = result?.displayName;
		const pricing = this.resolvePricing(modelId, lookup);

		// Surface a bounded diagnostic when the state DB read failed and model
		// resolution fell back to another source. Distinguishes a
		// database problem from a valid "no selected model" state.
		const stateDbDiagnostic = getLastStateDbDiagnostic();
		if (stateDbDiagnostic !== "ok" && stateDbDiagnostic !== "not-found") {
			log.debug(
				"updateStatusBar: state DB diagnostic =",
				stateDbDiagnostic,
				"— model resolution may have fallen back",
			);
		}

		// Skip re-render when nothing changed
		const currentPricingStatus: "found" | "missing" = pricing ? "found" : "missing";
		if (modelId === this._lastResolvedModel && currentPricingStatus === this._lastPricingStatus) {
			log.debug("updateStatusBar: no change, skipping re-render");
			return;
		}
		this._lastResolvedModel = modelId;
		this._lastPricingStatus = currentPricingStatus;

		// Model changed — invalidate the LM API cache
		this._modelPicker.invalidateConfiguredIdsCache();

		const data = this._cache.get();
		const finalName = displayName ?? pricing?.name ?? modelId ?? "no model";
		log.info(
			"updateStatusBar: final display =",
			finalName,
			"| pricing =",
			pricing ? "FOUND" : "MISSING",
			"| cache =",
			data ? `${data.models.length} models` : "MISSING",
		);

		this._statusBar.showPricing({ displayName, pricing, data });

		// Emit model-changed event for downstream consumers (e.g. ModelPickerEnhancer)
		this._eventBus.emit("modelChanged", { modelId, displayName });

		this.applyStatusBarClickAction();
	}

	/** Apply the configured click action to the status bar item. */
	private applyStatusBarClickAction(): void {
		const action = this._config.statusBarClickAction;
		switch (action) {
			case "browseModels":
				this._statusBar.setCommand("openrouter-insights.browseModels");
				break;
			case "refreshPricing":
				this._statusBar.setCommand("openrouter-insights.refreshPricing");
				break;
			case "showLogs":
				this._statusBar.setCommand("openrouter-insights.showLogs");
				break;
			case "quickActions":
				this._statusBar.setCommand("openrouter-insights.showQuickActions");
				break;
			default:
				assertNever(action);
		}
	}

	/** Resolve pricing with free-model-only filter applied. */
	private resolvePricing(
		modelId: string | undefined,
		lookup: Map<string, ModelPricingInfo>,
	): ModelPricingInfo | undefined {
		let pricing = modelId ? lookup.get(modelId) : undefined;
		const freeOnly = this._config.showFreeModelsOnly;
		if (freeOnly && pricing && pricing.blendedRate !== 0) {
			pricing = undefined;
		}
		return pricing;
	}

	/** Invalidate the change-detection cache (force next call to always re-render). */
	invalidateCache(): void {
		this._lastResolvedModel = undefined;
		this._lastPricingStatus = undefined;
	}
}
