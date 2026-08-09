/**
 * UsageDashboard — webview surfaces for OpenRouter account balance,
 * usage, and management features.
 *
 * Two surfaces share the same rendering core:
 *   - Sidebar webview (WebviewViewProvider) — compact, always-on
 *   - Expanded panel (WebviewPanel) — full dashboard, opened on demand
 *
 * Regular API key:  shows single-key usage breakdown + limits
 * Management key:   additionally shows account credits, all keys
 *                   list with per-key usage, and key selector
 *
 * Uses postMessage to dispatch commands from link clicks because
 * command: URI navigation is unreliable in WebviewView iframes.
 */

import * as vscode from "vscode";
import type { ModelPricingInfo } from "../../types";
import type { DailyUsagePoint, UsageStats, AccountCredits, KeyUsage } from "../../types-usage";
import type { IPricingIndex } from "../../api/cache/pricingStore";
import { formatCurrencyPrice, currencySymbol, resolveRate } from "../formatting/currencyService";
import { ConfigService, getCurrency, getCurrencyRate } from "../../infrastructure/config";
import { attr, text, PALETTE, buildDashboardDocument } from "../webviewAssets";
import { log } from "../../infrastructure/logger";
import { deriveName } from "../../models/modelNameDeriver";
import { formatShortDateLabel, formatTimestamp } from "../formatting/formatting";

/** Color for a usage percentage. */
function pctColor(pct: number | null): string {
	if (pct === null) return PALETTE.muted;
	if (pct > 90) return PALETTE.red;
	if (pct > 75) return PALETTE.orange;
	return PALETTE.green;
}

/** HTML document wrapper with the shared design system. */
function wrapHtml(bodyContent: string): string {
	return buildDashboardDocument(bodyContent);
}

/** HTML document wrapper for the expanded (wide) dashboard. */
function wrapWideHtml(bodyContent: string): string {
	return buildDashboardDocument(bodyContent, true);
}

// ── Chart ──────────────────────────────────────────────────────

/** Build the bar chart bars + grid lines + average overlay + legend. */
function buildChartBars(
	points: DailyUsagePoint[],
	currency: string,
	rate: number,
	estimated?: boolean,
): string {
	if (points.length === 0) return "";

	const today = new Date().toISOString().slice(0, 10);
	const maxUsage = Math.max(...points.map((p) => p.usage), 0.01);
	const totalUsage = points.reduce((s, p) => s + p.usage, 0);
	const totalRequests = points.reduce((s, p) => s + p.requests, 0);
	const avgUsage = totalUsage / points.length;
	const avgHeight = Math.max(2, (avgUsage / maxUsage) * 100);
	const barWidth = 100 / points.length;
	const gap = 0;

	// Horizontal grid lines at 25%, 50%, 75%, 100% for visual scale reference
	const gridLines = [25, 50, 75, 100]
		.map((pct) => `<div class="or-activity-grid-line" style="bottom:${pct}%"></div>`)
		.join("");

	// Dashed average line overlay
	const avgLine = `<div class="or-activity-avg-line" style="bottom:${avgHeight}%" title="Daily average: ${attr(formatCurrencyPrice(avgUsage, currency, rate))}"></div>`;

	const bars = points
		.map((p, i) => {
			const height = Math.max(2, (p.usage / maxUsage) * 100);
			const left = i * (barWidth + gap);
			const showLabel = i === 0 || i === points.length - 1;
			const isToday = p.date === today;
			const isEst = estimated && isToday;
			const dateLabel = showLabel
				? `<div class="or-chart-label" style="left:${left + barWidth / 2}%">${formatShortDateLabel(p.date)}</div>`
				: "";
			const estNote = isEst ? " (estimated)" : "";
			const tooltip = `${formatShortDateLabel(p.date)}: ${formatCurrencyPrice(p.usage, currency, rate)}${estNote} · ${p.requests.toLocaleString()} requests`;
			const barClass = isEst ? "or-chart-bar or-chart-bar--estimated" : "or-chart-bar";
			return (
				`<div class="${barClass}" style="left:${left}%;width:${barWidth}%;height:${height}%" title="${attr(tooltip)}" aria-hidden="true"></div>` +
				dateLabel
			);
		})
		.join("");

	const dataRows = points
		.map((p) => {
			const isEstimated = estimated && p.date === today;
			return `<tr><th scope="row">${text(p.date)}</th><td>${text(formatCurrencyPrice(p.usage, currency, rate))}</td><td>${p.requests.toLocaleString()}</td><td>${isEstimated ? "Estimated" : "Reported"}</td></tr>`;
		})
		.join("");
	const estimatedNote = estimated
		? '<div class="or-chart-note">Today\'s bar is estimated from per-key usage sum.</div>'
		: "";

	const legend = `<div class="or-activity-legend"><span class="or-activity-legend-item"><span class="or-activity-legend-dot or-activity-legend-dot--usage" aria-hidden="true"></span>Daily usage</span><span class="or-activity-legend-item"><span class="or-activity-legend-line" aria-hidden="true"></span>Average ${text(formatCurrencyPrice(avgUsage, currency, rate))}</span></div>`;

	return `
		<div class="or-bar-caption">Total ${formatCurrencyPrice(totalUsage, currency, rate)} · Peak ${formatCurrencyPrice(maxUsage, currency, rate)} · ${totalRequests.toLocaleString()} requests</div>
		<div class="or-chart" style="padding-bottom:22px" aria-hidden="true">
			${gridLines}
			${avgLine}
			${bars}
		</div>
		${legend}
		<table class="or-chart-data or-sr-only">
			<caption>Usage history by date</caption>
			<thead><tr><th scope="col">Date</th><th scope="col">Usage</th><th scope="col">Requests</th><th scope="col">Status</th></tr></thead>
			<tbody>${dataRows}</tbody>
		</table>
		${estimatedNote}`;
}

/**
 * Build the usage history card, optionally with an account/key toggle
 * when per-key activity data is available (management key only).
 */
