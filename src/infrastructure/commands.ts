/**
 * Command pattern — each VS Code command is a self-contained class
 * implementing ICommand. The CommandRegistry auto-discovers commands
 * from package.json, wires handlers, and provides the quick-actions
 * menu dynamically (no more hardcoded list duplicating package.json).
 *
 * Adding a new command is now a three-step process:
 *   1. Add the command definition to package.json
 *   2. Create a class implementing ICommand
 *   3. Register it in the CommandRegistry
 *
 * QuickActions is built automatically from registered commands that
 * have quickAction metadata.
 */

import * as vscode from "vscode";
import type { IPricingStore, IPricingCache } from "../api/cache/pricingStore";
import type { StatusBarView } from "../ui/status/statusBarView";
import type { ModelPickerEnhancer } from "../ui/model-browser/modelPickerEnhancer";
import type { EventBus } from "../infrastructure/eventBus";
import { exportPricing } from "../ui/exportService";
import { showModelDetailWebview } from "../ui/webviews/modelDetailView";
import { show, log, formatError } from "../infrastructure/logger";
import { ConfigService, getShowFreeModelsOnly, setSelectedModelId } from "../infrastructure/config";
import type { ModelPricingInfo } from "../types";
import type { RuntimeDiagnostics } from "./runtimeDiagnostics";

// ── Command interface ──────────────────────────────────────────

export interface ICommand {
	/** Unique command ID matching package.json contributes.commands */
	readonly id: string;
	/** Execute the command with the adapter-normalized arguments */
	execute(..._args: unknown[]): Promise<void>;
	/** Optional: show in QuickActions menu */
	readonly quickAction?: {
		label: string;
		description: string;
		group?: number;
		order?: number;
	};
	/** Optional argument adapter that normalizes raw VS Code command args. */
	readonly argAdapter?: CommandArgAdapter;
}

/**
 * Argument adapters preserve each command's argument contract at the
 * registration boundary. VS Code invokes every command with a loose
 * `unknown[]`; the adapter converts that into the typed tuple the command
 * expects so argument mismatches fail at registration rather than deep inside
 * the handler.
 */
export type CommandArgAdapter = (_raw: readonly unknown[]) => unknown[];

/** No positional arguments are expected; extra args are dropped. */
export const adaptNoArgs: CommandArgAdapter = () => [];

/** Exactly one optional model ID (string) is expected. */
export const adaptModelId: CommandArgAdapter = (raw) => {
	const first = raw[0];
	return [typeof first === "string" ? first : undefined];
};

/** Exactly one optional key hash (string) is expected. */
export const adaptKeyHash: CommandArgAdapter = (raw) => {
	const first = raw[0];
	return [typeof first === "string" ? first : undefined];
};

/** One optional scalar argument (string or boolean) is expected. */
export const adaptOptionalScalar: CommandArgAdapter = (raw) => {
	const first = raw[0];
	return [typeof first === "string" || typeof first === "boolean" ? first : undefined];
};

// ── Command implementations ────────────────────────────────────

export class RefreshPricingCommand implements ICommand {
	readonly id = "openrouter-insights.refreshPricing";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(refresh) Refresh Pricing",
		description: "Fetch the latest from OpenRouter",
	};
	constructor(private readonly _doRefresh: () => Promise<void>) {}
	async execute(): Promise<void> {
		await this._doRefresh();
	}
}

export class BrowseModelsCommand implements ICommand {
	readonly id = "openrouter-insights.browseModels";
	readonly argAdapter = adaptModelId;
	readonly quickAction = {
		label: "$(list-tree) Browse Models",
		description: "View configured models with pricing",
	};
	private _pending: Promise<void> | undefined;
	constructor(
		private readonly _cache: IPricingCache,
		private readonly _modelPicker: ModelPickerEnhancer,
	) {}
	async execute(modelId?: unknown): Promise<void> {
		if (this._pending !== undefined) return this._pending;
		this._pending = this._execute(modelId);
		try {
			await this._pending;
		} finally {
			this._pending = undefined;
		}
	}

