/**
 * ModelDetailView — renders a rich single-model detail webview
 * showing full pricing, capabilities, provider info, and metadata.
 *
 * Opened via the "View Model Detail" command or from the model browser.
 */

import * as vscode from "vscode";
import type { ModelPricingInfo } from "../../types";
import { escapeHtml } from "../escapeHtml";
import { buildDetailDocument } from "../webviewAssets";
import { formatDateOnly, formatDetailPrice, formatTokenCount } from "../formatting/formatting";
import { resolveRate } from "../formatting/currencyService";
import { getCurrency, getCurrencyRate, getFavoriteModels } from "../../infrastructure/config";

/**
 * Open a webview displaying detailed information about a single model.
 */
export function showModelDetailWebview(model: ModelPricingInfo): void {
	const panel = vscode.window.createWebviewPanel(
		"openrouterModelDetail",
		`${model.name} — Model Detail`,
		vscode.ViewColumn.Beside,
		{ enableScripts: false, enableCommandUris: true, retainContextWhenHidden: true },
	);
	panel.webview.html = buildDetailHtml(model);
}

/** Build a deprecation label from the model's deprecation date. */
function depLabel(m: ModelPricingInfo): string {
	if (!m.isDeprecated) return "";
	return m.deprecationDate ? `Deprecates ${formatDateOnly(m.deprecationDate)}` : "Deprecated";
}

/** Build a single pricing stat row for the detail view. Zero values show "—" instead of hiding. */
function priceCell(label: string, value: number, currency: string, rate: number): string {
	const formatted = formatDetailPrice(value, currency, rate);
	return `<div class="or-stat-row"><span class="or-stat-label">${escapeHtml(label)}</span><span class="or-stat-value">${formatted}</span></div>`;
}

/** Build a tag group from a list of string labels (e.g. supported_parameters). */
function tagGroup(title: string, tags: string[]): string {
	if (tags.length === 0) {
		return "";
	}
	const tagHtml = tags
		.map((t) => `<span class="or-tag">${escapeHtml(t.replaceAll("_", " "))}</span>`)
		.join(" ");
	return `<div class="or-card"><h3>${escapeHtml(title)}</h3><p style="line-height:2">${tagHtml}</p></div>`;
}

/** Derive a provider name from the model ID (e.g. "openai/gpt-4o" → "OpenAI"). */
function deriveProviderName(m: ModelPricingInfo): string {
	// Prefer API-provided names when available
	if (m.topProviderName) return m.topProviderName;
	if (m.topProviderId) {
		// Capitalise the provider ID as a fallback
		return m.topProviderId.charAt(0).toUpperCase() + m.topProviderId.slice(1);
	}
	const seg = m.id.split("/")[0] ?? "";
	const known: Record<string, string> = {
		openai: "OpenAI",
		anthropic: "Anthropic",
		google: "Google",
		meta: "Meta",
		mistralai: "Mistral AI",
		cohere: "Cohere",
		deepseek: "DeepSeek",
		xai: "xAI",
		perplexity: "Perplexity",
		amazon: "Amazon",
		nvidia: "NVIDIA",
	};
	return known[seg] ?? (seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "");
}

/** Make the API detailsLink absolute (it comes as a relative path). */
function absoluteDetailsLink(m: ModelPricingInfo): string {
	return `https://openrouter.ai/models/${encodeURI(m.id)}`;
}

/** Build the top provider card. Provider name is derived from the model ID prefix. */
function providerCard(m: ModelPricingInfo): string {
	const rows: string[] = [];
	const providerName = deriveProviderName(m);
	// Always show the provider name (derived if API doesn't provide it)
	rows.push(statRow("Provider", escapeHtml(providerName || "—")));
	if (m.topProviderContextLength > 0)
		rows.push(statRow("Context Limit", `${formatTokenCount(m.topProviderContextLength)} tokens`));
	if (m.topProviderMaxCompletionTokens > 0)
		rows.push(
			statRow("Max Output", `${formatTokenCount(m.topProviderMaxCompletionTokens)} tokens`),
		);
	if (m.topProviderIsModerated)
		rows.push(statRow("Content Moderation", '<span style="color:var(--or-orange)">Enabled</span>'));
	if (rows.length <= 1) {
		// Only the derived provider name — the API returned no top_provider data
		return `<div class="or-card"><h3>Top Provider</h3>${rows.join("")}<p style="color:var(--or-text-dim);font-size:12px;margin-top:6px">No provider-specific limits from API</p></div>`;
	}
	return `<div class="or-card"><h3>Top Provider</h3>${rows.join("")}</div>`;
}

/** Build the metadata card. */
function metadataCard(m: ModelPricingInfo): string {
	const rows: string[] = [];
	if (m.quantization) rows.push(statRow("Quantization", escapeHtml(m.quantization)));
	rows.push(statRow("Modality", escapeHtml(m.modality || "—")));
	if (m.created > 0) {
		const date = formatDateOnly(m.created * 1000);
		rows.push(statRow("Created", date));
	}
	return `<div class="or-card"><h3>Metadata</h3>${rows.join("")}</div>`;
}

