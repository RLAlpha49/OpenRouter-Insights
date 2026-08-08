/**
 * Status bar template engine — compiles user-defined template strings
 * into rendered status bar text.
 *
 * Supports the following variables:
 *   ${modelName}      — truncated model display name
 *   ${priceText}      — compact blended rate (e.g. "~$0.50/M")
 *   ${blendedRate}    — estimated blended rate (e.g. "$0.50/M")
 *   ${promptPrice}    — prompt-only price (e.g. "$2.50/M")
 *   ${completionPrice}— completion-only price (e.g. "$10.00/M")
 *   ${contextLength}  — formatted context length (e.g. "128K")
 *   ${deprecation}    — " $(warning)" when deprecated, "" otherwise
 *
 * Falls back to default template on parse error.
 */

import { getStatusBarTemplate } from "../../infrastructure/config";
import type { ModelPricingInfo } from "../../types";
import { fmtPrice, truncate } from "../formatting/formatting";

export interface TemplateContext {
	modelName: string;
	priceText: string;
	blendedRate: string;
	promptPrice: string;
	completionPrice: string;
	contextLength: string;
	deprecation: string;
}

/**
 * Build a TemplateContext from a ModelPricingInfo and config state.
 * All values are pre-formatted strings ready for interpolation.
 */
export function buildTemplateContext(
	pricing: ModelPricingInfo,
	displayName: string | undefined,
	maxLen: number,
): TemplateContext {
	const name = displayName ?? pricing.name;
	const isFree = pricing.isFree || pricing.blendedRate === 0;
	const priceText = isFree ? "$(gift)" : `~$${fmtPrice(pricing.blendedRate)}/M`;

	return {
		modelName: maxLen > 0 ? truncate(name, maxLen) : name,
		priceText,
		blendedRate: isFree ? "Free" : `$${fmtPrice(pricing.blendedRate)}/M`,
		promptPrice: `$${fmtPrice(pricing.perMillion.prompt)}/M`,
		completionPrice: `$${fmtPrice(pricing.perMillion.completion)}/M`,
		contextLength: pricing.contextLengthFormatted,
		deprecation: pricing.isDeprecated ? " $(warning)" : "",
	};
}

/**
 * Compile a template string with ${variable} placeholders.
 * Unknown variables are left as-is. "${" without matching "}" is
 * left as-is. Falls back to the default template on structural errors.
 */
export function compileTemplate(template: string, ctx: TemplateContext): string {
	return template.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
		if (varName in ctx) {
			return (ctx as unknown as Record<string, string>)[varName];
		}
		return _match; // unknown variable — leave as-is
	});
}

/**
 * Render the status bar text from pricing info using the configured template.
 * Safe — always returns a non-empty string.
 */
export function renderStatusBarText(
	pricing: ModelPricingInfo,
	displayName: string | undefined,
	maxLen: number,
): string {
	const ctx = buildTemplateContext(pricing, displayName, maxLen);
	const template = getStatusBarTemplate();
	try {
		const result = compileTemplate(template, ctx);
		return result || ctx.modelName; // fallback to just the name if empty
	} catch {
		// Template compilation threw — fall back to default format
		return `${ctx.modelName} ${ctx.priceText}${ctx.deprecation}`;
	}
}