function buildChartSection(usage: UsageStats, currency: string, rate: number): string {
	const accountPoints = usage.dailyUsageHistory;
	if (usage.detailState?.status === "loading" && (!accountPoints || accountPoints.length === 0)) {
		return `<div class="or-card or-activity-card"><div class="or-section-head"><h3>Usage Activity</h3></div><div class="or-activity-empty" role="status" aria-live="polite"><div class="or-spinner" aria-hidden="true"></div><p class="or-info">Loading usage activity…</p></div></div>`;
	}
	if (
		!ConfigService.instance.usageBackgroundPollingEnabled ||
		!accountPoints ||
		accountPoints.length === 0
	) {
		let message = "Usage activity is available after the next detailed refresh.";
		if (!ConfigService.instance.usageBackgroundPollingEnabled) {
			message =
				"Usage activity updates are turned off because background polling is disabled. Turn on openrouterInsights.usage.backgroundPolling.enabled to refresh activity automatically.";
		} else if (usage.capabilities.activity === "unavailable") {
			message =
				"Usage activity is not available yet. Turn on openrouterInsights.usage.backgroundPolling.enabled for automatic activity refreshes, or use Refresh Usage to request it now.";
		}
		return `<div class="or-card or-activity-card"><div class="or-section-head"><h3>Usage Activity</h3></div><div class="or-activity-empty"><p class="or-info">${text(message)}</p></div></div>`;
	}

	const keyHash = usage.selectedKeyHash;
	const perKeyPoints = keyHash ? usage.perKeyActivityHistory?.[keyHash] : undefined;
	const hasToggle = usage.isManagementKey && !!perKeyPoints && perKeyPoints.length > 0;

	if (hasToggle) {
		const selectedKey = usage.allKeys?.find((k) => k.hash === keyHash);
		const keyName = text((selectedKey?.name || selectedKey?.label || "Key").slice(0, 24));
		// Unique name so sidebar + expanded panel don't collide.
		const toggleId = `chart-${usage.selectedKeyHash?.slice(0, 8) ?? "0"}`;
		const radioAccount = `${toggleId}-account`;
		const radioKey = `${toggleId}-key`;
		return `
	<div class="or-card or-chart-card or-activity-card">
		<input type="radio" name="${toggleId}" id="${radioAccount}" class="or-chart-radio" checked>
		<input type="radio" name="${toggleId}" id="${radioKey}" class="or-chart-radio">
		<div class="or-section-head"><div><h3>Usage Activity</h3><span class="or-section-kicker">${accountPoints.length} days</span></div></div>
		<div class="or-chart-toggle">
			<label class="or-chart-toggle-btn" for="${radioAccount}">Account</label>
			<label class="or-chart-toggle-btn" for="${radioKey}">${keyName}</label>
		</div>
		<div class="or-chart-pane or-chart-pane--account">${buildChartBars(accountPoints, currency, rate, true)}</div>
		<div class="or-chart-pane or-chart-pane--key">${buildChartBars(perKeyPoints!, currency, rate, false)}</div>
	</div>`;
	}

	return `
	<div class="or-card or-activity-card">
		<div class="or-section-head"><div><h3>Usage Activity</h3><span class="or-section-kicker">${accountPoints.length} days</span></div></div>
		${buildChartBars(accountPoints, currency, rate, usage.isManagementKey)}
	</div>`;
}

/** Build the optional per-model spend breakdown from the Analytics API. */
function buildAnalyticsSection(
	usage: UsageStats,
	currency: string,
	rate: number,
	pricing?: IPricingIndex,
): string {
	const analytics = usage.analytics;
	if (usage.detailState?.status === "loading" && !analytics) {
		return `<div class="or-card"><div class="or-section-head"><h3>Spend by Model</h3></div><div class="or-activity-empty" role="status" aria-live="polite"><div class="or-spinner" aria-hidden="true"></div><p class="or-info">Loading spend by model…</p></div></div>`;
	}
	if (!ConfigService.instance.usageAnalyticsEnabled || !analytics) {
		let message =
			"Per-model spend has not been loaded yet. Refresh the dashboard to request detailed analytics.";
		if (
			!ConfigService.instance.usageAnalyticsEnabled ||
			usage.analyticsUnavailableReason === "disabled"
		) {
			message =
				"Per-model spend is turned off. Turn on openrouterInsights.usage.analytics.enabled to include analytics in detailed refreshes.";
		} else if (usage.analyticsUnavailableReason === "managementKeyRequired") {
			message = "Per-model spend requires a management key.";
		} else if (usage.analyticsUnavailableReason === "unavailable") {
			message =
				"Per-model spend could not be loaded. Check your management-key access and try Refresh Usage again.";
		}
		return `<div class="or-card"><div class="or-section-head"><h3>Spend by Model</h3></div><p class="or-info">${message}</p></div>`;
	}
	if (analytics.modelBreakdown.length === 0) {
		return `<div class="or-card"><div class="or-section-head"><h3>Spend by Model</h3></div><p class="or-info">No model spend was recorded in this period.</p></div>`;
	}
	const fmt = (value: number): string => formatCurrencyPrice(value, currency, rate);
	const totalTokens = analytics.modelBreakdown.reduce((sum, model) => sum + model.tokensTotal, 0);
	const pricingLookup = pricing?.getLookup();
	const rows = analytics.modelBreakdown
		.map((model, index) => {
			const pricingModel = resolveAnalyticsPricingModel(model.modelId, pricing, pricingLookup);
			const analyticsModelId = model.modelId;
			const displayModelId = pricingModel?.id || analyticsModelId;
			const displayName = pricingModel?.name || deriveName(analyticsModelId);
			log.debug(
				`Analytics model ${analyticsModelId} resolved to display name "${displayName}" and pricing model ${pricingModel?.id ?? "none"}`,
			);
			const hasUsage = model.requestCount > 0 || model.tokensTotal > 0;
			const isFreeUsage = model.totalUsage === 0 && hasUsage;
			const freeBadge = isFreeUsage ? '<span class="or-model-free">FREE</span>' : "";
			const secondaryId = `<span class="or-model-id">${text(displayModelId)}</span>`;
			const extra =
				index >= 2 ? ' style="display:none" data-model-extra="true"' : ' data-model-extra="true"';
			const percent = Math.max(0, Math.min(100, model.percentage));
			const requestPercent =
				analytics.totalRequests > 0 ? (model.requestCount / analytics.totalRequests) * 100 : 0;
			const tokenPercent = totalTokens > 0 ? (model.tokensTotal / totalTokens) * 100 : 0;
			return `<div class="or-model-spend" data-model-index="${index}" data-model-id="${attr(analyticsModelId)}"${extra}>
				<div class="or-model-spend-main">
					<div class="or-model-name-row"><a class="or-model-name" href="https://openrouter.ai/models/${encodeURI(analyticsModelId)}" target="_blank" rel="noreferrer" title="Open ${attr(analyticsModelId)} on OpenRouter">${text(displayName)}</a>${freeBadge}</div>
					${secondaryId}
				</div>
				<div class="or-model-spend-metric"><strong>${fmt(model.totalUsage)}</strong><span>${model.percentage.toFixed(1)}%</span></div>
				<div class="or-model-spend-meta"><span>${model.requestCount.toLocaleString()} requests <b>(${requestPercent.toFixed(1)}%)</b></span><span>${model.tokensTotal.toLocaleString()} tokens <b>(${tokenPercent.toFixed(1)}%)</b></span></div>
				<div class="or-model-spend-bar" aria-hidden="true"><span style="width:${percent}%"></span></div>
			</div>`;
		})
		.join("");
	const remaining = analytics.modelBreakdown.length;
	const showMore =
		remaining > 0
			? `<button type="button" class="or-btn or-btn--subtle or-model-show-more" data-reveal-model-rows="2" aria-label="Show more model rows">Show more</button>`
			: "";
	const truncationNotice = analytics.truncated
		? `<p class="or-info" data-analytics-truncated="true">Showing the top ${analytics.modelBreakdown.length.toLocaleString()} models. This account has more models than the ${(analytics.rowLimit ?? analytics.modelBreakdown.length).toLocaleString()}-row analytics budget, so totals here are not the complete account breakdown.</p>`
		: "";
	return `<div class="or-card or-analytics-card"><div class="or-section-head"><div><h3>Spend by Model</h3><span class="or-section-kicker">${analytics.modelBreakdown.length} models · ${analytics.totalRequests.toLocaleString()} requests</span></div><span class="or-info">${analytics.overallCacheHitRate.toFixed(1)}% cache hit</span></div>${truncationNotice}<div class="or-model-spend-list">${rows}</div>${showMore}</div>`;
}

