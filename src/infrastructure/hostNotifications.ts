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

/** Notification port backed by the VS Code window API. */
export const vscodeStatusNotifier: StatusNotifier = {
	info: (message: string) => void vscode.window.showInformationMessage(message),
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
