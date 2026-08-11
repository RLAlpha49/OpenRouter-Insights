/**
 * StatusBarPresenter — converts domain data into a StatusBarViewModel.
 * Contains all business-logic formatting decisions (which text to show,
 * which color to use, how to construct the tooltip).
 *
 * `createStatusBarPresenter` adapts `StatusBarView` to the application's
 * `StatusBarPresenter` port so `StatusBarUpdateUseCase` publishes a resolved
 * pricing state instead of building VS Code view models itself.
 */

import * as vscode from "vscode";
import type { ModelPricingInfo, CachedPricingData } from "../../types";
import type { StatusBarViewModel } from "./statusBarView";
import { StatusBarView } from "./statusBarView";
import type {
	StatusBarPresenter as StatusBarPresenterPort,
	StatusBarPricingState,
} from "../../use-cases/ports";
import { getBlendWeights, getStatusBarMaxWidth } from "../../infrastructure/config";
import {
	buildPricingActionLinks,
	buildTooltipMd,
	escapeMarkdown,
	formatTimestamp,
	truncate,
} from "../formatting/formatting";
import { renderStatusBarText } from "./statusBarTemplate";
import { log } from "../../infrastructure/logger";

/** Tooltip cache to avoid re-allocating MarkdownString on every timer tick. */
let _lastTooltipKey = "";
let _lastTooltip: vscode.MarkdownString | undefined;

/** Static tooltips for the two "no pricing" states — identical every call. */
const _missingPricingTooltip = (displayName: string) =>
	new vscode.MarkdownString(
		`**${escapeMarkdown(displayName)}** — no OpenRouter pricing found\n\n` +
			buildPricingActionLinks(),
	);

/** Static tooltip for the "no model" state. */
const _missingPricingNoModelTooltip = new vscode.MarkdownString(
	"OpenRouter Insights — select an OpenRouter model in the Copilot model picker\n\n" +
		buildPricingActionLinks(),
);

/**
 * Build a view model for the status bar from domain objects.
 */
export function buildStatusBarViewModel(
	displayName: string | undefined,
	pricing: ModelPricingInfo | undefined,
	cache: CachedPricingData | undefined,
): StatusBarViewModel {
	if (!pricing) {
		return buildMissingPricingVm(displayName);
	}
	return buildPricingVm(displayName, pricing, cache);
}

/**
 * Adapt the concrete status-bar view to the application presenter port.
 * View-model construction stays in the UI layer; the use case only publishes
 * the resolved model, its pricing, and the catalog snapshot it came from.
 */
export function createStatusBarPresenter(view: StatusBarView): StatusBarPresenterPort {
	return {
		setEnabled: (enabled: boolean) => view.setEnabled(enabled),
		setCommand: (command: string) => view.setCommand(command),
		showPricing: (state: StatusBarPricingState) =>
			view.render(buildStatusBarViewModel(state.displayName, state.pricing, state.data)),
	};
}

function buildMissingPricingVm(displayName: string | undefined): StatusBarViewModel {
	if (!displayName) {
		return {
			text: "No OpenRouter model",
			tooltip: _missingPricingNoModelTooltip,
			backgroundColor: undefined,
			show: true,
		};
	}

	return {
		text: `${truncate(displayName, 18)} $(question)`,
		tooltip: _missingPricingTooltip(displayName),
		backgroundColor: new vscode.ThemeColor("statusBarItem.warningBackground"),
		show: true,
	};
}

function buildPricingVm(
	displayName: string | undefined,
	pricing: ModelPricingInfo,
	cache: CachedPricingData | undefined,
): StatusBarViewModel {
	const cacheLabel = cache ? `*Updated ${formatTimestamp(cache.fetchedAt)}*` : "";

	// maxLen=0 means "no cap" — let VS Code's status bar handle overflow with its own ellipsis
	const configuredMax = getStatusBarMaxWidth();
	const maxLen = configuredMax > 0 ? configuredMax : Infinity;

	// Include blend settings because they can change without refreshing the cache.
	const weights = getBlendWeights();
	const tooltipKey =
		`${pricing.id}|${pricing.blendedRate}|${cache?.fetchedAt ?? "nocache"}|` +
		`${weights.cacheRead}|${weights.cacheWrite}|${weights.prompt}|${weights.completion}`;
	if (_lastTooltipKey !== tooltipKey) {
		_lastTooltipKey = tooltipKey;
		_lastTooltip = buildTooltipMd(pricing, cacheLabel);
		log.debug("statusBarPresenter: tooltip cache miss, rebuilt for", pricing.id);
	}

	const text = renderStatusBarText(pricing, displayName, maxLen);

	return {
		text,
		tooltip: _lastTooltip!,
		backgroundColor: pricing.isDeprecated
			? new vscode.ThemeColor("statusBarItem.warningBackground")
			: undefined,
		show: true,
	};
}