/** Build a single stat row with label and value. */
function statRow(label: string, value: string): string {
	return `<div class="or-stat-row"><span class="or-stat-label">${label}</span><span class="or-stat-value">${value}</span></div>`;
}

function buildDetailHtml(m: ModelPricingInfo): string {
	const pm = m.perMillion;
	const currency = getCurrency();
	const rate = resolveRate(currency, getCurrencyRate());
	const favorite = getFavoriteModels().includes(m.id);
	const modelArgument = encodeURIComponent(JSON.stringify(m.id));
	const favoriteCommand = favorite
		? `openrouter-insights.removeFromFavorites?${modelArgument}`
		: `openrouter-insights.addToFavorites?${modelArgument}`;

	const pricingRows = [
		priceCell("Prompt", pm.prompt, currency, rate),
		priceCell("Completion", pm.completion, currency, rate),
		priceCell("Cache Read", pm.inputCacheRead, currency, rate),
		priceCell("Cache Write", pm.inputCacheWrite, currency, rate),
		priceCell("Reasoning", pm.internalReasoning, currency, rate),
		priceCell("Web Search", pm.webSearch, currency, rate),
		priceCell("Image", pm.image, currency, rate),
		priceCell("Request", pm.request, currency, rate),
	].join("");

	const depLabelText = depLabel(m);
	const depBadge = depLabelText
		? `<div class="or-card" style="border-color:rgba(248,81,73,0.3)"><h3>⚠️ ${escapeHtml(depLabelText)}</h3><p style="color:var(--or-text-dim);font-size:12px">This model is deprecated. Check <a href="https://openrouter.ai/models" style="color:var(--or-teal)">OpenRouter</a> for alternatives.</p></div>`
		: "";

	const freeBadge = m.isFree
		? '<span class="or-badge or-badge--mgmt" style="margin-left:8px">FREE</span>'
		: "";

	const capsHtml = tagGroup(
		"Supported Parameters",
		Array.isArray(m.supportedParameters) ? m.supportedParameters : [],
	);
	const featuresHtml = tagGroup(
		"Features",
		Array.isArray(m.supportedFeatures) ? m.supportedFeatures : [],
	);
	const inputModsHtml = tagGroup(
		"Input Modalities",
		Array.isArray(m.inputModalities) ? m.inputModalities : [],
	);
	const outputModsHtml = tagGroup(
		"Output Modalities",
		Array.isArray(m.outputModalities) ? m.outputModalities : [],
	);
	const providerHtml = providerCard(m);
	const metaHtml = metadataCard(m);

	const maxOutHtml =
		m.maxOutputLength > 0
			? statRow("Max Output", `${m.maxOutputLength.toLocaleString()} tokens`)
			: "";

	const descHtml = `<div class="or-card"><h3>Description</h3><p style="color:var(--or-text-dim);font-size:12px;line-height:1.6">${m.description ? escapeHtml(m.description) : "No description"}</p></div>`;

	const body = `
	<div class="or-hero">
		<div class="or-hero-label">Model Detail</div>
		<div class="or-hero-amount" style="font-size:32px"><a href="${escapeHtml(absoluteDetailsLink(m))}" style="color:var(--or-teal);text-decoration:underline">${escapeHtml(m.name)} ↗${freeBadge}</a></div>
		<div class="or-hero-sub"><code>${escapeHtml(m.id)}</code></div>
		<div class="or-hero-sub">Blended Rate: <span style="color:var(--or-amber);font-family:var(--or-font-mono)">${formatDetailPrice(m.blendedRate, currency, rate)} /M tok</span></div>
	</div>
	${depBadge}
	<div class="or-card">
		<h3>Pricing · per 1M tokens (${escapeHtml(currency)})</h3>
		${pricingRows}
		<div class="or-stat-row"><span class="or-stat-label">Context Length</span><span class="or-stat-value">${formatTokenCount(m.contextLength)} tokens</span></div>
		${maxOutHtml}
	</div>
	${capsHtml}
	${inputModsHtml}
	${outputModsHtml}
	${featuresHtml}
	${providerHtml}
	${metaHtml}
	${descHtml}
	<div class="or-actions">
		<a href="${escapeHtml(absoluteDetailsLink(m))}" target="_blank" rel="noreferrer" class="or-btn" aria-label="Open ${escapeHtml(m.name)} on OpenRouter">↗ Open on OpenRouter</a>
		<a href="command:openrouter-insights.copyModelId?${modelArgument}" class="or-btn" aria-label="Copy ${escapeHtml(m.name)} model ID">▣ Copy Model ID</a>
		<a href="command:openrouter-insights.refreshPricing" class="or-btn" aria-label="Refresh pricing data">↻ Refresh Pricing</a>
		<a href="command:${favoriteCommand}" class="or-btn" aria-label="${favorite ? "Remove" : "Add"} ${escapeHtml(m.name)} ${favorite ? "from" : "to"} favorites">${favorite ? "★ Remove from Favorites" : "☆ Add to Favorites"}</a>
	</div>
	`;
	return buildDetailDocument(`${escapeHtml(m.name)} — Model Detail`, body);
}
