/**
 * ModelResolver — encapsulates the model-ID detection chain as a
 * prioritized pipeline of ModelDetector instances.
 *
 * Pipeline order (first match wins):
 *   1. ConfigOverrideDetector   — user's explicit selection from settings
 *   2. CopilotStateDbDetector   — SQLite query against Copilot's state.vscdb
 *   3. FuzzyMatchDetector       — name/identifier fuzzy match against pricing data
 *
 * Each detector is independently testable. Adding a new source
 * (workspace file, env var, etc.) is just one more ModelDetector
 * implementation pushed into the pipeline.
 */

import type { ModelPricingInfo, ModelDetector, ResolvedModel } from "../types";
import { getSelectedModelId, getProviderFilter } from "../infrastructure/config";
import { findBestMatch } from "../api/clients/pricingService";
import { log } from "../infrastructure/logger";
import { resolveActiveModelFromCopilotState } from "./stateDbReader";

/**
 * Build the default model-detection pipeline.
 * Detectors are tried in declaration order; the first non-undefined
 * result wins.
 *
 * @param pricingLookup  O(1) model-id lookup map
 * @param getIndexedValues  Optional — lazily-built values array from PricingCache
 * @param getLowercasedIndex  Optional — lazily-built lowercased-name index from PricingCache
 */
export function createModelDetectors(
	pricingLookup: Map<string, ModelPricingInfo>,
	getIndexedValues?: () => readonly ModelPricingInfo[],
	getLowercasedIndex?: () => Map<string, ModelPricingInfo>,
): ModelDetector[] {
	return [
		new ConfigOverrideDetector(),
		new CopilotStateDbDetector(),
		new FuzzyMatchDetector(pricingLookup, getIndexedValues, getLowercasedIndex),
	];
}

/**
 * Walk the full detector chain to find the active OpenRouter model.
 * Resolves Copilot state ONCE and passes it to all detectors that need it,
 * avoiding redundant SQLite opens.
 *
 * @param pricingLookup  O(1) model-id lookup map
 * @param getIndexedValues  Optional — lazily-built values array from store
 * @param getLowercasedIndex  Optional — lazily-built lowercased-name index from store
 */
export async function resolveModelId(
	pricingLookup: Map<string, ModelPricingInfo>,
	getIndexedValues?: () => readonly ModelPricingInfo[],
	getLowercasedIndex?: () => Map<string, ModelPricingInfo>,
): Promise<ResolvedModel | undefined> {
	const detectors = createModelDetectors(pricingLookup, getIndexedValues, getLowercasedIndex);

	let stateModel;
	try {
		const resolution = await resolveActiveModelFromCopilotState((msg) => log.debug(msg));
		stateModel = resolution.model;
	} catch {}

	for (const detector of detectors) {
		const result = await detector.detect(pricingLookup, stateModel ?? undefined);
		if (result) {
			log.info(`resolveModelId: detected via ${detector.name} -> ${result.id}`);
			return result;
		}
	}
	log.info("resolveModelId: no detector found a match");
	return undefined;
}

// ── Detector implementations ────────────────────────────────────

/** Matches the user's explicit selection from `openrouterInsights.selectedModelId`. */
class ConfigOverrideDetector implements ModelDetector {
	readonly name = "configOverride";

	async detect(lookup: Map<string, ModelPricingInfo>): Promise<ResolvedModel | undefined> {
		const modelId = getSelectedModelId();
		if (!modelId) return undefined;
		const info = lookup.get(modelId);
		return { id: modelId, displayName: info?.name ?? modelId };
	}
}

/** Reads the active model from Copilot's state.vscdb and maps it to pricing. */
class CopilotStateDbDetector implements ModelDetector {
	readonly name = "copilotStateDb";

	async detect(
		lookup: Map<string, ModelPricingInfo>,
		stateModel?: { identifier: string; name: string; vendor: string },
	): Promise<ResolvedModel | undefined> {
		if (!stateModel) return undefined;

		if (!isVendorAllowed(stateModel.vendor)) {
			log.info("resolveModelId: skipped non-OpenRouter model due to providerFilter");
			return undefined;
		}

		const modelId = matchStateModelToPricing(stateModel, lookup);
		if (modelId) {
			return { id: modelId, displayName: stateModel.name };
		}
		return undefined;
	}
}

/** Falls back to fuzzy name/identifier matching when the direct state DB match fails. */
class FuzzyMatchDetector implements ModelDetector {
	readonly name = "fuzzyMatch";

	constructor(
		// eslint-disable-next-line no-unused-vars
		private readonly lookup: Map<string, ModelPricingInfo>,
		// eslint-disable-next-line no-unused-vars
		private readonly getIndexedValues?: () => readonly ModelPricingInfo[],
		// eslint-disable-next-line no-unused-vars
		private readonly getLowercasedIndex?: () => Map<string, ModelPricingInfo>,
	) {}

	async detect(
		_lookup: Map<string, ModelPricingInfo>,
		stateModel?: { identifier: string; name: string; vendor: string },
	): Promise<ResolvedModel | undefined> {
		if (!stateModel) return undefined;

		if (!isVendorAllowed(stateModel.vendor)) {
			log.info("resolveModelId: skipped non-OpenRouter model due to providerFilter (fuzzy match)");
			return undefined;
		}

		const valuesArray = this.getIndexedValues?.() ?? [...this.lookup.values()];
		const lowercasedIndex = this.getLowercasedIndex?.();

		const match =
			findBestMatch(valuesArray, stateModel.name, lowercasedIndex) ??
			findBestMatch(valuesArray, stateModel.identifier, lowercasedIndex);

		if (match) {
			return { id: match.id, displayName: match.name };
		}
		return undefined;
	}
}

// ── Shared helpers ──────────────────────────────────────────────

/** Returns true if the vendor is allowed per the providerFilter setting. */
function isVendorAllowed(vendor: string | undefined): boolean {
	if (getProviderFilter() === "allProviders") return true;
	return vendor === "openrouter";
}

/**
 * Map a Copilot state model to the corresponding OpenRouter pricing ID.
 * For OpenRouter models, the Copilot identifier is:
 *   openrouter/<provider>/<org>/<model>[:suffix]
 * The pricing key is: <org>/<model> or <org>/<model>:free
 */
function matchStateModelToPricing(
	stateModel: { identifier: string; name: string; vendor: string },
	pricingLookup: Map<string, ModelPricingInfo>,
): string | undefined {
	if (stateModel.vendor !== "openrouter") return undefined;

	const parts = stateModel.identifier.split("/");
	if (parts.length >= 4) {
		const orId = `${parts[2]}/${parts[3]}`;
		if (pricingLookup.has(orId)) {
			log.debug(`matchStateModelToPricing: exact match "${orId}"`);
			return orId;
		}
		const freeId = `${orId}:free`;
		if (pricingLookup.has(freeId)) {
			log.debug(`matchStateModelToPricing: matched free variant "${freeId}"`);
			return freeId;
		}
		log.debug(`matchStateModelToPricing: no match for "${orId}" or "${freeId}" in pricing lookup`);
	}

	return undefined;
}
