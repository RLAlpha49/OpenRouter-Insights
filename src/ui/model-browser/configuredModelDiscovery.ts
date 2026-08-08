/**
 * ConfiguredModelDiscovery — discovers which OpenRouter models are
 * configured in Copilot's BYOK provider via the LM API.
 *
 * Extracted from ModelPickerEnhancer's static state so the cache is
 * injectable and testable (no hidden coupling via static fields).
 */

import type { ModelPricingInfo } from "../../types";
import { OPENROUTER_VENDOR_ID } from "../../types";
import { log } from "../../infrastructure/logger";
import * as vscode from "vscode";

export class ConfiguredModelDiscovery {
	private _configuredIdsCache: Set<string> | undefined;
	private _rawIdsCache: string[] | undefined;
	private _pending: Promise<string[]> | undefined;

	/** Invalidate the configured-model-ID cache (call when model config changes). */
	invalidateCache(): void {
		this._configuredIdsCache = undefined;
		this._rawIdsCache = undefined;
		log.info("ConfiguredModelDiscovery: cache invalidated");
	}

	/** Warm the Copilot model list without coupling it to pricing data. */
	warm(): void {
		void this._loadRawIds();
	}

	/**
	 * Discover which OpenRouter model IDs are configured in Copilot's BYOK provider.
	 * Results are cached — use `invalidateCache()` for manual refresh.
	 */
	async discoverModelIds(pricingLookup?: Map<string, ModelPricingInfo>): Promise<Set<string>> {
		// Do not retain an empty discovery result. The LM API can be temporarily
		// unavailable during activation, and an empty cache would hide models added
		// later until another explicit invalidation.
		if (this._configuredIdsCache && this._configuredIdsCache.size > 0) {
			log.info("discoverConfiguredModelIds: using cached result");
			return this._configuredIdsCache;
		}
		const ids = new Set<string>();
		for (const id of await this._loadRawIds()) {
			const extracted = extractPricingId(id, pricingLookup);
			if (extracted) ids.add(extracted);
		}
		this._configuredIdsCache = ids;
		return ids;
	}

	private async _loadRawIds(): Promise<string[]> {
		if (this._rawIdsCache && this._rawIdsCache.length > 0) return this._rawIdsCache;
		if (this._pending) return this._pending;
		this._pending = (async () => {
			try {
				const models = await vscode.lm.selectChatModels({ vendor: OPENROUTER_VENDOR_ID });
				log.info(
					"discoverConfiguredModelIds: found",
					models.length,
					"OpenRouter models in Copilot BYOK",
				);
				return models.map((model) => model.id).filter((id): id is string => Boolean(id));
			} catch {
				log.debug(
					"discoverConfiguredModelIds: LM API unavailable, configuredIds set will be empty",
				);
				return [];
			}
		})();
		try {
			this._rawIdsCache = await this._pending;
			return this._rawIdsCache;
		} finally {
			this._pending = undefined;
		}
	}
}

function extractPricingId(
	id: string,
	pricingLookup?: Map<string, ModelPricingInfo>,
): string | undefined {
	if (!pricingLookup) return id;
	if (pricingLookup.has(id)) return id;
	const freeId = `${id}:free`;
	if (pricingLookup.has(freeId)) return freeId;
	return id;
}
