/**
 * Shared formatting helpers used across the extension.
 * Pure functions with no side effects — safe to use from any module.
 */

import * as vscode from "vscode";
import type { ModelPricingInfo } from "../../types";
import { computeBlendedRate } from "../../api/clients/pricingService";
import { getBlendWeights } from "../../infrastructure/config";
import { BLEND_NO_CACHE, effectiveBlendWeights } from "../../models/domain";

/**
 * Format a USD-per-million-tokens price for display.
 * Handles edge cases: NaN, 0 (free), very small, and typical values.
 */
export function fmtPrice(usdPerMillion: number | undefined): string {
	if (usdPerMillion == null || Number.isNaN(usdPerMillion)) return "?";
	if (usdPerMillion === 0) return "free";
	if (usdPerMillion < 0.01) return `${usdPerMillion.toFixed(3)}`;
	if (usdPerMillion < 1) return usdPerMillion.toFixed(2);
	if (usdPerMillion < 10) return usdPerMillion.toFixed(2);
	return usdPerMillion.toFixed(1);
}

/** Truncate a string to maxLen, appending '…' if it was cut. */
export function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

/**
 * Compute blendedRate on-the-fly for stale cache entries that pre-date
 * this field, or use the stored value if present.
 * Delegates to the canonical computeBlendedRate from pricingService
 * for a single source of truth.
 */
export function ensureBlended(p: ModelPricingInfo): number {
	if (typeof p.blendedRate === "number" && !Number.isNaN(p.blendedRate)) {
		return p.blendedRate;
	}
	return computeBlendedRate(p.perMillion, { ...BLEND_NO_CACHE, cacheRead: 0, cacheWrite: 0 });
}

/** Coerce a possibly-null/NaN number from a stale JSON cache to 0. */
export function coerceNum(v: number | null | undefined): number {
	return typeof v === "number" && !Number.isNaN(v) ? v : 0;
}

/**
 * Format a blend weight percentage for display.
 * Shows decimals when they exist (e.g., 12.5%), otherwise shows whole number (e.g., 12%).
 */
export function fmtBlendPct(weight: number): string {
	const pct = weight * 100;
	if (Number.isInteger(pct)) {
		return `${pct}%`;
	}
	return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

/** Escape markdown control characters in plain text meant for MarkdownString. */
export function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, String.raw`\$&`);
}

/** Build the predictable action footer shared by pricing tooltips. */
export function buildPricingActionLinks(modelId?: string): string {
	const openRouterLink = modelId
		? ` &middot; [$(link-external) Open on OpenRouter](https://openrouter.ai/models/${encodeURI(modelId)})`
		: "";
	const modelDetails = modelId
		? ` &middot; [$(info) Model details](command:openrouter-insights.viewModelDetail?${encodeURIComponent(JSON.stringify(modelId))})`
		: "";
	return (
		`[$(refresh) Refresh](command:openrouter-insights.refreshPricing) &middot; ` +
		`[$(list-tree) Browse all models](command:openrouter-insights.browseModels) &middot; ` +
		`[$(copy) Copy ID](command:openrouter-insights.copyModelId)` +
		openRouterLink +
		modelDetails
	);
}

/** Build combined badge string for the tooltip hero line. */
function buildBadges(p: ModelPricingInfo): string {
	const parts: string[] = [];
	if (p.isFree) parts.push(" $(gift)");
	if (p.discountToUser > 0 && p.discountToUser < 1) {
		parts.push(` $(tag) **${Math.round(p.discountToUser * 100)}% OFF**`);
	}
	if (p.isDeprecated) parts.push(" $(warning) **DEPRECATED**");
	return parts.join("");
}

/**
 * Build a tooltip for a model's pricing.
 *
 * @param p Model pricing info
 * @param cacheNote Cache-age footer note (may be empty)
 */
