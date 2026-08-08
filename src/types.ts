/**
 * Type definitions for the OpenRouter Models API response.
 * @see https://openrouter.ai/docs/api-reference/models/list-models
 */

/** Pricing per token (OpenRouter may encode values as strings or numbers). */
export interface OpenRouterPricing {
	prompt: string | number;
	completion: string | number;
	image: string | number;
	request: string | number;
	input_cache_read: string | number;
	input_cache_write: string | number;
	web_search: string | number;
	internal_reasoning: string | number;
}

/**
 * Top provider metadata from the /models endpoint.
 */
export interface OpenRouterTopProvider {
	/** Provider identifier (e.g. "openai", "anthropic"). */
	id?: string;
	/** Human-readable provider name. */
	name?: string;
	/** Provider-specific context length (may differ from model-level). */
	context_length?: number;
	/** Whether the top provider applies content moderation. */
	is_moderated?: boolean;
	/** Provider-specific max completion tokens. */
	max_completion_tokens?: number;
}

/** A single model from the OpenRouter /api/v1/models response. */
export interface OpenRouterModel {
	id: string;
	name: string;
	created: number;
	description: string;
	context_length: number;
	/** Maximum output tokens the model supports. */
	max_output_length?: number;
	pricing: OpenRouterPricing;
	/** Architecture/modality info. */
	architecture?: {
		modality?: string;
		tokenizer?: string;
		instruct_type?: string;
	};
	/** Top provider metadata (id, context_length, is_moderated, max_completion_tokens). */
	top_provider?: OpenRouterTopProvider;
	/** Parameters the model supports (e.g. temperature, tools, json_mode). */
	supported_parameters?: string[];
	/** Features the model supports. */
	supported_features?: string[];
	/** ISO 8601 deprecation date, when provided by OpenRouter. */
	deprecation_date?: string;
	/** Whether this model is free (including promotional subsidies). */
	is_free?: boolean;
	/** Whether this model is ready for production use. */
	is_ready?: boolean;
	/** Quantization level (e.g. "fp16", "int8", "int4"). */
	quantization?: string;
	/** Links related to the model. */
	links?: { details?: string };
	/** Canonical slug for the model. */
	canonical_slug?: string;
	/** Knowledge cutoff date. */
	knowledge_cutoff?: string;
	/** Fractional discount applied to this model (0–1), e.g. 0.5 = 50% off. */
	discount_to_user?: number;
	/** Input modalities this model accepts (e.g. ["text", "image", "file"]). */
	input_modalities?: string[];
	/** Output modalities this model produces (e.g. ["text"]). */
	output_modalities?: string[];
}

/** Top-level response from GET /api/v1/models. */
export interface OpenRouterModelsResponse {
	data: OpenRouterModel[];
}

/** Normalised pricing in USD per 1M tokens (for display). */
export interface DisplayPricing {
	prompt: number;
	completion: number;
	image: number;
	request: number;
	inputCacheRead: number;
	inputCacheWrite: number;
	webSearch: number;
	internalReasoning: number;
}

/** Our internal model representation with computed display pricing. */
export interface ModelPricingInfo {
	/** OpenRouter model ID, e.g. "openai/gpt-4o" */
	id: string;
	/** Display name, e.g. "OpenAI: GPT-4o" */
	name: string;
	/** Pricing per 1M tokens in USD. */
	perMillion: DisplayPricing;
	/**
	 * Estimated blended rate per 1M tokens based on a 3:1 prompt:completion mix.
	 * This is an industry-standard rough estimate of chat-model cost.
	 * Actual cost varies significantly with cache-hit rate and usage patterns.
	 * For models with internal_reasoning pricing, that cost is included in the
	 * completion side of the blend since reasoning tokens are output-side.
	 */
	blendedRate: number;
	/** Context window length. */
	contextLength: number;
	/** Pre-formatted context length (locale-aware), computed once during parse. */
	contextLengthFormatted: string;
	/** Maximum output tokens the model supports. */
	maxOutputLength: number;
	/** Unix timestamp of when the model was created (from OpenRouter API). */
	created: number;
	/** True when the model appears to be deprecated (old or has deprecation keywords). */
	isDeprecated: boolean;
	/** Deprecation date from the API (ISO 8601), or empty string if not set. */
	deprecationDate: string;
	/** Whether this model is free (API-reported, not just zero blended rate). */
	isFree: boolean;
	/** Modality string from the API architecture field, e.g. "text+image->text". */
	modality: string;
	/** OpenRouter model description (for text search). */
	description: string;
	/** Parameters the model supports (e.g. tools, json_mode, reasoning). */
	supportedParameters: string[];
	/** Features the model supports. */
	supportedFeatures: string[];
	/** Whether the top provider is moderated. */
	topProviderIsModerated: boolean;
	/** Provider-specific context length (may differ from model-level). */
	topProviderContextLength: number;
	/** Provider-specific max completion tokens. */
	topProviderMaxCompletionTokens: number;
	/** Quantization level, if any. */
	quantization: string;
	/** Link to model details page on OpenRouter. */
	detailsLink: string;
	/** Fractional discount applied by OpenRouter (0–1), 0 when not discounted. */
	discountToUser: number;
	/** Top provider ID from the API (e.g. "openai"), empty string when unavailable. */
	topProviderId: string;
	/** Top provider display name from the API, empty string when unavailable. */
	topProviderName: string;
	/** Input modalities this model accepts (e.g. ["text", "image", "file"]). */
	inputModalities?: string[];
	/** Output modalities this model produces (e.g. ["text"]). */
	outputModalities?: string[];
	/** Whether OpenRouter reports that the model is ready for production use. */
	isReady?: boolean;
}