function capabilityMessage(status: string, label: string): string {
	if (status === "permissionDenied") return `${label} is not available for this API key.`;
	if (status === "unavailable") return `${label} is temporarily unavailable.`;
	return "";
}

/** Resolve dated analytics IDs to catalog names without changing row identity. */
function resolveAnalyticsPricingModel(
	modelId: string,
	pricing: IPricingIndex | undefined,
	lookup: Map<string, ModelPricingInfo> | undefined,
): ModelPricingInfo | undefined {
	if (!pricing || !lookup) return undefined;
	const exact = lookup.get(modelId);
	if (exact) return exact;

	const freeSuffix = /:free$/i.test(modelId) ? ":free" : "";
	const withoutFree = modelId.replace(/:free$/i, "");
	const compactDate = /^(.*)-(\d{8})$/.exec(withoutFree);
	const hyphenatedDate = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(withoutFree);
	let candidates: string[];
	if (compactDate) {
		candidates = [withoutFree, `${compactDate[1]}-${compactDate[2].slice(4)}`, compactDate[1]];
	} else if (hyphenatedDate) {
		candidates = [
			withoutFree,
			`${hyphenatedDate[1]}-${hyphenatedDate[3]}${hyphenatedDate[4]}`,
			`${hyphenatedDate[1]}-${hyphenatedDate[2]}${hyphenatedDate[3]}${hyphenatedDate[4]}`,
			hyphenatedDate[1],
		];
	} else {
		candidates = [withoutFree];
	}
	for (const candidate of candidates) {
		const match = lookup.get(`${candidate}${freeSuffix}`) ?? lookup.get(candidate);
		if (match) return match;
	}

	return undefined;
}

// ── Section builders ───────────────────────────────────────────

/** Format function type for currency display. */
type FmtUsd = (_v: number) => string;

function buildCreditsSection(usage: UsageStats): string {
	if (!usage.isManagementKey || !usage.accountCredits) return "";
	const c = usage.accountCredits;
	const color = pctColor(c.usagePercent);
	const usedPct = Math.min(100, c.usagePercent);

	const fmtCredits = (v: number): string => {
		const cur = getCurrency();
		const rate = resolveRate(cur, getCurrencyRate());
		const converted = v * rate;
		const symbol = currencySymbol(cur);
		const approx = cur !== "USD" ? "~" : "";
		return `${approx}${symbol}${converted.toFixed(2)}`;
	};

	// SVG circular progress ring
	const radius = 52;
	const circumference = 2 * Math.PI * radius;
	const dashOffset = circumference - (usedPct / 100) * circumference;

	return `
	<div class="or-card or-credits-card">
		<div class="or-section-head"><h3>Account Credits</h3></div>
		<div class="or-credits-hero">
			<div class="or-credits-ring" role="img" aria-label="${usedPct.toFixed(2)}% of credits used">
				<svg viewBox="0 0 120 120" aria-hidden="true">
					<circle class="or-credits-ring-track" cx="60" cy="60" r="${radius}" />
					<circle class="or-credits-ring-fill" cx="60" cy="60" r="${radius}" style="stroke-dasharray:${circumference};stroke-dashoffset:${dashOffset};stroke:${color}" />
				</svg>
				<div class="or-credits-ring-label">
					<span class="or-credits-ring-pct" style="color:${color}">${usedPct.toFixed(2)}%</span>
					<span class="or-credits-ring-sub">used</span>
				</div>
			</div>
			<div class="or-credits-hero-amount">
				<span class="or-credits-hero-label">Remaining</span>
				<span class="or-credits-hero-value" style="color:${color}">${fmtCredits(c.remaining)} / ${fmtCredits(c.totalCredits)}</span>
			</div>
		</div>
		<div class="or-credits-bar" aria-hidden="true">
			<div class="or-credits-bar-track">
				<div class="or-credits-bar-fill" style="width:${usedPct}%;background:${color}"></div>
			</div>
			<div class="or-credits-bar-marks">
				<span>0%</span><span>50%</span><span>100%</span>
			</div>
		</div>
	</div>`;
}

