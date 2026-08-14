/**
 * Host notification adapters — the VS Code side of the application's
 * notification and pricing-outcome ports.
 *
 * Application use cases publish typed outcomes (`PricingRefreshPresenter`)
 * and never call `vscode.window.show*Message` themselves. Message wording and
 * severity policy live here so the workflow stays host-independent.
 */

import * as vscode from "vscode";
import type { PricingRefreshPresenter, StatusNotifier } from "../use-cases/ports";

/** How long an information notification stays on screen before auto-dismissing. */
const INFO_AUTO_DISMISS_MS = 4000;

/**
 * Information notifications are transient and should disappear on their own.
 * `showInformationMessage` never auto-dismisses, so we surface it as a
 * `withProgress` notification that resolves (and closes) after a short delay.
 */
function showAutoDismissingInfo(message: string): void {
	void vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: message },
		async () => {
			await new Promise((resolve) => setTimeout(resolve, INFO_AUTO_DISMISS_MS));
		},
	);
}

/** Notification port backed by the VS Code window API. */
export const vscodeStatusNotifier: StatusNotifier = {
	info: (message: string) => showAutoDismissingInfo(message),
	warning: (message: string) => void vscode.window.showWarningMessage(message),
	error: (message: string) => void vscode.window.showErrorMessage(message),
};

/**
 * Translate pricing refresh outcomes into user-facing notifications.
 * @param notifier Notification surface; defaults to the VS Code window API.
 */
export function createPricingRefreshPresenter(
	notifier: StatusNotifier = vscodeStatusNotifier,
): PricingRefreshPresenter {
	return {
		pricingUpdated: (modelCount: number) =>
			notifier.info(`OpenRouter pricing updated (${modelCount} models)`),
		pricingStale: (cacheAge: string, error: string) =>
			notifier.warning(
				`OpenRouter: couldn't fetch pricing — showing cached data from ${cacheAge}. ${error}`,
			),
		pricingUnavailable: (error: string) =>
			notifier.error(`OpenRouter: failed to fetch pricing — ${error}`),
	};
}
