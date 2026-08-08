/**
 * UsageStatusBarView — dedicated status bar item for OpenRouter
 * account balance/credits. Lives alongside the pricing status bar
 * item (StatusBarView) so both can be shown simultaneously.
 *
 * States:
 *   - No API key:  "$(lock) Set API Key"
 *   - Loading:     "$(loading~spin)"
 *   - Normal:      "$(credit-card) $X.XX"
 *   - Low balance: "$(warning) $X.XX" (below configurable threshold)
 *   - Error:       "$(error) error"
 */

import * as vscode from "vscode";
import type { UsageStats } from "../../types-usage";
import { formatCurrencyPrice } from "../formatting/currencyService";
import { getCurrency, getCurrencyRate } from "../../infrastructure/config";

export interface UsageStatusBarViewModel {
	text: string;
	tooltip: string | vscode.MarkdownString;
	backgroundColor?: vscode.ThemeColor;
	show: boolean;
}

/**
 * Resolve the amount that can actually be spent from the available balances.
 * A key limit and the account balance are independent caps, so the lower
 * known value is the amount the user can safely use.
 */
export function getAvailableCredits(usage: UsageStats): number | null {
	const balances = [usage.limitRemaining, usage.accountCredits?.remaining].filter(
		(value): value is number => value !== null && value !== undefined,
	);
	return balances.length > 0 ? Math.max(0, Math.min(...balances)) : null;
}

export class UsageStatusBarView implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private enabled = true;

	constructor() {
		this.item = vscode.window.createStatusBarItem(
			"openrouter-insights.usage",
			vscode.StatusBarAlignment.Right,
			99, // Slightly lower priority than the pricing bar (100)
		);
		this.item.name = "OpenRouter Usage";
		this.item.command = "openrouter-insights.openExpandedDashboard";
		this.item.tooltip = "OpenRouter Usage — set your API key to see balance";
		this.item.show();
	}

	dispose(): void {
		this.item.dispose();
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (enabled) {
			this.item.show();
		} else {
			this.item.hide();
		}
	}

	/** Change the command that runs when the status bar item is clicked. */
	setCommand(command: string): void {
		this.item.command = command;
	}

	/** Apply a fully-resolved view model to the status bar. */
	render(vm: UsageStatusBarViewModel): void {
		if (!this.enabled) return;
		if (!vm.show) {
			this.item.hide();
			return;
		}
		this.item.text = vm.text;
		this.item.tooltip = vm.tooltip;
		this.item.backgroundColor = vm.backgroundColor;
		this.item.show();
	}

	/** Show a "no key" state — user needs to set API key. */
	showNoKey(): void {
		this.render({
			text: "$(lock) Set API Key",
			tooltip:
				"OpenRouter Insights — set your API key to see account balance and usage.\n\n[Set API Key](command:openrouter-insights.setApiKey)",
			show: true,
		});
	}

	/** Show a loading state. */
	showLoading(): void {
		this.render({
			text: "$(loading~spin)",
			tooltip: "Loading OpenRouter usage data...",
			show: true,
		});
	}

	/** Show usage in the status bar. */
	showUsage(usage: UsageStats, lowBalanceThreshold: number): void {
		const cur = getCurrency();
		const remaining = getAvailableCredits(usage);
		const isLow = remaining !== null && remaining <= lowBalanceThreshold && remaining > 0;
		const isZero = remaining !== null && remaining <= 0;

		let icon: string;
		let bgColor: vscode.ThemeColor | undefined;

		if (isZero) {
			icon = "$(error)";
			bgColor = new vscode.ThemeColor("statusBarItem.errorBackground");
		} else if (isLow) {
			icon = "$(warning)";
			bgColor = new vscode.ThemeColor("statusBarItem.warningBackground");
		} else {
			icon = "$(credit-card)";
		}

		const displayAmount =
			remaining !== null
				? formatCurrencyPrice(remaining, cur, getCurrencyRate())
				: `${formatCurrencyPrice(usage.totalUsed, cur, getCurrencyRate())} used`;

		const text = `${icon} ${displayAmount}`;

		const tooltip = buildUsageTooltip(usage, cur);

		this.render({
			text,
			tooltip,
			backgroundColor: bgColor,
			show: true,
		});
	}

	/** Show an error state. */
	showError(message: string): void {
		this.render({
			text: "$(error) error",
			tooltip: `OpenRouter Usage Error: ${message}\n\n[Refresh](command:openrouter-insights.refreshUsage) | [Set API Key](command:openrouter-insights.setApiKey)`,
			backgroundColor: new vscode.ThemeColor("statusBarItem.errorBackground"),
			show: true,
		});
	}
}

/**
 * Build a MarkdownString tooltip for the usage status bar item.
 */
function buildUsageTooltip(usage: UsageStats, currency: string): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;
	md.supportHtml = true;
	md.supportThemeIcons = true;

	const availableCredits = getAvailableCredits(usage);
	const heroAmount =
		availableCredits !== null
			? formatCurrencyPrice(availableCredits, currency, getCurrencyRate())
			: formatCurrencyPrice(usage.totalUsed, currency, getCurrencyRate());
	const heroLabel = availableCredits !== null ? "Credits Available" : "Total Used";

	// ── Hero: title + large monospace amount + muted subtitle ──
	const hero = [`## OpenRouter Account Usage`, "", `${heroAmount} *${heroLabel}*`, ""];

	// ── Bordered usage table ─────────────────────────────────
	const fmt = (v: number) => formatCurrencyPrice(v, currency, getCurrencyRate());

	const rows: string[] = [
		`<tr><td>$(history) Today</td><td align="right">${fmt(usage.dailyUsage)}</td></tr>`,
		`<tr><td>$(calendar) This Week</td><td align="right">${fmt(usage.weeklyUsage)}</td></tr>`,
		`<tr><td>$(calendar) This Month</td><td align="right">${fmt(usage.monthlyUsage)}</td></tr>`,
		`<tr><td>$(server) All Time</td><td align="right"><b>${fmt(usage.totalUsed)}</b></td></tr>`,
	];

	if (usage.limit !== null) {
		rows.push(
			`<tr><td>$(shield) Limit</td><td align="right">${fmt(usage.limit)} (${usage.limitReset ?? "no reset"})</td></tr>`,
		);
	}
	if (usage.limitRemaining !== null) {
		rows.push(
			`<tr><td>$(dashboard) Remaining</td><td align="right"><b>${fmt(usage.limitRemaining)}</b></td></tr>`,
		);
	}
	if (usage.isFreeTier) {
		rows.push(`<tr><td>$(gift) Free Tier</td><td align="right">Yes</td></tr>`);
	}

	const table = [
		'<table border="1" cellpadding="6" cellspacing="0" width="100%">',
		`<tr><th colspan="2" align="left">U S A G E</th></tr>`,
		...rows,
		"</table>",
		"",
	];

	// ── Footer ───────────────────────────────────────────────
	const age = new Date(usage.fetchedAt).toLocaleString();
	const footer = [
		`*Updated ${age}*`,
		"",
		`[$(refresh) Refresh](command:openrouter-insights.refreshUsage) &middot; [$(graph) Dashboard](command:openrouter-insights.openUsageDashboard) &middot; [$(key) Set Key](command:openrouter-insights.setApiKey)`,
	];

	md.appendMarkdown([...hero, ...table, ...footer].join("\n"));
	return md;
}