	private async _execute(modelId?: unknown): Promise<void> {
		const data = this._cache.get();
		if (!data) {
			void vscode.window.showWarningMessage('No pricing data. Run "Refresh Pricing" first.');
			return;
		}
		if (typeof modelId === "string") {
			const model = data.models.find((m) => m.id === modelId);
			if (model) {
				showModelDetailWebview(model);
				return;
			}
		}
		const configuredIds = await this._modelPicker.discoverConfiguredModelIds(
			this._cache.getLookup(),
		);
		void this._modelPicker.showModelBrowser(data.models, configuredIds);
	}
}

export class CompareModelsCommand implements ICommand {
	readonly id = "openrouter-insights.compareModels";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(compare-changes) Compare Models",
		description: "Side-by-side comparison",
	};
	constructor(
		private readonly _cache: IPricingCache,
		private readonly _modelPicker: ModelPickerEnhancer,
	) {}
	async execute(): Promise<void> {
		const data = this._cache.get();
		if (!data) {
			void vscode.window.showWarningMessage('No pricing data. Run "Refresh Pricing" first.');
			return;
		}
		const configuredIds = await this._modelPicker.discoverConfiguredModelIds(
			this._cache.getLookup(),
		);
		void this._modelPicker.showComparisonView(data.models, configuredIds);
	}
}

export class SetModelOverrideCommand implements ICommand {
	readonly id = "openrouter-insights.setModelOverride";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(arrow-swap) Set Model Override",
		description: "Quickly switch between configured models",
	};
	constructor(
		private readonly _cache: IPricingCache,
		private readonly _modelPicker: ModelPickerEnhancer,
	) {}
	async execute(): Promise<void> {
		const data = this._cache.get();
		if (!data) {
			void vscode.window.showWarningMessage('No pricing data. Run "Refresh Pricing" first.');
			return;
		}
		const configuredIds = await this._modelPicker.discoverConfiguredModelIds(
			this._cache.getLookup(),
		);
		await this._modelPicker.showModelSwitcher(data.models, configuredIds);
	}
}

export class ShowLogsCommand implements ICommand {
	readonly id = "openrouter-insights.showLogs";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(output) Show Logs",
		description: "Open the extension output channel",
	};
	async execute(): Promise<void> {
		show();
	}
}

export class ToggleStatusBarCommand implements ICommand {
	readonly id = "openrouter-insights.toggleStatusBar";
	readonly argAdapter = adaptNoArgs;
	constructor(private readonly _statusBar: StatusBarView) {}
	async execute(): Promise<void> {
		const current = ConfigService.instance.showInStatusBar;
		await ConfigService.instance.setShowInStatusBar(!current);
		void vscode.window.showInformationMessage(
			`Status bar ${current ? "hidden" : "shown"} (setting saved)`,
		);
	}
}

export class ExportCsvCommand implements ICommand {
	readonly id = "openrouter-insights.exportCsv";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(export) Export Pricing as CSV",
		description: "Save pricing data to a CSV file",
	};
	constructor(private readonly _cache: IPricingStore) {}
	async execute(): Promise<void> {
		const data = this._cache.get();
		if (data && data.models.length > 0) {
			log.info("command: exportCsv,", data.models.length, "models");
			void exportPricing(data.models, "csv");
		} else {
			log.warn("exportCsv: no pricing data to export");
			void vscode.window.showWarningMessage('No pricing data. Run "Refresh Pricing" first.');
		}
	}
}

export class ExportJsonCommand implements ICommand {
	readonly id = "openrouter-insights.exportJson";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(export) Export Pricing as JSON",
		description: "Save pricing data to a JSON file",
	};
	constructor(private readonly _cache: IPricingStore) {}
	async execute(): Promise<void> {
		const data = this._cache.get();
		if (data && data.models.length > 0) {
			log.info("command: exportJson,", data.models.length, "models");
			void exportPricing(data.models, "json");
		} else {
			log.warn("exportJson: no pricing data to export");
			void vscode.window.showWarningMessage('No pricing data. Run "Refresh Pricing" first.');
		}
	}
}

export class AddToFavoritesCommand implements ICommand {
	readonly id = "openrouter-insights.addToFavorites";
	readonly argAdapter = adaptModelId;
	async execute(modelId?: unknown): Promise<void> {
		const id = typeof modelId === "string" ? modelId : undefined;
		if (!id) return;
		log.info("command: addToFavorites", id);
		const current = ConfigService.instance.favoriteModels;
		if (current.includes(id)) return;
		current.push(id);
		await ConfigService.instance.setFavoriteModels(current);
		void vscode.window.showInformationMessage(`Added "${id}" to favorites`);
	}
}