/** Safe response-contract health retained at domain boundaries. */
export interface ContractHealth {
	status: "valid" | "partial";
	issueCount: number;
	issues: Array<{ path: string; message: string }>;
}

/** Shape of the data persisted to ExtensionContext.globalState. */
export interface CachedPricingData {
	/** ISO timestamp of when the data was fetched. */
	fetchedAt: string;
	/** All model pricing entries. */
	models: ModelPricingInfo[];
	/** Pagination health for the last model refresh. */
	pagination?: {
		pagesFetched: number;
		truncated: boolean;
		reason?: "page-cap" | "repeated-link" | "cross-origin-link" | "invalid-link";
	};
	/** True when the last fetch returned only a partial page set. */
	truncated?: boolean;
	/** Contract health for the models response, including retained partial issues. */
	contractHealth?: ContractHealth;
}

// ── Runtime cache-entry validation ────────────────────

/** Numeric fields of `DisplayPricing` that must be finite and non-negative. */
const PRICING_NUMERIC_FIELDS: ReadonlyArray<keyof DisplayPricing> = [
	"prompt",
	"completion",
	"image",
	"request",
	"inputCacheRead",
	"inputCacheWrite",
	"webSearch",
	"internalReasoning",
];

/** Numeric fields of `ModelPricingInfo` that must be finite and non-negative. */
const MODEL_NUMERIC_FIELDS: ReadonlyArray<keyof ModelPricingInfo> = [
	"blendedRate",
	"contextLength",
	"maxOutputLength",
	"created",
	"topProviderContextLength",
	"topProviderMaxCompletionTokens",
	"discountToUser",
];

/** Collection fields of `ModelPricingInfo` that must be arrays. */
const MODEL_ARRAY_FIELDS: ReadonlyArray<keyof ModelPricingInfo> = [
	"supportedParameters",
	"supportedFeatures",
	"inputModalities",
	"outputModalities",
];

/**
 * Validate a single persisted `ModelPricingInfo` entry before it is
 * published into the cache. Guards against structurally shallow but
 * malformed persisted data reaching pricing, sorting, export, or cost
 * calculations.
 *
 * Returns the first rejected field path, or undefined when the entry is
 * valid. The caller decides whether to discard the entry or the whole
 * cache according to its partial-data policy.
 */
export function validateCachedModelEntry(m: unknown): string | undefined {
	if (typeof m !== "object" || m === null) return "model";
	const model = m as Record<string, unknown>;

	if (typeof model.id !== "string" || model.id.length === 0) return "model.id";
	if (typeof model.name !== "string") return "model.name";

	const perMillion = model.perMillion;
	if (typeof perMillion !== "object" || perMillion === null) return "model.perMillion";
	const pricing = perMillion as Record<string, unknown>;
	for (const field of PRICING_NUMERIC_FIELDS) {
		if (!isFiniteNonNegativeNumber(pricing[field])) return `model.perMillion.${field}`;
	}

	for (const field of MODEL_NUMERIC_FIELDS) {
		if (!isFiniteNonNegativeNumber(model[field])) return `model.${field}`;
	}

	for (const field of MODEL_ARRAY_FIELDS) {
		const value = model[field];
		if (value !== undefined && !Array.isArray(value)) return `model.${field}`;
	}

	return undefined;
}

/** True when `value` is a finite, non-negative number. */
function isFiniteNonNegativeNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The vendor ID for Copilot's built-in OpenRouter BYOK provider.
 * Models from this vendor have their `id` set to the OpenRouter
 * model ID (e.g. `openai/gpt-4o`), which maps directly to pricing data.
 */
export const OPENROUTER_VENDOR_ID = "openrouter";

/**
 * A single step in the model-detection pipeline.
 * Each detector knows how to find the currently-active OpenRouter model
 * from one source (config, Copilot state DB, fuzzy name match, etc.).
 */
export interface ModelDetector {
	/** Human-readable name for logging. */
	readonly name: string;
	/**
	 * Try to detect the active model. Returns undefined if this source has no match.
	 * @param lookup  Pricing data lookup map
	 * @param stateModel  Pre-resolved Copilot state (resolved once by the pipeline)
	 */
	detect(
		_lookup: Map<string, ModelPricingInfo>,
		_stateModel?: { identifier: string; name: string; vendor: string; family: string },
	): Promise<ResolvedModel | undefined>;
}

/** The result of a successful model detection. */
export interface ResolvedModel {
	id: string;
	displayName: string;
}
