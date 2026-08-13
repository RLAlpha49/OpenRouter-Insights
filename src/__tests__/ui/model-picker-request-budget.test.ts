import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ModelPickerEnhancer } from "../../ui/model-browser/modelPickerEnhancer";
import type { ModelPricingInfo } from "../../types";

function model(id: string): ModelPricingInfo {
	return {
		id,
		name: id,
		description: "",
		blendedRate: 1,
		perMillion: {
			prompt: 1,
			completion: 1,
			inputCacheRead: 0,
			inputCacheWrite: 0,
			internalReasoning: 0,
			webSearch: 0,
			image: 0,
			request: 0,
		},
		contextLength: 1000,
		contextLengthFormatted: "1K",
		isFree: false,
		isDeprecated: false,
		discountToUser: 0,
	} as ModelPricingInfo;
}

describe("model browser request budget", () => {
	it("opens from pricing data without starting catalog enrichment", async () => {
		const picker = new ModelPickerEnhancer();
		const executeCommand = vi.spyOn(vscode.commands, "executeCommand");
		await picker.showModelBrowser([model("openai/one"), model("google/two")]);
		expect(executeCommand).not.toHaveBeenCalledWith(
			expect.stringMatching(/metric|enrich/i),
			expect.anything(),
		);
		(vscode.window as any)._quickPicks.at(-1)?.triggerHide();
	});
});