function buildAllKeyDetailsSection(usage: UsageStats, fmtUsd: FmtUsd): string {
	if (!usage.isManagementKey || !usage.allKeys || usage.allKeys.length === 0) return "";
	return usage.allKeys
		.map((k) => {
			const hidden = k.hash !== usage.selectedKeyHash ? ' style="display:none"' : "";
			const selBarPct = k.usagePercent !== null ? Math.min(100, k.usagePercent) : 0;
			const selBarColor = pctColor(k.usagePercent);
			const hasLimit = k.limit !== null;
			const limitValue = k.limitRemaining ?? 0;
			const usageLabel =
				k.usagePercent === null ? "No usage limit" : `${k.usagePercent.toFixed(1)}% used`;
			const limitBlock = hasLimit
				? `
		<div class="or-key-detail-limit">
			<div class="or-key-detail-limit-heading"><span class="or-key-detail-eyebrow">Remaining</span><strong>${fmtUsd(limitValue)}</strong></div>
			<div class="or-key-detail-meter" role="img" aria-label="${attr(`${usageLabel} of credit limit used`)}"><span style="width:${selBarPct}%;background:${selBarColor}"></span></div>
			<div class="or-key-detail-limit-meta"><span>${text(usageLabel)}</span><span>Reset ${text(k.limitReset ?? "never")}</span></div>
		</div>`
				: `
		<div class="or-key-detail-limit or-key-detail-limit--unlimited">
			<div class="or-key-detail-limit-heading"><span class="or-key-detail-eyebrow">Limit</span><strong>No spending limit</strong></div>
			<div class="or-key-detail-meter" aria-hidden="true"><span></span></div>
			<div class="or-key-detail-limit-meta"><span>${text(usageLabel)}</span><span>Unlimited access</span></div>
		</div>`;
			return `
	<div class="or-card or-key-detail" data-key-hash="${attr(k.hash)}"${hidden}>
		<div class="or-section-head or-key-detail-head">
			<div class="or-key-detail-identity">
				<span class="or-key-detail-eyebrow">Selected API key</span>
				<h3>${text(k.name || k.label || "Unnamed key")}</h3>
				<span class="or-key-detail-label">${text(k.label || "No label")} · <code>${text(k.hash.slice(0, 16))}…</code></span>
			</div>
		</div>
		${limitBlock}
		<div class="or-key-detail-metrics" aria-label="Usage by time period">
			<div><span>Daily</span><strong>${fmtUsd(k.dailyUsage)}</strong></div>
			<div><span>Weekly</span><strong>${fmtUsd(k.weeklyUsage)}</strong></div>
			<div><span>Monthly</span><strong>${fmtUsd(k.monthlyUsage)}</strong></div>
			<div><span>All-time</span><strong>${fmtUsd(k.totalUsed)}</strong></div>
		</div>
	</div>`;
		})
		.join("");
}

function buildKeySelectorSection(usage: UsageStats, fmtUsd: FmtUsd): string {
	if (!usage.isManagementKey || !usage.allKeys || usage.allKeys.length === 0) return "";
	const keys = usage.allKeys
		.map((k) => {
			const selected = k.hash === usage.selectedKeyHash;
			const cardClass = selected ? "or-key-card or-key-card--selected" : "or-key-card";
			const statusClass = k.disabled ? "or-key-status--disabled" : "or-key-status--active";
			const statusLabel = k.disabled ? "Disabled" : "Active";
			const usagePercent =
				k.usagePercent !== null ? Math.min(100, Math.max(0, k.usagePercent)) : null;
			const usageLabel = usagePercent === null ? "No limit" : `${usagePercent.toFixed(0)}% used`;
			const meter =
				usagePercent === null
					? `<div class="or-key-meter or-key-meter--unlimited"><span></span></div>`
					: `<div class="or-key-meter"><span style="width:${usagePercent}%;background:${pctColor(k.usagePercent)}"></span></div>`;
			const limitLabel = k.limit === null ? "Unlimited" : `${fmtUsd(k.limit)} limit`;
			return `<article class="${cardClass}" data-key-hash="${attr(k.hash)}">
					<button type="button" data-cmd="openrouter-insights.selectUsageKey" data-hash="${attr(k.hash)}" data-key-focus="${attr(k.hash)}" class="or-key-card-main" tabindex="${selected ? "0" : "-1"}" aria-label="Select key ${attr(k.name || k.label || "unnamed")}" aria-pressed="${selected ? "true" : "false"}">
						<div class="or-key-card-heading">
							<div class="or-key-card-title"><strong>${text(k.name || "Unnamed key")}</strong><span class="or-key-card-label">${text(k.label)}</span></div>
							<span class="or-key-status ${statusClass}"><i aria-hidden="true"></i>${statusLabel}</span>
						</div>
						<div class="or-key-card-usage"><span class="or-key-card-usage-label">Total usage</span><strong>${fmtUsd(k.totalUsed)}</strong></div>
						${meter}
						<div class="or-key-card-meta"><span>${usageLabel}</span><span>${limitLabel}</span>${k.limitReset ? `<span>Resets ${text(k.limitReset)}</span>` : ""}</div>
					</button>
					<div class="or-key-actions" aria-label="Actions for ${attr(k.name || k.label || "unnamed key")}">
						<button type="button" data-cmd="openrouter-insights.renameApiKey" data-hash="${attr(k.hash)}" title="Rename" aria-label="Rename key ${attr(k.name || k.label || "unnamed")}">✎ Rename</button>
						<button type="button" data-cmd="openrouter-insights.toggleApiKey" data-hash="${attr(k.hash)}" title="${k.disabled ? "Enable" : "Disable"}" aria-label="${k.disabled ? "Enable" : "Disable"} key ${attr(k.name || k.label || "unnamed")}">${k.disabled ? "▶ Enable" : "❚❚ Disable"}</button>
						<button type="button" data-cmd="openrouter-insights.setKeyLimit" data-hash="${attr(k.hash)}" title="Set limit" aria-label="Set limit for key ${attr(k.name || k.label || "unnamed")}">◈ Limit</button>
						<button type="button" data-cmd="openrouter-insights.deleteApiKey" data-hash="${attr(k.hash)}" title="Delete" aria-label="Delete key ${attr(k.name || k.label || "unnamed")}">✕ Delete</button>
					</div>
				</article>`;
		})
		.join("");
	return `
	<div class="or-card or-key-manager">
		<div class="or-section-head">
			<div><h3>API Keys</h3><span class="or-section-kicker">${usage.allKeys.length} keys</span></div>
			<button type="button" data-cmd="openrouter-insights.createApiKey" class="or-btn or-btn--primary or-btn--small">+ Create key</button>
		</div>
		<div class="or-key-grid" role="group" aria-label="API key selection" aria-describedby="or-keyboard-help">${keys}</div>
	</div>`;
}

