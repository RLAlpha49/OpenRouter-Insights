/**
 * Composition contracts — the narrow interfaces activation consumers depend
 * on instead of the whole service graph.
 *
 * `ExtensionRuntime` and `CommandRegistrar` only need a few capabilities each.
 * Declaring those capabilities here keeps the composition root free to change
 * how a service is built, and lets tests supply small fakes instead of
 * reconstructing every dependency.
 */

import type * as vscode from "vscode";
import type { IPricingCache } from "../../api/cache/pricingStore";
import type { EventBus } from "../eventBus";
import type { RefreshReason } from "../refreshContext";
import type { RuntimeDiagnostics } from "../runtimeDiagnostics";
import type { ICommand } from "../commands";

/** A view whose visibility follows a feature flag or setting. */
export interface ToggleableView {
	setEnabled(_enabled: boolean): void;
}

/** Credential probe used to publish activation context keys. */
export interface CredentialProbe {
	hasKey(): Promise<boolean>;
}

/** Model-picker capabilities the runtime drives on configuration changes. */
export interface ModelDiscoveryCache {
	warmConfiguredModelDiscovery(): void;
	invalidateSortCache(): void;
}

/** Status-bar workflow the runtime schedules and invalidates. */
export interface StatusBarRefresh {
	execute(): Promise<void>;
	invalidateCache(): void;
}

/** Usage detail workflow the runtime triggers after usage settings change. */
export interface UsageDetailRefresh {
	loadDetails(): Promise<void>;
}

/** Command-gating capability used when registering and invoking commands. */
export interface CommandGate {
	shouldRegisterCommand(_commandId: string): boolean;
}

/** Everything `ExtensionRuntime` needs from the composition root. */
export interface RuntimeServices {
	readonly cache: IPricingCache;
	readonly statusBar: ToggleableView;
	readonly usageStatusBar: ToggleableView;
	readonly usageDashboard: vscode.WebviewViewProvider;
	readonly secrets: CredentialProbe;
	readonly modelPicker: ModelDiscoveryCache;
	readonly statusBarUseCase: StatusBarRefresh;
	readonly usageRefreshUseCase: UsageDetailRefresh;
	readonly eventBus: EventBus;
	readonly doRefresh: () => Promise<void>;
	readonly doUsageRefresh: (_reason?: RefreshReason) => Promise<void>;
	readonly diagnostics: RuntimeDiagnostics;
}

/** Everything `CommandRegistrar` needs from the composition root. */
export interface CommandServices {
	readonly commands: ReadonlyMap<string, ICommand>;
	readonly features: CommandGate;
	readonly diagnostics?: RuntimeDiagnostics;
}
