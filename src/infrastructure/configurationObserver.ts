/**
 * ConfigurationObserver — bridges ConfigService typed events to
 * the handler callbacks used by the activation layer.
 *
 * Subscribe via ConfigService.instance.on* events instead of raw
 * VS Code configuration change events — this gives us validation,
 * caching, and typed event semantics for free.
 */

import * as vscode from "vscode";
import { ConfigService } from "./config";
import type { EventBus } from "./eventBus";

export interface ConfigChangeHandlers {
	onRefreshIntervalChanged: () => void;
	onDisplaySettingsChanged: () => void;
	onPollIntervalChanged: () => void;
	onUsageDataSettingsChanged?: () => void;
	onBlendWeightsChanged?: () => void;
}

/**
 * Subscribe to ConfigService typed configuration change events.
 * Also emits configChanged on the EventBus for decoupled consumers.
 * Returns a disposable that should be pushed to context.subscriptions.
 */
export function observeConfiguration(
	handlers: ConfigChangeHandlers,
	eventBus?: EventBus,
): vscode.Disposable {
	const cs = ConfigService.instance;

	const emitConfigChanged = () => eventBus?.emit("configChanged", undefined);

	return vscode.Disposable.from(
		cs.onRefreshIntervalChanged(() => {
			handlers.onRefreshIntervalChanged();
			emitConfigChanged();
		}),
		cs.onDisplaySettingsChanged(() => {
			handlers.onDisplaySettingsChanged();
			emitConfigChanged();
		}),
		cs.onPollIntervalChanged(() => {
			handlers.onPollIntervalChanged();
			emitConfigChanged();
		}),
		cs.onUsageDataSettingsChanged(() => {
			handlers.onUsageDataSettingsChanged?.();
			emitConfigChanged();
		}),
		cs.onBlendWeightsChanged(() => {
			handlers.onBlendWeightsChanged?.();
			emitConfigChanged();
		}),
	);
}