export class RemoveFromFavoritesCommand implements ICommand {
	readonly id = "openrouter-insights.removeFromFavorites";
	readonly argAdapter = adaptModelId;
	async execute(modelId?: unknown): Promise<void> {
		const id = typeof modelId === "string" ? modelId : undefined;
		if (!id) return;
		log.info("command: removeFromFavorites", id);
		const current = ConfigService.instance.favoriteModels;
		const updated = current.filter((fid) => fid !== id);
		if (updated.length === current.length) return;
		await ConfigService.instance.setFavoriteModels(updated);
		void vscode.window.showInformationMessage(`Removed "${id}" from favorites`);
	}
}

export class CopyModelIdCommand implements ICommand {
	readonly id = "openrouter-insights.copyModelId";
	readonly argAdapter = adaptModelId;
	constructor(
		private readonly _cache: IPricingCache,
		private readonly _modelPicker: ModelPickerEnhancer,
		private readonly _eventBus: EventBus,
	) {}
	async execute(modelId?: unknown): Promise<void> {
		try {
			if (typeof modelId === "string" && modelId.length > 0) {
				await vscode.env.clipboard.writeText(modelId);
				void vscode.window.showInformationMessage(`Copied "${modelId}"`);
				return;
			}
			const lookup = this._cache.getLookup();
			const configuredIds = await this._modelPicker.discoverConfiguredModelIds(lookup);
			// Pick a model from the browser
			const data = this._cache.get();
			if (!data?.models) return;
			const filtered = filterForCommand(data.models, configuredIds);
			const pick = await vscode.window.showQuickPick(
				filtered.map((m) => ({ label: m.name, description: m.id })),
				{ placeHolder: "Select model to copy ID…" },
			);
			if (pick) {
				await vscode.env.clipboard.writeText(pick.description ?? pick.label);
				void vscode.window.showInformationMessage(`Copied "${pick.description ?? pick.label}"`);
			}
		} catch (err) {
			log.error("copyModelId: failed", formatError(err));
			void vscode.window.showErrorMessage("Failed to copy model ID to clipboard");
		}
	}
}

export class OpenOnOpenRouterCommand implements ICommand {
	readonly id = "openrouter-insights.openOnOpenRouter";
	readonly argAdapter = adaptNoArgs;
	constructor(
		private readonly _cache: IPricingCache,
		private readonly _modelPicker: ModelPickerEnhancer,
	) {}
	async execute(): Promise<void> {
		try {
			const lookup = this._cache.getLookup();
			const configuredIds = await this._modelPicker.discoverConfiguredModelIds(lookup);
			const data = (this._cache as unknown as IPricingStore).get?.();
			if (!data?.models) return;
			const filtered = filterForCommand(data.models, configuredIds);
			const pick = await vscode.window.showQuickPick(
				filtered.map((m) => ({ label: m.name, description: m.id })),
				{ placeHolder: "Select model to open on OpenRouter…" },
			);
			if (pick) {
				const encodedId = encodeURI(pick.description ?? pick.label);
				const url = `https://openrouter.ai/models/${encodedId}`;
				void vscode.env.openExternal(vscode.Uri.parse(url));
			}
		} catch (err) {
			log.error("openOnOpenRouter: failed", formatError(err));
			void vscode.window.showErrorMessage("Failed to open OpenRouter URL");
		}
	}
}

// ── Model Detail Command ───────────────────────────────────────

