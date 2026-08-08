/**
 * ComparisonViewService — builds a webview-based side-by-side model
 * comparison table with cheapest-highlight, price difference %, and
 * blended-rate sort order.
 *
 * Extracted from ModelPickerEnhancer so the HTML generation is
 * independently testable and the CSP policy is centralized.
 */

import * as vscode from "vscode";
import type { ModelPricingInfo } from "../../types";
import { escapeHtml } from "../escapeHtml";
import { buildComparisonDocument } from "../webviewAssets";

/** Sort direction for comparison table columns. */
export type ComparisonSort = "blendedRate" | "priceDesc";

/**
 * CSS class for the cheapest (or highest) highlighted value.
 */
const CHEAPEST_CLASS = "or-cheapest";

/**
 * Row labels that participate in tie-breaking by accumulated highlight count.
 * When multiple models share the same minimum price, the model with more
 * existing highlights across these rows wins the highlight. If highlight
 * counts are also equal, all tied models are highlighted.
 *
 * These rows also treat missing (0) values as legitimate prices — a model
 * that doesn't charge for cache read (0) beats one that does ($1.00).
 */
const TIEBREAK_LABELS: ReadonlySet<string> = new Set([
	"Blended Rate",
	"Prompt",
	"Completion",
	"Cache Read",
	"Cache Write",
	"Reasoning",
]);

/**
 * Row labels where a missing (0) value means the model simply doesn't have
 * that capability. These rows exclude zero from cheapest computation.
 */
const EXCLUDE_ZERO_LABELS: ReadonlySet<string> = new Set(["Web Search", "Image", "Request"]);

/**
 * Open a webview comparing 2–5 models side-by-side.
 * Models are sorted by blended rate (cheapest first).
 * The cheapest value in each numeric pricing row is highlighted.
 * Price difference percentages are shown relative to the cheapest.
 */
export function showComparisonWebview(
	selected: ModelPricingInfo[],
	sort: ComparisonSort = "blendedRate",
): void {
	const sorted = sortModelsForComparison(selected, sort);
	const panel = vscode.window.createWebviewPanel(
		"openrouterComparison",
		"OpenRouter Model Comparison",
		vscode.ViewColumn.Beside,
		{ enableScripts: false, enableCommandUris: true, retainContextWhenHidden: true },
	);
	panel.webview.html = buildComparisonHtml(sorted, sort);
}

function sortModelsForComparison(
	models: ModelPricingInfo[],
	sort: ComparisonSort,
): ModelPricingInfo[] {
	const copy = [...models];
	if (sort === "blendedRate") {
		copy.sort((a, b) => a.blendedRate - b.blendedRate);
	} else {
		copy.sort((a, b) => b.blendedRate - a.blendedRate);
	}
	return copy;
}

// ── Helpers for cheapest detection and diff % ─────────────────

interface PriceRow {
	label: string;
	/** Get the numeric price for a model, or NaN if not applicable. */
	getValue: (_m: ModelPricingInfo) => number;
	/** Format the value for display. */
	format: (_val: number, _m: ModelPricingInfo) => string;
	/** Suffix for the diff% display (e.g. "/M tok"). */
	unit: string;
}

const PRICE_ROWS: PriceRow[] = [
	{
		label: "Blended Rate",
		getValue: (m) => m.blendedRate,
		format: (v) => `$${v.toFixed(4)}`,
		unit: "/M tok",
	},
	{
		label: "Prompt",
		getValue: (m) => m.perMillion.prompt,
		format: (v) => `$${v.toFixed(4)}`,
		unit: "/M tok",
	},
	{
		label: "Completion",
		getValue: (m) => m.perMillion.completion,
		format: (v) => `$${v.toFixed(4)}`,
		unit: "/M tok",
	},
	{
		label: "Cache Read",
		getValue: (m) => m.perMillion.inputCacheRead,
		format: (v) => (v > 0 ? `$${v.toFixed(4)}` : "—"),
		unit: "/M tok",
	},
	{
		label: "Cache Write",
		getValue: (m) => m.perMillion.inputCacheWrite,
		format: (v) => (v > 0 ? `$${v.toFixed(4)}` : "—"),
		unit: "/M tok",
	},
	{
		label: "Reasoning",
		getValue: (m) => m.perMillion.internalReasoning,
		format: (v) => (v > 0 ? `$${v.toFixed(4)}` : "—"),
		unit: "/M tok",
	},
	{
		label: "Web Search",
		getValue: (m) => m.perMillion.webSearch,
		format: (v) => (v > 0 ? `$${v.toFixed(4)}` : "—"),
		unit: "/M tok",
	},
	{
		label: "Image",
		getValue: (m) => m.perMillion.image,
		format: (v) => (v > 0 ? `$${v.toFixed(4)}` : "—"),
		unit: "/M tok",
	},
	{
		label: "Request",
		getValue: (m) => m.perMillion.request,
		format: (v) => (v > 0 ? `$${v.toFixed(4)}` : "—"),
		unit: "/M tok",
	},
];

