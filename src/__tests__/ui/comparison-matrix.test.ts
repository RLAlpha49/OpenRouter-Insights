import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { buildComparisonMatrix } from "../../ui/model-browser/comparisonMatrix";
import {
	showComparisonWebview,
	type ComparisonSort,
} from "../../ui/model-browser/comparisonViewService";
import type { ModelPricingInfo } from "../../types";

function model(overrides: Partial<ModelPricingInfo> = {}): ModelPricingInfo {
	return {
		id: "openai/gpt-4o",
		name: "GPT-4o",
		blendedRate: 5,
		contextLength: 128000,
		contextLengthFormatted: "128K",
		maxOutputLength: 4096,
		isDeprecated: false,
		deprecationDate: "",
		isFree: false,
		discountToUser: 0,
		quantization: "",
		modality: "text->text",
		inputModalities: ["text"],
		outputModalities: ["text"],
		perMillion: {
			prompt: 2,
			completion: 8,
			image: 0,
			request: 0,
			inputCacheRead: 1,
			inputCacheWrite: 2,
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
		created: 0,
		detailsLink: "",
		description: "",
		...overrides,
	};
}

describe("buildComparisonMatrix", () => {
	it("keeps model pricing data in the comparison matrix", () => {
		const matrix = buildComparisonMatrix([
			model({ topProviderId: "openai", supportedFeatures: ["tools"] }),
			model({
				id: "anthropic/claude",
				name: "Claude",
				blendedRate: 8,
				topProviderName: "Anthropic",
			}),
		]);
		expect(matrix.models[0].model.blendedRate).toBe(5);
	});
});

describe("comparison view contract", () => {
	it("accepts the supported comparison sort values", () => {
		const validSorts: ComparisonSort[] = ["blendedRate", "priceDesc"];
		expect(validSorts).toEqual(["blendedRate", "priceDesc"]);
		expect(typeof showComparisonWebview).toBe("function");
	});

	it("creates a comparison panel with command URIs enabled", () => {
		const createPanel = vi.spyOn(vscode.window, "createWebviewPanel");
		showComparisonWebview([model(), model({ id: "anthropic/claude", name: "Claude" })]);
		expect(createPanel).toHaveBeenCalledWith(
			"openrouterComparison",
			expect.any(String),
			undefined,
			expect.objectContaining({ enableScripts: false, enableCommandUris: true }),
		);
		createPanel.mockRestore();
	});
});