export class ViewModelDetailCommand implements ICommand {
	readonly id = "openrouter-insights.viewModelDetail";
	readonly argAdapter = adaptModelId;
	readonly quickAction = {
		label: "$(info) View Model Detail",
		description: "Show detailed info for a specific model",
	};
	constructor(
		private readonly _cache: IPricingCache,
		private readonly _modelPicker: ModelPickerEnhancer,
	) {}
	async execute(modelId?: unknown): Promise<void> {
		const data = this._cache.get();
		if (!data?.models) {
			void vscode.window.showWarningMessage('No pricing data. Run "Refresh Pricing" first.');
			return;
		}
		const configuredIds = await this._modelPicker.discoverConfiguredModelIds(
			this._cache.getLookup(),
		);
		const filtered = filterForCommand(data.models, configuredIds);
		if (filtered.length === 0) {
			void vscode.window.showWarningMessage("No models match the current filters.");
			return;
		}
		if (typeof modelId === "string") {
			const model = data.models.find((m) => m.id === modelId);
			if (model) {
				showModelDetailWebview(model);
				return;
			}
		}
		const pick = await vscode.window.showQuickPick(
			filtered.map((m) => ({
				label: m.name,
				description: m.id,
				detail: `~$${m.blendedRate.toFixed(4)}/M tok · ${m.contextLengthFormatted} ctx`,
			})),
			{ placeHolder: "Select a model to view details…" },
		);
		if (pick) {
			const model = data.models.find((m) => m.id === pick.description);
			if (model) {
				showModelDetailWebview(model);
			}
		}
	}
}

export class ClearSelectedModelCommand implements ICommand {
	readonly id = "openrouter-insights.clearSelectedModel";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(debug-stop) Clear Model Override",
		description: "Return model pricing to automatic detection",
	};
	async execute(): Promise<void> {
		await setSelectedModelId("");
		void vscode.window.showInformationMessage(
			"Model override cleared. Automatic model detection restored.",
		);
	}
}

// ── Quick Actions (dynamically built from registry) ────────────

export class ShowQuickActionsCommand implements ICommand {
	readonly id = "openrouter-insights.showQuickActions";
	readonly argAdapter = adaptNoArgs;
	constructor(
		private readonly _commands: ReadonlyMap<string, ICommand>,
		private readonly _isEnabled: (_commandId: string) => boolean = () => true,
	) {}
	async execute(): Promise<void> {
		const quickItems = buildQuickActionItems(this._commands, this._isEnabled);

		const pick = await vscode.window.showQuickPick(quickItems, {
			placeHolder: "OpenRouter Insights — Quick Actions",
		});

		if (!pick) return;
		log.info("quickActions: selected", pick.action);
		const cmd = this._commands.get(pick.action);
		if (cmd) await cmd.execute();
	}
}

export function buildQuickActionItems(
	commands: ReadonlyMap<string, ICommand>,
	isEnabled: (_commandId: string) => boolean = () => true,
): { label: string; description: string; action: string }[] {
	const quickItems: { label: string; description: string; action: string }[] = [];
	for (const cmd of commands.values()) {
		if (cmd.quickAction && isEnabled(cmd.id)) {
			quickItems.push({
				label: cmd.quickAction.label,
				description: cmd.quickAction.description,
				action: cmd.id,
			});
		}
	}

	quickItems.sort((a, b) => {
		const rankA = quickActionRank(a.action);
		const rankB = quickActionRank(b.action);
		return rankA - rankB || a.label.localeCompare(b.label);
	});
	return quickItems;
}

/** Keep related actions together without coupling ordering to registration order. */
function quickActionRank(commandId: string): number {
	const ranks: Record<string, number> = {
		"openrouter-insights.refreshPricing": 10,
		"openrouter-insights.browseModels": 20,
		"openrouter-insights.setModelOverride": 21,
		"openrouter-insights.clearSelectedModel": 22,
		"openrouter-insights.compareModels": 30,
		"openrouter-insights.viewModelDetail": 31,
		"openrouter-insights.addToFavorites": 40,
		"openrouter-insights.removeFromFavorites": 41,
		"openrouter-insights.exportCsv": 50,
		"openrouter-insights.exportJson": 51,
		"openrouter-insights.setApiKey": 60,
		"openrouter-insights.refreshUsage": 61,
		"openrouter-insights.openUsageDashboard": 62,
		"openrouter-insights.openExpandedDashboard": 63,
		"openrouter-insights.createApiKey": 64,
		"openrouter-insights.renameApiKey": 65,
		"openrouter-insights.toggleApiKey": 66,
		"openrouter-insights.setKeyLimit": 67,
		"openrouter-insights.deleteApiKey": 68,
		"openrouter-insights.showLogs": 90,
		"openrouter-insights.clearCache": 91,
		"openrouter-insights.showCacheInfo": 92,
		"openrouter-insights.showRuntimeDiagnostics": 93,
	};
	return ranks[commandId] ?? 100;
}