/** Build a deprecation badge for the comparison table header. */
function buildDeprecationBadge(m: ModelPricingInfo): string {
	if (!m.isDeprecated) return "";
	const dateLabel = m.deprecationDate
		? `Deprecates ${m.deprecationDate.slice(0, 10)}`
		: "Deprecated";
	return `<br><small style="color:#f14c4c" aria-label="Deprecated model">⚠️ ${escapeHtml(dateLabel)}</small>`;
}

/**
 * Find winning column indices where extreme values get highlighted.
 * When multiple models share the extreme, the accumulated highlight
 * count from the 6 key rate rows decides the winner. If counts are
 * also tied, all candidates are highlighted.
 *
 * @param direction "min" for cheapest-price rows, "max" for context / output.
 */
function extremeWinners(values: number[], counts: number[], direction: "min" | "max"): Set<number> {
	// Exclude NaN entries (models that don't have the rate at all).
	const finite = values.map((v) => (Number.isFinite(v) ? v : Number.NaN));
	const extreme =
		direction === "min"
			? Math.min(...finite.filter((v) => !Number.isNaN(v)))
			: Math.max(...finite.filter((v) => !Number.isNaN(v)));
	// If no finite values remain (all models lack the rate), no highlight
	if (!Number.isFinite(extreme)) return new Set();

	const opposite =
		direction === "min"
			? Math.max(...finite.filter((v) => !Number.isNaN(v)))
			: Math.min(...finite.filter((v) => !Number.isNaN(v)));
	if (extreme === opposite) return new Set();

	const candidates = finite.map((v, i) => (v === extreme ? i : -1)).filter((i) => i >= 0);
	if (candidates.length === 1) return new Set(candidates);

	const topCount = Math.max(...candidates.map((i) => counts[i]));
	return new Set(candidates.filter((i) => counts[i] === topCount));
}