function buildFreeTierNote(usage: UsageStats): string {
	return usage.isFreeTier
		? `<div class="or-card"><h3>Free Tier</h3><p style="color:var(--or-text-dim);font-size:12px">You are on the free tier.</p></div>`
		: "";
}

function buildActionsFooter(wide: boolean): string {
	const expandBtn = wide
		? ""
		: '<button type="button" data-cmd="openrouter-insights.openExpandedDashboard" class="or-btn">⤢ Expand</button>';
	return `
	<div class="or-actions">
		<button type="button" data-cmd="openrouter-insights.refreshUsage" class="or-btn">↻ Refresh</button>
		${expandBtn}
		<button type="button" data-cmd="openrouter-insights.setApiKey" class="or-btn">⬗ Change Key</button>
	</div>`;
}

function buildFooter(usage: UsageStats): string {
	return `<div class="or-footer">Updated ${text(formatTimestamp(usage.fetchedAt))}</div>`;
}

function region(id: string, content: string): string {
	return `<div data-region="${id}">${content}</div>`;
}

// ── Main dashboard HTML ─────────────────────────────────────────

export const dashboardCommandIds = [
	"openrouter-insights.selectUsageKey",
	"openrouter-insights.refreshUsage",
	"openrouter-insights.loadUsageDetails",
	"openrouter-insights.openExpandedDashboard",
	"openrouter-insights.setApiKey",
	"openrouter-insights.createApiKey",
	"openrouter-insights.renameApiKey",
	"openrouter-insights.toggleApiKey",
	"openrouter-insights.setKeyLimit",
	"openrouter-insights.deleteApiKey",
] as const;

export function buildDashboardBody(
	usage: UsageStats,
	wide: boolean,
	pricing?: IPricingIndex,
): string {
	const regions = buildDashboardRegionMap(usage, wide, pricing);
	const order = wide
		? [
				"hero",
				"top-grid",
				"activity",
				"analytics",
				"capabilities",
				"key-selector",
				"free-tier",
				"actions",
				"footer",
			]
		: [
				"hero",
				"credits",
				"activity",
				"analytics",
				"capabilities",
				"keys",
				"key-selector",
				"free-tier",
				"actions",
				"footer",
			];
	return order.map((id) => region(id, regions[id] ?? "")).join("\n");
}

/** Build unwrapped region content for incremental webview updates. */
export function buildDashboardRegionMap(
	usage: UsageStats,
	wide: boolean,
	pricing?: IPricingIndex,
): Record<string, string> {
	const pct = usage.usagePercent;
	const color = pctColor(pct);
	const mgmt = usage.isManagementKey;
	const cur = getCurrency();
	const rate = getCurrencyRate();
	const fmtUsd = (v: number): string => formatCurrencyPrice(v, cur, rate);

	const headerAmount =
		mgmt && usage.accountCredits ? usage.accountCredits.remaining : usage.totalUsed;
	const headerColor =
		mgmt && usage.accountCredits ? pctColor(usage.accountCredits.usagePercent) : color;
	const keyTypeLabel = mgmt ? "Management" : "API";
	const headerLabel =
		mgmt && usage.accountCredits ? "Credits Remaining" : `Total Used · ${keyTypeLabel} Key`;
	const badge = mgmt
		? '<span class="or-badge or-badge--mgmt">Mgmt</span>'
		: '<span class="or-badge or-badge--key">API</span>';

	const heroAmountClass = wide ? "or-hero-amount or-hero-amount--lg" : "or-hero-amount";

	const creditsSection = buildCreditsSection(usage);
	const activitySection = buildChartSection(usage, cur, rate);
	const analyticsSection = buildAnalyticsSection(usage, cur, rate, pricing);
	const selectedKeyDetail = buildAllKeyDetailsSection(usage, fmtUsd);
	const keySelectorSection = buildKeySelectorSection(usage, fmtUsd);
	const freeTierNote = buildFreeTierNote(usage);
	const capabilityNotice = Object.entries(usage.capabilities ?? {})
		.filter(([key]) => key !== "activity" && key !== "perKeyActivity" && key !== "analytics")
		.map(([key, status]) => capabilityMessage(status, key))
		.filter(Boolean)
		.map((message) => `<p class="or-info">${text(message)}</p>`)
		.join("");
	return {
		hero: `<div class="or-hero">
			<div class="or-hero-label">${headerLabel}${badge}</div>
			<div class="${heroAmountClass}" style="color:${headerColor}">${fmtUsd(headerAmount)}</div>
			<div class="or-hero-sub">${keyTypeLabel} key · ${cur}</div>
		</div>`,
		"top-grid":
			wide && (creditsSection || selectedKeyDetail)
				? `<div class="or-grid">${region("credits", creditsSection)}${region("keys", selectedKeyDetail)}</div>`
				: "",
		credits: creditsSection,
		activity: activitySection,
		analytics: analyticsSection,
		capabilities: capabilityNotice,
		keys: selectedKeyDetail,
		"key-selector": keySelectorSection,
		"free-tier": freeTierNote,
		actions: buildActionsFooter(wide),
		footer: buildFooter(usage),
	};
}