// ── Helper ─────────────────────────────────────────────────────

function filterForCommand(
	models: ModelPricingInfo[],
	configuredIds: Set<string>,
): ModelPricingInfo[] {
	const freeOnly = getShowFreeModelsOnly();
	let filtered = models.filter((m) => configuredIds.has(m.id));
	if (freeOnly) filtered = filtered.filter((m) => m.blendedRate === 0);
	return filtered;
}

// ── Cache Management Commands ──────────────────────────────────

export class ClearCacheCommand implements ICommand {
	readonly id = "openrouter-insights.clearCache";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(trash) Clear Cache",
		description: "Clear cached pricing data (will need refresh)",
	};
	constructor(private readonly _cache: IPricingCache) {}
	async execute(): Promise<void> {
		const confirm = await vscode.window.showWarningMessage(
			"Clear all cached OpenRouter pricing data? You'll need to refresh afterwards.",
			{ modal: true },
			"Clear",
		);
		if (confirm !== "Clear") return;
		await this._cache.clear();
		void vscode.window.showInformationMessage(
			"OpenRouter Insights: Cache cleared. Run 'Refresh Pricing' to reload.",
		);
	}
}

export class ShowCacheInfoCommand implements ICommand {
	readonly id = "openrouter-insights.showCacheInfo";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(info) Cache Info",
		description: "Show cache age, size, and TTL",
	};
	constructor(
		private readonly _cache: IPricingCache,
		private readonly _diagnostics?: RuntimeDiagnostics,
	) {}
	async execute(): Promise<void> {
		const info = this._cache.cacheInfo();
		const snap = this._diagnostics?.snapshot();
		const detail = [
			`Age: ${info.age}`,
			`Models cached: ${info.modelCount}`,
			`Estimated size: ${info.sizeEstimate}`,
			`Last read/write: ${info.lastReadMs}ms / ${info.lastWriteMs}ms`,
			`TTL: ${info.ttlHours}h`,
			`Stale: ${info.stale ? "Yes — next refresh will fetch" : "No"}`,
			info.truncated
				? `Catalog: PARTIAL — pagination truncated (${info.truncationReason ?? "page-cap"})`
				: "Catalog: complete",
			snap ? `Runtime requests: ${snap.requests.total}` : undefined,
			snap
				? `Runtime cache hits/misses/writes: ${snap.cache.hits}/${snap.cache.misses}/${snap.cache.writes}`
				: undefined,
			snap
				? `Refresh: ${snap.refresh.started} started, ${snap.refresh.completed} completed, ${snap.refresh.failed} failed, ${snap.refresh.deduplicated} deduplicated`
				: undefined,
			snap ? `Failures: ${JSON.stringify(snap.failures)}` : undefined,
			snap && snap.recentFailures.length > 0
				? "Recent failures:\n" +
					snap.recentFailures.map((f) => `  [${f.kind}] ${f.message}`).join("\n")
				: undefined,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");

		await vscode.window.showInformationMessage(
			`OpenRouter Insights: ${info.modelCount} models cached (${info.age})`,
			{ modal: true, detail },
		);
	}
}

export class ShowRuntimeDiagnosticsCommand implements ICommand {
	readonly id = "openrouter-insights.showRuntimeDiagnostics";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(pulse) Runtime Diagnostics",
		description: "Show support diagnostics snapshot",
	};
	constructor(private readonly _diagnostics: RuntimeDiagnostics) {}
	async execute(): Promise<void> {
		const report = this._diagnostics.report();
		const items: { label: string; action: string }[] = [
			{ label: "$(copy) Copy diagnostics report", action: "copy" },
		];
		const pick = await vscode.window.showQuickPick(items, {
			placeHolder: "Runtime Diagnostics (bounded, redacted — no secrets or payloads)",
			title: "OpenRouter Insights",
		});
		if (pick?.action === "copy") {
			await vscode.env.clipboard.writeText(report);
			void vscode.window.showInformationMessage(
				"Diagnostics report copied to clipboard. Share it with support — it contains no secrets.",
			);
			return;
		}
		// Fall back to the output channel so the full report is always reachable.
		show();
		log.info("Runtime diagnostics report:\n" + report);
	}
}
