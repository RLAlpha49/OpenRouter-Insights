import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConfigService } from "../../infrastructure/config";
import { showModelDetailWebview } from "../../ui/webviews/modelDetailView";
import type { ModelPricingInfo } from "../../types";

function model(overrides: Partial<ModelPricingInfo> = {}): ModelPricingInfo {
	return {
		id: "openai/detail-model",
		name: "Detail <Model>",
		perMillion: {
			prompt: 1.25,
			completion: 3.5,
			image: 0,
			request: 0,
			inputCacheRead: 0,
			inputCacheWrite: 0,
			webSearch: 0,
			internalReasoning: 0,
		},
		blendedRate: 1.8125,
		contextLength: 1234567,
		contextLengthFormatted: "1,234,567",
		maxOutputLength: 4096,
		created: Date.parse("2026-08-01T00:00:00Z") / 1000,
		isDeprecated: false,
		deprecationDate: "",
		isFree: false,
		modality: "text->text",
		description: "Description <unsafe>",
		supportedParameters: ["json_mode"],
		supportedFeatures: ["tools"],
		topProviderIsModerated: false,
		topProviderContextLength: 987654,
		topProviderMaxCompletionTokens: 2048,
		quantization: "fp16",
		detailsLink: "",
		discountToUser: 0,
		topProviderId: "openai",
		topProviderName: "OpenAI",
		inputModalities: ["text"],
		outputModalities: ["text"],
		...overrides,
	};
}

describe("model detail presentation", () => {
	beforeEach(() => {
		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = {};
	});

	it("renders configured USD formatting and complete actions", () => {
		const createPanel = vi.spyOn(vscode.window, "createWebviewPanel");
		showModelDetailWebview(model());
		const html = createPanel.mock.results.at(-1)?.value.webview.html as string;
		expect(html).toContain("$1.25");
		expect(html).toContain("$1.81");
		expect(html).toContain("1,234,567 tokens");
		expect(html).toContain("Open on OpenRouter");
		expect(html).toContain("openrouter-insights.copyModelId");
		expect(html).toContain("openrouter-insights.refreshPricing");
		expect(html).toContain("openrouter-insights.addToFavorites");
		expect(html).toContain("&lt;unsafe&gt;");
		createPanel.mockRestore();
	});

	it("uses the configured non-USD currency for pricing rows and blended rate", () => {
		const createPanel = vi.spyOn(vscode.window, "createWebviewPanel");
		(vscode.workspace as any)._configValues = {
			"general.currency": "EUR",
			"general.currencyRate": 0.92,
		};
		showModelDetailWebview(model());
		const html = createPanel.mock.results.at(-1)?.value.webview.html as string;
		expect(html).toContain("~€1.15");
		expect(html).toContain("~€1.67");
		createPanel.mockRestore();
	});
});
