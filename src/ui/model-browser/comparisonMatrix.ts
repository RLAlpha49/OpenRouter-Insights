import type { ModelPricingInfo } from "../../types";

export interface ComparisonModel {
	model: ModelPricingInfo;
}

export interface ComparisonMatrix {
	models: ComparisonModel[];
}

/** Build the model comparison matrix. */
export function buildComparisonMatrix(models: readonly ModelPricingInfo[]): ComparisonMatrix {
	return { models: models.map((model) => ({ model })) };
}
