import { describe, expect, it } from "vitest";
import {
	buildTemplateContext,
	compileTemplate,
	renderStatusBarText,
} from "../../ui/status/statusBarTemplate";
import type { ModelPricingInfo } from "../../types";

function makePricing(overrides: Partial<ModelPricingInfo> = {}): ModelPricingInfo {
	return {
		id: "openai/gpt-4o",
		name: "GPT-4o",
		blendedRate: 5,
		contextLength: 128000,
		contextLengthFormatted: "128K",
		maxOutputLength: 16384,
		isDeprecated: false,
		isFree: false,
		discountToUser: 0,
		quantization: "",
		modality: "text+image->text",
		inputModalities: ["text", "image"],
		outputModalities: ["text"],
		perMillion: {
			prompt: 2.5,
			completion: 10,
			image: 0,
			request: 0,
			inputCacheRead: 1.25,
			inputCacheWrite: 2.5,
			webSearch: 0,
			internalReasoning: 0,
		},
		topProviderContextLength: 0,
		topProviderMaxCompletionTokens: 0,
		topProviderIsModerated: false,
		topProviderId: "",
		topProviderName: "",
		supportedParameters: [],
		supportedFeatures: [],
		deprecationDate: "",
		description: "",
		created: 1717804800,
		detailsLink: "",
		...overrides,
	};
}

describe("buildTemplateContext", () => {
	it("includes pricing and model fields", () => {
		const ctx = buildTemplateContext(makePricing(), "GPT-4o", 0);

		expect(ctx.modelName).toBe("GPT-4o");
		expect(ctx.priceText).toBe("~$5.00/M");
		expect(ctx.blendedRate).toContain("/M");
		expect(ctx.promptPrice).toContain("/M");
		expect(ctx.completionPrice).toContain("/M");
		expect(ctx.contextLength).toBe("128K");
		expect(ctx.deprecation).toBe("");
	});

	it("uses the model name when displayName is missing", () => {
		expect(buildTemplateContext(makePricing({ name: "TestModel" }), undefined, 0).modelName).toBe(
			"TestModel",
		);
	});

	it("truncates the model name when maxLen is set", () => {
		expect(buildTemplateContext(makePricing(), "VeryLongModelName", 8).modelName).toBe("VeryLon…");
	});

	it("includes a warning for deprecated models", () => {
		expect(buildTemplateContext(makePricing({ isDeprecated: true }), "GPT-4o", 0).deprecation).toBe(
			" $(warning)",
		);
	});

	it("shows free indicator for free models", () => {
		const ctx = buildTemplateContext(
			makePricing({
				blendedRate: 0,
				isFree: true,
				perMillion: {
					prompt: 0,
					completion: 0,
					image: 0,
					request: 0,
					inputCacheRead: 0,
					inputCacheWrite: 0,
					webSearch: 0,
					internalReasoning: 0,
				},
			}),
			"FreeModel",
			0,
		);
		expect(ctx.priceText).toBe("$(gift)");
		expect(ctx.blendedRate).toBe("Free");
	});
});

describe("compileTemplate", () => {
	const ctx = buildTemplateContext(makePricing(), "GPT-4o", 0);

	it("replaces known variables", () => {
		expect(compileTemplate("${modelName} ${blendedRate}", ctx)).toBe("GPT-4o $5.00/M");
	});

	it("leaves unknown and unmatched variables unchanged", () => {
		expect(compileTemplate("${unknownVar} ${ world", ctx)).toBe("${unknownVar} ${ world");
	});

	it("returns empty and literal templates unchanged", () => {
		expect(compileTemplate("", ctx)).toBe("");
		expect(compileTemplate("Just text", ctx)).toBe("Just text");
	});
});

describe("renderStatusBarText", () => {
	it("renders a non-empty status bar string for a valid model", () => {
		const result = renderStatusBarText(makePricing(), "GPT-4o", 0);
		expect(result).toBeTruthy();
		expect(result.length).toBeGreaterThan(0);
	});

	it("renders free models", () => {
		const result = renderStatusBarText(
			makePricing({
				blendedRate: 0,
				isFree: true,
				perMillion: {
					prompt: 0,
					completion: 0,
					image: 0,
					request: 0,
					inputCacheRead: 0,
					inputCacheWrite: 0,
					webSearch: 0,
					internalReasoning: 0,
				},
			}),
			"FreeModel",
			0,
		);
		expect(result).toBeTruthy();
	});
});