function buildDashboardHtml(usage: UsageStats, pricing?: IPricingIndex): string {
	return wrapHtml(buildDashboardBody(usage, false, pricing));
}

function buildExpandedDashboardHtml(usage: UsageStats, pricing?: IPricingIndex): string {
	return wrapWideHtml(buildDashboardBody(usage, true, pricing));
}

// ── State HTML (body-only + full-document wrappers) ─────────────

function buildNoKeyBody(): string {
	return `<div class="or-center">
			<div class="or-connect-mark" aria-hidden="true">✦</div>
			<h3>Connect your OpenRouter account</h3>
			<p>Bring balance, usage, budgets, and key controls into this dashboard.</p>
			<button type="button" data-cmd="openrouter-insights.setApiKey" class="or-btn or-btn--primary">⬗ Set Extension API Key</button>
			<div class="or-connect-notes">
				<div><b>Regular key</b><span>Basic usage and balance</span></div>
				<div><b>Management key</b><span>Credits, per-key usage, and controls</span></div>
			</div>
			<p class="or-info"><span class="or-security-dot" aria-hidden="true">●</span> Keys start with <code>sk-or-v1-</code> and are stored securely via the OS keychain.</p>
		</div>`;
}

function buildNoKeyHtml(): string {
	return wrapHtml(buildNoKeyBody());
}

function buildNoKeyHtmlWide(): string {
	return wrapWideHtml(buildNoKeyBody());
}

function buildLoadingBody(progressText?: string): string {
	return `<div class="or-center">
			<div class="or-spinner"></div>
			<p>${text(progressText ?? "Loading usage data…")}</p>
		</div>`;
}

function buildLoadingHtml(): string {
	return wrapHtml(buildLoadingBody());
}

function buildNoDataBody(): string {
	return `<div class="or-center">
			<h3>OpenRouter Insights</h3>
			<p><button type="button" data-cmd="openrouter-insights.refreshUsage" class="or-btn or-btn--primary">↻ Refresh Usage</button></p>
			<p class="or-info">Set your API key to see account details.</p>
		</div>`;
}

function buildNoDataHtml(): string {
	return wrapHtml(buildNoDataBody());
}

function buildErrorBody(message: string): string {
	return `<div class="or-center">
			<p class="or-error-text">⚠ Error loading usage data</p>
			<p class="or-info">${text(message)}</p>
			<button type="button" data-cmd="openrouter-insights.refreshUsage" class="or-btn or-btn--primary">↻ Retry</button>
		</div>`;
}

function buildErrorHtml(message: string): string {
	return wrapHtml(buildErrorBody(message));
}

// ── Sidebar provider ────────────────────────────────────────────

/** WebviewMessage shape exchanged between the extension host and webviews. */
export interface WebviewMessage {
	cmd: (typeof dashboardCommandIds)[number] | "loadingProgress" | "dashboardReady";
	requestId?: string;
	hash?: string | null;
	wsId?: string | null;
	wsSlug?: string | null;
	interval?: string | null;
	progressText?: string;
}

function isDashboardCommand(cmd: unknown): cmd is WebviewMessage["cmd"] {
	return (
		typeof cmd === "string" &&
		((dashboardCommandIds as readonly string[]).includes(cmd) ||
			cmd === "loadingProgress" ||
			cmd === "dashboardReady")
	);
}

export class UsageDashboardProvider implements vscode.WebviewViewProvider {
	private _view: vscode.WebviewView | undefined;
	private _panel: vscode.WebviewPanel | undefined;
	/** Queued full-document render (sidebar only, used before view resolves). */
	private _pendingRender: (() => string) | undefined;
	/** Last rendered usage data — for key switching and panel birth. */
	private _lastUsage: UsageStats | undefined;
	/** Latest body HTML, replayed after the webview bridge is ready. */
	private _latestBody: string | undefined;
	private _latestBodyWide: string | undefined;
	private _latestRegions: Record<string, string> | undefined;
	private _latestRegionsWide: Record<string, string> | undefined;

	constructor(private readonly _pricing?: IPricingIndex) {}

