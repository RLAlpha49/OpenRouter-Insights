/**
 * Command composition — builds every `ICommand` instance from already-created
 * services and returns the immutable command map used by `CommandRegistrar`.
 *
 * Adding a command means adding one line here; no other composition module or
 * runtime consumer has to change.
 */

import type * as vscode from "vscode";
import type { IPricingCache } from "../../api/cache/pricingStore";
import type { IUsageStore } from "../../api/cache/usageStore";
import type { SecretStorageService } from "../../api/secretStorageService";
import type { HttpClient } from "../../api/transport/httpClient";
import type { StatusBarView } from "../../ui/status/statusBarView";
import type { ModelPickerEnhancer } from "../../ui/model-browser/modelPickerEnhancer";
import type { UsageRefreshUseCase } from "../../use-cases/usageRefreshUseCase";
import type { EventBus } from "../eventBus";
import type { RuntimeDiagnostics } from "../runtimeDiagnostics";
import type { ICommand } from "../commands";
import {
	RefreshPricingCommand,
	BrowseModelsCommand,
	ShowFavoritesCommand,
	CompareModelsCommand,
	SetModelOverrideCommand,
	ShowLogsCommand,
	ToggleStatusBarCommand,
	ExportCsvCommand,
	ExportJsonCommand,
	AddToFavoritesCommand,
	RemoveFromFavoritesCommand,
	CopyModelIdCommand,
	OpenOnOpenRouterCommand,
	ShowQuickActionsCommand,
	ClearCacheCommand,
	ShowCacheInfoCommand,
	ViewModelDetailCommand,
	ClearSelectedModelCommand,
	ShowRuntimeDiagnosticsCommand,
} from "../commands";
import {
	SetApiKeyCommand,
	RemoveApiKeyCommand,
	RefreshUsageCommand,
	LoadUsageDetailsCommand,
	OpenUsageDashboardCommand,
	OpenExpandedDashboardCommand,
	SelectUsageKeyCommand,
	CreateApiKeyCommand,
	RenameApiKeyCommand,
	ToggleApiKeyCommand,
	SetKeyLimitCommand,
	DeleteApiKeyCommand,
} from "../usageCommands";
import type { CommandGate } from "./contracts";

export interface CommandServiceDependencies {
	readonly cache: IPricingCache;
	readonly usageCache: IUsageStore;
	readonly secrets: SecretStorageService;
	readonly statusBar: StatusBarView;
	readonly modelPicker: ModelPickerEnhancer;
	readonly usageRefreshUseCase: UsageRefreshUseCase;
	readonly eventBus: EventBus;
	readonly diagnostics: RuntimeDiagnostics;
	readonly httpClient: HttpClient;
	readonly features: CommandGate;
	readonly doRefresh: () => Promise<void>;
	readonly doUsageRefresh: () => Promise<void>;
	readonly openExpandedDashboard: () => vscode.WebviewPanel;
}

/** Build the immutable command map for this activation. */
export function createCommandServices(
	deps: CommandServiceDependencies,
): ReadonlyMap<string, ICommand> {
	const commands = new Map<string, ICommand>();
	const add = (command: ICommand) => {
		commands.set(command.id, command);
	};

	// ── Pricing and model commands ─────────────────────────
	add(new RefreshPricingCommand(deps.doRefresh));
	add(new BrowseModelsCommand(deps.cache, deps.modelPicker));
	add(new ShowFavoritesCommand(deps.cache, deps.modelPicker));
	add(new CompareModelsCommand(deps.cache, deps.modelPicker));
	add(new SetModelOverrideCommand(deps.cache, deps.modelPicker));
	add(new ShowLogsCommand());
	add(new ToggleStatusBarCommand(deps.statusBar));
	add(new ExportCsvCommand(deps.cache));
	add(new ExportJsonCommand(deps.cache));
	add(new AddToFavoritesCommand());
	add(new RemoveFromFavoritesCommand());
	add(new CopyModelIdCommand(deps.cache, deps.modelPicker, deps.eventBus));
	add(new OpenOnOpenRouterCommand(deps.cache, deps.modelPicker));
	add(
		new ShowQuickActionsCommand(commands, (commandId) =>
			deps.features.shouldRegisterCommand(commandId),
		),
	);
	add(new ClearCacheCommand(deps.cache));
	add(new ShowCacheInfoCommand(deps.cache, deps.diagnostics));
	add(new ShowRuntimeDiagnosticsCommand(deps.diagnostics));
	add(new ViewModelDetailCommand(deps.cache, deps.modelPicker));
	add(new ClearSelectedModelCommand());

	// ── Usage and key-management commands ──────────────────
	add(new SetApiKeyCommand(deps.secrets, deps.doUsageRefresh));
	add(new RemoveApiKeyCommand(deps.secrets, () => deps.usageRefreshUseCase.clear()));
	add(new RefreshUsageCommand(deps.usageRefreshUseCase));
	add(new LoadUsageDetailsCommand(deps.usageRefreshUseCase));
	add(new OpenUsageDashboardCommand());
	add(new OpenExpandedDashboardCommand(deps.openExpandedDashboard));
	add(new SelectUsageKeyCommand((keyHash) => deps.usageRefreshUseCase.executeWithKey(keyHash)));
	add(new CreateApiKeyCommand(deps.secrets, deps.doUsageRefresh, deps.httpClient));
	add(new RenameApiKeyCommand(deps.secrets, deps.usageCache, deps.doUsageRefresh, deps.httpClient));
	add(new ToggleApiKeyCommand(deps.secrets, deps.usageCache, deps.doUsageRefresh, deps.httpClient));
	add(new SetKeyLimitCommand(deps.secrets, deps.usageCache, deps.doUsageRefresh, deps.httpClient));
	add(new DeleteApiKeyCommand(deps.secrets, deps.usageCache, deps.doUsageRefresh, deps.httpClient));

	return commands;
}
