/**
 * CostIconFactory — generates SVG-based colour-coded cost icons
 * for QuickPick items. Extracted from ModelPickerEnhancer so it
 * can be used independently by model browsers, comparison views,
 * and any future UI components.
 */

import * as vscode from "vscode";

/**
 * Compute a cost tier bucket from a blended rate (USD per 1M tokens).
 *   0 = free, 1 = <$1, 2 = $1-5, 3 = $5-15, 4 = >$15
 */
export function costTier(blendedRate: number): number {
	if (blendedRate === 0) return 0;
	if (blendedRate < 1) return 1;
	if (blendedRate < 5) return 2;
	if (blendedRate < 15) return 3;
	return 4;
}

/** Memoized cost icons — only 5 tiers, precomputed once. */
const _iconMemo = new Map<number, vscode.Uri>();

/**
 * Return a coloured dot icon reflecting the model's cost tier.
 *   free       → grey
 *   <$1/M      → green
 *   $1–$5/M    → yellow
 *   $5–$15/M   → orange
 *   >$15/M     → red
 *
 * Icons are memoized per tier — only 5 URIs ever created.
 */
export function costIcon(costPerMillion: number): vscode.Uri {
	const tier = costTier(costPerMillion);
	const cached = _iconMemo.get(tier);
	if (cached) return cached;

	const colors = ["#808080", "#73c991", "#cca700", "#d18616", "#f14c4c"];
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${colors[tier]}"/></svg>`;
	const uri = vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
	_iconMemo.set(tier, uri);
	return uri;
}