function buildComparisonHtml(models: ModelPricingInfo[], sort: ComparisonSort): string {
	const sortLabel = sort === "blendedRate" ? "cheapest first" : "most expensive first";
	const sortAria = sort === "blendedRate" ? "ascending" : "descending";
	const modelCount = models.length;

	const pricingCols = models
		.map((m, i) => {
			const ariaSortAttr = i === 0 && sort === "blendedRate" ? ` aria-sort="${sortAria}"` : "";
			const depBadge = buildDeprecationBadge(m);
			const freeBadge = m.isFree
				? '<br><small style="color:#73c991" aria-label="Free model">🆓 Free</small>'
				: "";
			return `
			<th scope="col"${ariaSortAttr}>
				<a href="https://openrouter.ai/models/${encodeURI(m.id)}"
					 tabindex="0" aria-label="View ${escapeHtml(m.name)} on OpenRouter">${escapeHtml(m.name)}</a>${freeBadge}${depBadge}
			</th>`;
		})
		.join("");

	function renderPricingRow(
		row: PriceRow,
		highlights: ReadonlySet<number>,
		comparisonValues: number[],
	): string {
		const finiteVals = comparisonValues.filter((v) => Number.isFinite(v));
		const minVal = finiteVals.length > 0 ? Math.min(...finiteVals) : Number.NaN;

		const cells = models
			.map((m, i) => {
				const val = row.getValue(m);
				const formatted = row.format(val, m);
				const isHighlighted = highlights.has(i) && models.length > 1;

				let pctMore = "";
				if (Number.isFinite(minVal) && val > 0 && val > minVal && minVal > 0) {
					const pct = (((val - minVal) / minVal) * 100).toFixed(0);
					const label = `${pct} percent more expensive than cheapest`;
					pctMore = ` <span class="or-diff" aria-label="${label}">(+${pct}%)</span>`;
				}

				let attrs = "";
				let ariaLabel = "";
				if (isHighlighted) {
					attrs = ` class="${CHEAPEST_CLASS}"`;
					ariaLabel = ` aria-label="${formatted} per million tokens — cheapest in row"`;
				}
				return `<td${attrs}${ariaLabel}>${formatted}${row.unit}${pctMore}</td>`;
			})
			.join("");

		return `<tr><th scope="row" class="or-label">${row.label}</th>${cells}</tr>`;
	}

	// ── Accumulated highlight count from 6 key rate rows only ──────
	// Every highlightable field consults this tally for tie-breaking,
	// but only the 6 key rate rows increment it.
	const highlightCounts: number[] = new Array(models.length).fill(0);

	const pricingRows = PRICE_ROWS.map((row) => {
		const rawValues = models.map(row.getValue);
		const excludeZero = EXCLUDE_ZERO_LABELS.has(row.label);

		// For exclude-zero rows (web search, image, request), only models
		// that actually have the rate participate in cheapest detection.
		const comparisonValues = excludeZero
			? rawValues.map((v) => (v > 0 ? v : Number.NaN))
			: rawValues;

		const highlights = extremeWinners(comparisonValues, highlightCounts, "min");

		// Only the 6 key rate rows contribute to the tally
		if (TIEBREAK_LABELS.has(row.label)) {
			for (const col of highlights) {
				highlightCounts[col]++;
			}
		}

		return renderPricingRow(row, highlights, comparisonValues);
	}).join("");

	const idRow = `
		<tr>
			<th scope="row" class="or-label">ID</th>
			${models.map((m) => `<td><code>${escapeHtml(m.id)}</code></td>`).join("")}
		</tr>`;

	// Context length: highest wins, tie-broken by accumulated key-rate highlights
	const ctxLengths = models.map((m) => m.contextLength);
	const ctxHighlights = extremeWinners(ctxLengths, highlightCounts, "max");
	const ctxCells = models
		.map((m, i) => {
			const isHighlighted = ctxHighlights.has(i) && modelCount > 1;
			const attrs = isHighlighted
				? ` class="${CHEAPEST_CLASS}" aria-label="${m.contextLengthFormatted} — highest context length"`
				: "";
			return `<td${attrs}>${m.contextLengthFormatted}</td>`;
		})
		.join("");
	const ctxRow = `<tr><th scope="row" class="or-label">Context Length</th>${ctxCells}</tr>`;

	// Max output: highest wins, tie-broken by accumulated key-rate highlights
	const maxOutValues = models.map((m) => m.maxOutputLength);
	const maxOutFormatted = models.map((m) =>
		m.maxOutputLength > 0 ? m.maxOutputLength.toLocaleString() : "—",
	);
	const maxOutHighlights = extremeWinners(maxOutValues, highlightCounts, "max");
	const maxOutHasValues = models.some((m) => m.maxOutputLength > 0);
	const maxOutRow = maxOutHasValues
		? `<tr><th scope="row" class="or-label">Max Output</th>${models
				.map((m, i) => {
					const f = maxOutFormatted[i];
					const isHighlighted = maxOutHighlights.has(i) && modelCount > 1;
					const attrs = isHighlighted
						? ` class="${CHEAPEST_CLASS}" aria-label="${f} — highest max output"`
						: "";
					return `<td${attrs}>${f}</td>`;
				})
				.join("")}</tr>`
		: "";

	// Strict CSP: no external resources, no scripts. Inline styles needed for
	// VSCode theme variable integration. Defense-in-depth against XSS via API
	// data (complements escapeHtml guards). Keyboard-navigable: all
	// interactive elements are `<a>` links (no JS).
	return buildComparisonDocument(`
	<div class="or-hero">
		<div class="or-hero-label">Pricing Comparison</div>
		<div class="or-hero-amount" style="font-size:32px">${modelCount} Models</div>
		<div class="or-hero-sub">Sorted ${sortLabel} · Teal = cheapest / highest in row · (+X%) = premium over cheapest</div>
	</div>
	<div class="or-card" style="padding:24px">
		<div class="or-table-scroll">
		<table class="or-table" aria-label="Model pricing comparison — ${modelCount} models compared" aria-describedby="sort-info">
		<thead><tr><th scope="col"><span class="or-sr-only">Metric</span></th>${pricingCols}</tr></thead>
		<tbody>${idRow}${pricingRows}${ctxRow}${maxOutRow}</tbody>
		</table>
		</div>
	</div>
	<div class="or-actions">
		<a href="command:openrouter-insights.exportCsv" class="or-btn" aria-label="Export pricing data as CSV">↧ Export CSV</a>
		<a href="command:openrouter-insights.refreshPricing" class="or-btn" aria-label="Refresh pricing data from OpenRouter">↻ Refresh Pricing</a>
	</div>
	`);
}