	// ── View lifecycle ──────────────────────────────────────

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		webviewView.onDidDispose(() => {
			if (this._view === webviewView) this._view = undefined;
		});

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [],
		};

		webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
			void this._handleMessage(msg, webviewView.webview);
		});

		const html = this._pendingRender ? this._pendingRender() : buildLoadingHtml();
		this._pendingRender = undefined;
		this._view.webview.html = html;
		if (this._lastUsage?.isManagementKey && !this._lastUsage.dailyUsageHistory) {
			void vscode.commands.executeCommand("openrouter-insights.loadUsageDetails");
		} else if (!this._lastUsage) {
			void vscode.commands.executeCommand("openrouter-insights.refreshUsage");
		}
	}

	// ── Message routing ─────────────────────────────────────

	private async _handleMessage(msg: WebviewMessage, source: vscode.Webview): Promise<void> {
		if (!isDashboardCommand(msg.cmd)) return;
		if (msg.cmd === "dashboardReady") {
			this._replayLatestRender(source);
			return;
		}
		const requestId = msg.requestId ?? `${msg.cmd}-${Date.now()}`;
		await source.postMessage({ cmd: "commandPending", requestId, command: msg.cmd });
		if (msg.cmd === "openrouter-insights.selectUsageKey" && msg.hash) {
			if (this._lastUsage?.selectedKeyHash === msg.hash) {
				await source.postMessage({
					cmd: "commandResult",
					requestId,
					ok: true,
					liveText: "Key already selected.",
				});
				return;
			}
			this.switchKey(msg.hash);
			// Also trigger the full refresh so per-key activity data is fetched.
			try {
				await vscode.commands.executeCommand(msg.cmd, msg.hash);
				await source.postMessage({
					cmd: "commandResult",
					requestId,
					ok: true,
					liveText: "Usage key selected.",
				});
			} catch (error) {
				await this._postCommandFailure(source, requestId, error);
			}
			return;
		}
		try {
			const argument = msg.hash ?? undefined;
			await vscode.commands.executeCommand(msg.cmd, argument);
			await source.postMessage({
				cmd: "commandResult",
				requestId,
				ok: true,
				liveText: "Dashboard action completed.",
			});
		} catch (error) {
			await this._postCommandFailure(source, requestId, error);
		}
	}

	async handleMessageForTest(msg: WebviewMessage, source: vscode.Webview): Promise<void> {
		await this._handleMessage(msg, source);
	}

	private async _postCommandFailure(
		source: vscode.Webview,
		requestId: string,
		error: unknown,
	): Promise<void> {
		const message =
			error instanceof Error && error.message ? error.message : "The dashboard action failed.";
		await source.postMessage({ cmd: "commandResult", requestId, ok: false, liveText: message });
	}

	// ── Rendering pipeline ──────────────────────────────────
	// Each render* method sends body-only HTML via postMessage to any
	// live surface (sidebar + expanded panel).  A full-document render
	// is only used as a fallback for the sidebar before resolve* fires.

	/** Render the dashboard with usage data (body-only, no teardown). */
	renderUsage(usage: UsageStats): void {
		if (this._lastUsage?.selectedKeyHash && !usage.selectedKeyHash && usage.allKeys) {
			usage = { ...usage, selectedKeyHash: this._lastUsage.selectedKeyHash };
		}

		if (this._lastUsage && this._usageDataEqual(this._lastUsage, usage)) {
			return;
		}

		this._lastUsage = usage;

		const body = buildDashboardBody(usage, false, this._pricing);
		const bodyWide = buildDashboardBody(usage, true, this._pricing);
		const regions = buildDashboardRegionMap(usage, false, this._pricing);
		const regionsWide = buildDashboardRegionMap(usage, true, this._pricing);

		this._postOrQueue(body, bodyWide, regions, regionsWide, () =>
			buildDashboardHtml(usage, this._pricing),
		);
	}

	/**
	 * Compare two UsageStats objects for meaningful visual differences.
	 * Returns true if the data is effectively the same for rendering purposes.
	 */
	private _usageDataEqual(a: UsageStats, b: UsageStats): boolean {
		// Quick reference check
		if (a === b) return true;

		// Compare core usage fields
		if (!this._coreFieldsEqual(a, b)) return false;

		// Compare management-only fields
		if (a.isManagementKey && !this._managementFieldsEqual(a, b)) return false;

		return true;
	}

	/** Compare core usage fields that affect the dashboard display. */
	private _coreFieldsEqual(a: UsageStats, b: UsageStats): boolean {
		return (
			a.mode === b.mode &&
			a.isManagementKey === b.isManagementKey &&
			a.totalUsed === b.totalUsed &&
			a.dailyUsage === b.dailyUsage &&
			a.weeklyUsage === b.weeklyUsage &&
			a.monthlyUsage === b.monthlyUsage &&
			a.limit === b.limit &&
			a.limitRemaining === b.limitRemaining &&
			a.limitReset === b.limitReset &&
			a.isFreeTier === b.isFreeTier &&
			a.usagePercent === b.usagePercent &&
			a.fetchedAt === b.fetchedAt
		);
	}

	/** Compare management-only fields that affect the dashboard display. */
	private _managementFieldsEqual(a: UsageStats, b: UsageStats): boolean {
		if (a.selectedKeyHash !== b.selectedKeyHash) return false;
		if (!this._accountCreditsEqual(a.accountCredits, b.accountCredits)) return false;
		if (!this._keysEqual(a.allKeys, b.allKeys)) return false;
		if (a.dailyUsageHistory !== b.dailyUsageHistory) return false;
		if (a.perKeyActivityHistory !== b.perKeyActivityHistory) return false;
		if (a.analytics !== b.analytics) return false;
		if (a.analyticsUnavailableReason !== b.analyticsUnavailableReason) return false;
		if (a.detailState?.status !== b.detailState?.status) return false;
		if (a.detailState?.lastAttemptAt !== b.detailState?.lastAttemptAt) return false;
		if (a.detailState?.lastSuccessAt !== b.detailState?.lastSuccessAt) return false;
		return true;
	}

	/** Compare account credits objects. */
	private _accountCreditsEqual(a: AccountCredits | null, b: AccountCredits | null): boolean {
		if (a === b) return true;
		if (!a || !b) return false;
		return (
			a.totalCredits === b.totalCredits &&
			a.totalUsage === b.totalUsage &&
			a.remaining === b.remaining &&
			a.usagePercent === b.usagePercent
		);
	}

	/** Compare two KeyUsage arrays for equality. */
	private _keysEqual(a: KeyUsage[] | null, b: KeyUsage[] | null): boolean {
		if (a === b) return true;
		if (!a || !b) return false;
		if (a.length !== b.length) return false;

		for (let i = 0; i < a.length; i++) {
			if (!this._keyEqual(a[i], b[i])) return false;
		}
		return true;
	}

	/** Compare two KeyUsage objects for equality. */
	private _keyEqual(ka: KeyUsage, kb: KeyUsage): boolean {
		return (
			ka.hash === kb.hash &&
			ka.name === kb.name &&
			ka.label === kb.label &&
			ka.disabled === kb.disabled &&
			ka.totalUsed === kb.totalUsed &&
			ka.dailyUsage === kb.dailyUsage &&
			ka.weeklyUsage === kb.weeklyUsage &&
			ka.monthlyUsage === kb.monthlyUsage &&
			ka.limit === kb.limit &&
			ka.limitRemaining === kb.limitRemaining &&
			ka.limitReset === kb.limitReset &&
			ka.usagePercent === kb.usagePercent
		);
	}

	/** Switch the selected key via postMessage — no DOM replacement needed. */
	switchKey(keyHash: string): void {
		if (!this._lastUsage) return;
		this._lastUsage = { ...this._lastUsage, selectedKeyHash: keyHash };
		const msg = { cmd: "switchKey", hash: keyHash };
		if (this._view) this._view.webview.postMessage(msg);
		if (this._panel) this._panel.webview.postMessage(msg);
	}

	/** Render the "no API key configured" state. */
	renderNoKey(): void {
		this._lastUsage = undefined;
		this._postOrQueueState(buildNoKeyBody(), buildNoKeyHtml);
	}

	/** Render the "loading" state (skips when prior data exists). */
	renderLoading(): void {
		if (this._lastUsage) return;
		this._postOrQueueState(buildLoadingBody(), buildLoadingHtml);
	}

	/** Render the "loading" state with a progress message. */
	renderLoadingProgress(progressText: string): void {
		if (this._lastUsage) return;
		this._postOrQueueState(buildLoadingBody(progressText), () => buildLoadingHtml());
	}

	/** Send a loading progress message to the webview. */
	sendLoadingProgress(progressText: string): void {
		const message: WebviewMessage = { cmd: "loadingProgress", progressText };
		if (this._view) this._view.webview.postMessage(message);
		if (this._panel) this._panel.webview.postMessage(message);
	}

	/** Render the "no data yet" state. */
	renderNoData(): void {
		this._lastUsage = undefined;
		this._postOrQueueState(buildNoDataBody(), buildNoDataHtml);
	}

	/** Render an error state. */
	renderError(message: string): void {
		this._lastUsage = undefined;
		const body = buildErrorBody(message);
		this._postOrQueueState(body, () => buildErrorHtml(message));
	}

	/** Get the last rendered usage (for the expanded panel to reuse). */
	getLastUsage(): UsageStats | undefined {
		return this._lastUsage;
	}

	// ── Expanded panel management ───────────────────────────

	/**
	 * Open the full editor-docked usage dashboard panel, reusing the
	 * last-fetched data.  Stored panel reference is auto-cleaned on
	 * dispose so future renders reach it.
	 */
	openExpandedPanel(): vscode.WebviewPanel {
		const panel = vscode.window.createWebviewPanel(
			"openrouterExpandedUsage",
			"OpenRouter Insights",
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		panel.iconPath = vscode.Uri.parse(
			"data:image/svg+xml;utf8," +
				encodeURIComponent(
					'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="9" width="3" height="5" rx="0.5" fill="#f0c674"/><rect x="6.5" y="6" width="3" height="8" rx="0.5" fill="#f0c674"/><rect x="11" y="3" width="3" height="11" rx="0.5" fill="#f0c674"/></svg>',
				),
		);

		panel.webview.options = { enableScripts: true, localResourceRoots: [] };
		panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
			void this._handleMessage(msg, panel.webview);
		});
		panel.onDidDispose(() => {
			this._panel = undefined;
		});

		const html = this._lastUsage
			? buildExpandedDashboardHtml(this._lastUsage, this._pricing)
			: buildNoKeyHtmlWide();
		panel.webview.html = html;
		if (this._lastUsage?.isManagementKey && !this._lastUsage.dailyUsageHistory) {
			void vscode.commands.executeCommand("openrouter-insights.loadUsageDetails");
		} else if (!this._lastUsage) {
			void vscode.commands.executeCommand("openrouter-insights.refreshUsage");
		}

		this._panel = panel;
		return panel;
	}

	// ── Internal helpers ────────────────────────────────────

	/**
	 * Post body-only HTML to every live surface, falling back to a
	 * queued full-document render for the sidebar when the view hasn't
	 * resolved yet.
	 */
	private _postOrQueue(
		body: string,
		bodyWide: string,
		regions: Record<string, string>,
		regionsWide: Record<string, string>,
		fallbackFullDoc: () => string,
	): void {
		const previousRegions = this._latestRegions;
		const previousRegionsWide = this._latestRegionsWide;
		this._latestBody = body;
		this._latestBodyWide = bodyWide;
		this._latestRegions = regions;
		this._latestRegionsWide = regionsWide;
		if (this._view) {
			if (previousRegions) {
				this._postChangedRegions(this._view.webview, previousRegions, regions);
			} else {
				this._view.webview.postMessage({ cmd: "updateHtml", html: body });
			}
		} else {
			this._pendingRender = fallbackFullDoc;
		}
		if (this._panel) {
			if (previousRegionsWide) {
				this._postChangedRegions(this._panel.webview, previousRegionsWide, regionsWide);
			} else {
				this._panel.webview.postMessage({ cmd: "updateHtml", html: bodyWide });
			}
		}
	}

	private _postChangedRegions(
		source: vscode.Webview,
		previous: Record<string, string>,
		current: Record<string, string>,
	): void {
		for (const [region, html] of Object.entries(current)) {
			if (current["top-grid"] && (region === "credits" || region === "keys")) {
				continue;
			}
			if (previous[region] !== html) {
				void source.postMessage({ cmd: "updateRegion", region, html });
			}
		}
	}

	/** Same as _postOrQueue but the body content is shared for both layouts. */
	private _postOrQueueState(body: string, fallbackNarrow: () => string): void {
		this._latestBody = body;
		this._latestBodyWide = body;
		if (this._view) {
			this._view.webview.postMessage({ cmd: "updateHtml", html: body });
		} else {
			this._pendingRender = fallbackNarrow;
		}
		if (this._panel) {
			this._panel.webview.postMessage({ cmd: "updateHtml", html: body });
		}
	}

	/** Replay the current state after the bridge script has installed its listener. */
	private _replayLatestRender(source: vscode.Webview): void {
		const html = source === this._panel?.webview ? this._latestBodyWide : this._latestBody;
		if (html) void source.postMessage({ cmd: "updateHtml", html });
	}
}
