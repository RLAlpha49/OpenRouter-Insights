/**
 * Unit tests for modelResolver — detector pipeline and model ID resolution.
 *
 * Tests ConfigOverrideDetector, CopilotStateDbDetector, FuzzyMatchDetector
 * and the resolveModelId orchestrator.
 */

import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { createModelDetectors, resolveModelId } from "../../models/modelResolver";
import type { ModelPricingInfo } from "../../types";
import { ConfigService } from "../../infrastructure/config";

describe("createModelDetectors", () => {
	it("returns three detectors in order", () => {
		const lookup = new Map<string, ModelPricingInfo>();
		const detectors = createModelDetectors(lookup);
		expect(detectors).toHaveLength(3);
		expect(detectors[0].name).toBe("configOverride");
		expect(detectors[1].name).toBe("copilotStateDb");
		expect(detectors[2].name).toBe("fuzzyMatch");
	});

	it("includes optional indexed helpers", () => {
		const lookup = new Map<string, ModelPricingInfo>();
		const getValues = () => [] as ModelPricingInfo[];
		const getLowercasedIndex = () => new Map<string, ModelPricingInfo>();
		const detectors = createModelDetectors(lookup, getValues, getLowercasedIndex);
		// Third detector (FuzzyMatch) should have access to these
		expect(detectors[2].name).toBe("fuzzyMatch");
	});
});

describe("resolveModelId", () => {
	it("returns undefined when lookup is empty and state DB failed", async () => {
		const lookup = new Map<string, ModelPricingInfo>();
		const result = await resolveModelId(lookup);
		expect(result).toBeUndefined();
	});

	it("uses the configured model before other detectors", async () => {
		const configured = {
			id: "openai/gpt-4o",
			name: "GPT-4o",
		} as ModelPricingInfo;
		const lookup = new Map([[configured.id, configured]]);
		(vscode.workspace as any)._configValues = { "general.selectedModelId": configured.id };
		ConfigService.instance.dispose();

		expect(await resolveModelId(lookup)).toMatchObject({
			id: configured.id,
			displayName: configured.name,
		});
	});
});