export function buildTooltipMd(p: ModelPricingInfo, cacheNote: string): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;
	md.supportHtml = true;
	md.supportThemeIcons = true;

	const pm = p.perMillion;
	const blended = ensureBlended(p);
	const weights = getBlendWeights();
	const displayWeights = effectiveBlendWeights(
		weights,
		pm.inputCacheRead > 0,
		pm.inputCacheWrite > 0,
	);
	const safeName = escapeMarkdown(p.name);
	const isFree = p.isFree || blended === 0;
	p.isFree = isFree;
	const badges = buildBadges(p);

	// ── Hero: model name → monospace blended rate → blend ratio ──
	const hero: string[] = [`## ${safeName}${badges}`, ""];

	if (!isFree) {
		hero.push(
			"```",
			`~$${blended.toFixed(4)} /M`,
			"```",
			`*${fmtBlendPct(displayWeights.cacheRead)} cache read · ${fmtBlendPct(displayWeights.cacheWrite)} cache write · ${fmtBlendPct(displayWeights.prompt)} prompt · ${fmtBlendPct(displayWeights.completion)} completion*`,
			"",
		);
	}

	// ── Bordered pricing table ───────────────────────────────────
	const pricingRows: string[] = [];
	if (!isFree) {
		if (coerceNum(pm.prompt) > 0)
			pricingRows.push(
				`<tr><td>$(arrow-right) Prompt</td><td align="right"><b>$${fmtNum(pm.prompt)}</b></td></tr>`,
			);
		if (coerceNum(pm.completion) > 0)
			pricingRows.push(
				`<tr><td>$(arrow-left) Completion</td><td align="right"><b>$${fmtNum(pm.completion)}</b></td></tr>`,
			);
		if (coerceNum(pm.inputCacheRead) > 0)
			pricingRows.push(
				`<tr><td>$(database) Cache read</td><td align="right">$${fmtNum(pm.inputCacheRead)}</td></tr>`,
			);
		if (coerceNum(pm.inputCacheWrite) > 0)
			pricingRows.push(
				`<tr><td>$(edit) Cache write</td><td align="right">$${fmtNum(pm.inputCacheWrite)}</td></tr>`,
			);
		if (coerceNum(pm.internalReasoning) > 0)
			pricingRows.push(
				`<tr><td>$(lightbulb) Reasoning</td><td align="right">$${fmtNum(pm.internalReasoning)}</td></tr>`,
			);
		if (coerceNum(pm.webSearch) > 0)
			pricingRows.push(
				`<tr><td>$(search) Web search</td><td align="right">$${fmtNum(pm.webSearch)}</td></tr>`,
			);
		if (coerceNum(pm.image) > 0)
			pricingRows.push(
				`<tr><td>$(file-media) Image</td><td align="right">$${fmtNum(pm.image)}</td></tr>`,
			);
		if (coerceNum(pm.request) > 0)
			pricingRows.push(
				`<tr><td>$(link) Request</td><td align="right">$${fmtNum(pm.request)}</td></tr>`,
			);
	}

	pricingRows.push(
		`<tr><td>$(list-unordered) Max context</td><td align="right"><b>${String(p.contextLengthFormatted)} tokens</b></td></tr>`,
	);
	if (p.maxOutputLength > 0)
		pricingRows.push(
			`<tr><td>$(output) Max output</td><td align="right"><b>${p.maxOutputLength.toLocaleString()} tokens</b></td></tr>`,
		);

	const pricingTable = [
		'<table border="1" cellpadding="6" cellspacing="0" width="100%">',
		`<tr><th colspan="2" align="left">P R I C I N G  &middot;  per 1M tokens</th></tr>`,
		...pricingRows,
		"</table>",
		"",
	];

	// ── Deprecation warning ──────────────────────────────────────
	const depFooter: string[] = [];
	if (p.isDeprecated) {
		const dateNote = p.deprecationDate
			? `Deprecates on **${p.deprecationDate.slice(0, 10)}**.`
			: "May be **deprecated**.";
		depFooter.push("---", `$(warning) ${dateNote} Check OpenRouter for alternatives.`, "");
	}

	// ── Update timestamp and action links ────────────────────────
	const footer = cacheNote
		? [cacheNote, "", buildPricingActionLinks(p.id)]
		: [buildPricingActionLinks(p.id)];

	const sections = [...hero];
	if (!isFree) {
		sections.push(...pricingTable);
	}
	sections.push(...depFooter, ...footer);

	md.appendMarkdown(sections.join("\n"));
	return md;
}

/**
 * Format a number for display in a tooltip table.
 * Avoids calling `coerceNum` every time — returns a fixed-precision string.
 */
function fmtNum(v: number): string {
	const n = coerceNum(v);
	if (n === 0) return "0";
	if (n < 0.01) return n.toFixed(3);
	return n.toFixed(2);
}

/**
 * One-line pricing summary for QuickPick detail rows.
 */
export function pricingDetail(m: ModelPricingInfo): string {
	const blended = ensureBlended(m);
	const weights = getBlendWeights();
	const displayWeights = effectiveBlendWeights(
		weights,
		m.perMillion.inputCacheRead > 0,
		m.perMillion.inputCacheWrite > 0,
	);
	const pmt = (val: number) => (val > 0 ? `$${val.toFixed(2)}` : "FREE");
	const dep = m.isDeprecated ? " ⚠️ Possibly deprecated" : "";
	const isFree = m.isFree || blended === 0;

	if (isFree) {
		return `$(gift) **FREE**  •  Context: ${m.contextLengthFormatted} tok${dep}`;
	}

	return (
		`~$${blended.toFixed(4)}/Mtok est. blend (${fmtBlendPct(displayWeights.cacheRead)}:${fmtBlendPct(displayWeights.cacheWrite)}:${fmtBlendPct(displayWeights.prompt)}:${fmtBlendPct(displayWeights.completion)} cache-read:cache-write:input:output)  •  ` +
		`Prompt: ${pmt(m.perMillion.prompt)}/Mtok  •  ` +
		`Completion: ${pmt(m.perMillion.completion)}/Mtok  •  ` +
		`Context: ${m.contextLengthFormatted} tok` +
		dep
	);
}
