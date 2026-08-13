/**
 * Model picker UI: QuickPick browsers, model switcher, and comparison view.
 *
 * Delegates discovery to ConfiguredModelDiscovery, cost icons to
 * CostIconFactory, and webview comparison to ComparisonViewService.
 * The class itself focuses on QuickPick orchestration — no static state,
 * no HTML generation, no icon SVGs.
 */

import * as vscode from "vscode";
import type { ModelPricingInfo } from "../../types";
import { log } from "../../infrastructure/logger";
import { ConfiguredModelDiscovery } from "./configuredModelDiscovery";
import { costIcon } from "./costIconFactory";
import { showComparisonWebview } from "./comparisonViewService";
import {
	getShowFreeModelsOnly,
	getModelBrowserSort,
	getFavoriteModels,
	setSelectedModelId,
	getShowDeprecatedModels,
} from "../../infrastructure/config";
import { pricingDetail } from "../formatting/formatting";
import { showModelDetailWebview } from "../webviews/modelDetailView";

function browserDetail(model: ModelPricingInfo): string {
	const description = model.description.trim().replace(/\s+/g, " ");
	const descriptionSuffix = description ? ` · ${description}` : "";
	return `${pricingDetail(model)}${descriptionSuffix}`;
}

function browserBadgePrefix(model: ModelPricingInfo): string {
	const badges: string[] = [];
	if (model.isFree || model.blendedRate === 0) badges.push("FREE");
	if (model.discountToUser > 0 && model.discountToUser < 1) {
		badges.push(`${Math.round(model.discountToUser * 100)}% OFF`);
	}
	if (model.isDeprecated) badges.push("DEPRECATED");
	return badges.length > 0 ? `[${badges.join(" · ")}] ` : "";
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
	modelInfo: ModelPricingInfo;
}

export class ModelPickerEnhancer {
	readonly configuredModels: ConfiguredModelDiscovery;

	constructor() {
		this.configuredModels = new ConfiguredModelDiscovery();
	}

	dispose(): void {
		this.configuredModels.invalidateCache();
	}

	/** Start Copilot model discovery during activation so the first browser open is fast. */
	warmConfiguredModelDiscovery(): void {
		this.configuredModels.warm();
	}

	/** Invalidate the configured-model-ID cache. */
	invalidateConfiguredIdsCache(): void {
		this.configuredModels.invalidateCache();
	}

	/** Invalidate memoized browser sorting after pricing presentation changes. */
	invalidateSortCache(): void {
		invalidateSortCache();
	}

	/** Discover configured model IDs. */
	async discoverConfiguredModelIds(
		pricingLookup?: Map<string, ModelPricingInfo>,
	): Promise<Set<string>> {
		return this.configuredModels.discoverModelIds(pricingLookup);
	}

	/**
	 * Show a flat QuickPick of all cached OpenRouter models with pricing.
	 * Favorites are pinned to the top.
	 */
	async showModelBrowser(pricing: ModelPricingInfo[], _configuredIds?: Set<string>): Promise<void> {
		const filtered = filterAndSort(pricing);
		if (filtered.length === 0) {
			log.warn("showModelBrowser: no models match current filters");
			void vscode.window.showWarningMessage(
				"No models match the current filters. Adjust your settings or refresh pricing.",
			);
			return;
		}
		invalidateSortCache();

		// Pin favorites to the top
		const favorites = new Set(getFavoriteModels());
		const sorted = [...filtered].sort((a, b) => {
			const aFav = favorites.has(a.id) ? 0 : 1;
			const bFav = favorites.has(b.id) ? 0 : 1;
			return aFav - bFav;
		});
		const qp = showQuickPick(buildBrowserItems(sorted, favorites), "OpenRouter Model Pricing");
		if (!qp) return;
	}

	/** Show a filterable QuickPick containing only models in the favorites collection. */
	async showFavoriteModels(pricing: ModelPricingInfo[]): Promise<void> {
		const favorites = new Set(getFavoriteModels());
		const filtered = filterAndSort(pricing).filter((model) => favorites.has(model.id));
		if (filtered.length === 0) {
			void vscode.window.showWarningMessage(
				"No favorited models are available in the cached catalog. Add a model to Favorites first.",
			);
			return;
		}
		showQuickPick(buildBrowserItems(filtered, favorites), "Favorite OpenRouter Models");
	}

	/**
	 * Webview-based side-by-side model comparison.
	 * User selects 2-5 models and sees a comparison table with pricing,
	 * context length, deprecation status, and OpenRouter links.
	 */
	async showComparisonView(pricing: ModelPricingInfo[], configuredIds: Set<string>): Promise<void> {
		const filtered = filterAndSort(pricing).filter((model) => configuredIds.has(model.id));
		if (filtered.length < 2) {
			void vscode.window.showWarningMessage("Need at least 2 configured models to compare.");
			return;
		}

		// Multi-select QuickPick to choose models to compare
		const items: ModelQuickPickItem[] = filtered.map((m) => ({
			label: m.name,
			description: m.id,
			detail: pricingDetail(m),
			modelInfo: m,
			picked: false,
		}));

		const qp = vscode.window.createQuickPick<ModelQuickPickItem>();
		qp.title = "Select Models to Compare (2–5)";
		qp.placeholder = "Pick 2–5 models to compare side-by-side…";
		qp.matchOnDescription = true;
		qp.matchOnDetail = true;
		qp.items = items;
		qp.canSelectMany = true;

		const disposeOnce = createDisposeOnce(qp);

		const selected = await new Promise<ModelPricingInfo[]>((resolve) => {
			let resolved = false;
			qp.onDidAccept(() => {
				const picked = qp.selectedItems.map((i) => i.modelInfo);
				if (picked.length < 2 || picked.length > 5) {
					void vscode.window.showWarningMessage("Select 2–5 models to compare.");
					return;
				}
				resolved = true;
				resolve(picked);
				disposeOnce();
			});
			qp.onDidHide(() => {
				disposeOnce();
				if (!resolved) resolve([]);
			});
			qp.show();
		});

		if (selected.length < 2) return;
		showComparisonWebview(selected, "blendedRate");
	}

	/**
	 * Quick model switcher — pick a configured model and switch Copilot to it.
	 * Sets the selectedModelId config and opens the Copilot model picker.
	 */
	async showModelSwitcher(pricing: ModelPricingInfo[], configuredIds: Set<string>): Promise<void> {
		const filtered = filterAndSort(pricing).filter((model) => configuredIds.has(model.id));
		if (filtered.length === 0) {
			void vscode.window.showWarningMessage("No configured models to switch to.");
			return;
		}

		const favorites = new Set(getFavoriteModels());
		const sorted = [...filtered].sort((a, b) => {
			const aFav = favorites.has(a.id) ? 0 : 1;
			const bFav = favorites.has(b.id) ? 0 : 1;
			return aFav - bFav || a.blendedRate - b.blendedRate || a.name.localeCompare(b.name);
		});

		const items: ModelQuickPickItem[] = sorted.map((m) => {
			const isFav = favorites.has(m.id);
			const favPrefix = isFav ? "$(star-full) " : "";
			return {
				label: `${favPrefix}${m.name}`,
				description: m.id,
				detail: pricingDetail(m),
				modelInfo: m,
				iconPath: costIcon(m.blendedRate),
			};
		});

		const qp = vscode.window.createQuickPick<ModelQuickPickItem>();
		qp.title = "Set Model Override";
		qp.placeholder = "Pick a model to set as override…";
		qp.matchOnDescription = true;
		qp.matchOnDetail = true;
		qp.items = items;
		qp.canSelectMany = false;

		const disposeOnce = createDisposeOnce(qp);

		qp.onDidAccept(async () => {
			const selected = qp.selectedItems[0];
			if (!selected) return;
			disposeOnce();

			await setSelectedModelId(selected.modelInfo.id);

			void vscode.window.showInformationMessage(
				`Model override set to "${selected.modelInfo.name}". It remains selected until cleared.`,
			);
		});

		qp.onDidHide(() => disposeOnce());
		qp.show();
	}
}

// ── shared helpers ─────────────────────────────────────────────

/** Build QuickPick buttons for a model item (external link + favorite toggle). */
function buildModelButtons(_m: ModelPricingInfo, isFavorite: boolean): vscode.QuickInputButton[] {
	const buttons: vscode.QuickInputButton[] = [
		{ iconPath: new vscode.ThemeIcon("link-external"), tooltip: "Open on OpenRouter" },
	];
	buttons.push(
		isFavorite
			? { iconPath: new vscode.ThemeIcon("star-delete"), tooltip: "Remove from Favorites" }
			: { iconPath: new vscode.ThemeIcon("star-add"), tooltip: "Add to Favorites" },
	);
	return buttons;
}

/** Sort models by the configured sort order with stable tie-breaking. */
function sortModels(models: ModelPricingInfo[], sort: string): ModelPricingInfo[] {
	const sorted = [...models];
	switch (sort) {
		case "blendedRate":
			sorted.sort((a, b) => a.blendedRate - b.blendedRate || a.name.localeCompare(b.name));
			break;
		case "promptPrice":
			sorted.sort(
				(a, b) => a.perMillion.prompt - b.perMillion.prompt || a.name.localeCompare(b.name),
			);
			break;
		case "completionPrice":
			sorted.sort(
				(a, b) => a.perMillion.completion - b.perMillion.completion || a.name.localeCompare(b.name),
			);
			break;
		case "contextLength":
			sorted.sort((a, b) => b.contextLength - a.contextLength || a.name.localeCompare(b.name));
			break;
		case "name":
			sorted.sort((a, b) => a.name.localeCompare(b.name));
			break;
	}
	return sorted;
}

interface CapabilityFilterSnapshot {
	showDeprecated: boolean;
}

function snapshotCapabilityFilters(): CapabilityFilterSnapshot {
	return {
		showDeprecated: getShowDeprecatedModels(),
	};
}

function applyCapabilityFilters(
	models: ModelPricingInfo[],
	f: CapabilityFilterSnapshot,
): ModelPricingInfo[] {
	let result = models;
	if (!f.showDeprecated) result = result.filter((m) => !m.isDeprecated);
	return result;
}

// ── QuickPick sort memoization ─────────────────────────
// Keyed by (sortMode + freeOnly + configuredIds hash)
// to avoid re-sorting 300+ models on every browser open.
let _sortCacheKey = "";
let _sortCacheSorted: ModelPricingInfo[] = [];
let _activeBrowserQuickPick: vscode.QuickPick<ModelQuickPickItem> | undefined;

function invalidateSortCache(): void {
	_sortCacheKey = "";
	_sortCacheSorted = [];
}

function getSortCacheKey(sortMode: string, freeOnly: boolean, configuredIds: Set<string>): string {
	return `${sortMode}|${freeOnly}|${[...configuredIds].sort((a, b) => a.localeCompare(b)).join(",")}`;
}

/** Filter to configured/available models, apply all active filters, and sort — memoized. */
function filterAndSort(pricing: ModelPricingInfo[]): ModelPricingInfo[] {
	const sortMode = getModelBrowserSort();
	const freeOnly = getShowFreeModelsOnly();
	const caps = snapshotCapabilityFilters();

	const filterFingerprint = [freeOnly, caps.showDeprecated].join("|");
	const cacheKey = getSortCacheKey(sortMode, freeOnly, new Set(pricing.map((model) => model.id)));
	const cacheKeyCombined = `${cacheKey}|${filterFingerprint}|${pricing.length}`;

	if (_sortCacheKey === cacheKeyCombined && _sortCacheSorted.length > 0) {
		return _sortCacheSorted;
	}

	let models = [...pricing];
	if (freeOnly) models = models.filter((m) => m.blendedRate === 0);
	models = applyCapabilityFilters(models, caps);
	const result = sortModels(models, sortMode);

	_sortCacheKey = cacheKeyCombined;
	_sortCacheSorted = result;
	return result;
}

/** Create a single-fire dispose helper for QuickPicks. */
function createDisposeOnce(qp: vscode.QuickPick<ModelQuickPickItem>, onDispose?: () => void) {
	let disposed = false;
	return () => {
		if (!disposed) {
			disposed = true;
			onDispose?.();
			qp.dispose();
		}
	};
}

function buildBrowserItems(
	models: ModelPricingInfo[],
	favorites: Set<string>,
): ModelQuickPickItem[] {
	return models.map((m) => {
		const isFav = favorites.has(m.id);
		return {
			label: `${isFav ? "$(star-full) " : ""}${browserBadgePrefix(m)}${m.name}`,
			description: m.id,
			detail: browserDetail(m),
			modelInfo: m,
			iconPath: costIcon(m.blendedRate),
			buttons: buildModelButtons(m, isFav),
		} as ModelQuickPickItem;
	});
}

/** Show a QuickPick with the standard accept/external-link behavior and favorite toggle. */
function showQuickPick(
	items: ModelQuickPickItem[],
	title: string,
): vscode.QuickPick<ModelQuickPickItem> | undefined {
	if (_activeBrowserQuickPick) return undefined;
	const qp = vscode.window.createQuickPick<ModelQuickPickItem>();
	_activeBrowserQuickPick = qp;
	qp.title = title;
	qp.placeholder = "Search model name, ID, or description…";
	qp.matchOnDescription = true;
	qp.matchOnDetail = true;
	qp.items = items;
	qp.canSelectMany = false;

	const disposeOnce = createDisposeOnce(qp, () => {
		if (_activeBrowserQuickPick === qp) _activeBrowserQuickPick = undefined;
	});

	qp.onDidTriggerItemButton(async (e) => {
		const modelId = e.item.modelInfo.id;
		const isStarAdd = e.button.tooltip === "Add to Favorites";
		const isStarDelete = e.button.tooltip === "Remove from Favorites";

		if (isStarAdd) {
			await vscode.commands.executeCommand("openrouter-insights.addToFavorites", modelId);
			refreshQuickPickFavorites(qp, modelId, true);
		} else if (isStarDelete) {
			await vscode.commands.executeCommand("openrouter-insights.removeFromFavorites", modelId);
			refreshQuickPickFavorites(qp, modelId, false);
		} else {
			await vscode.env.openExternal(
				vscode.Uri.parse(`https://openrouter.ai/models/${encodeURI(modelId)}`),
			);
		}
	});

	qp.onDidAccept(() => {
		const selected = qp.selectedItems[0];
		if (selected) {
			showModelDetailWebview(selected.modelInfo);
		}
		disposeOnce();
	});

	qp.onDidHide(() => disposeOnce());
	qp.show();
	return qp;
}

/** Refresh a single item's star icon in the QuickPick after a favorite toggle. */
function refreshQuickPickFavorites(
	qp: vscode.QuickPick<ModelQuickPickItem>,
	modelId: string,
	isNowFavorite: boolean,
): void {
	const favorites = new Set(getFavoriteModels());
	qp.items = qp.items.map((item) => {
		if (item.modelInfo.id !== modelId) return item;
		const isFav = isNowFavorite || favorites.has(item.modelInfo.id);
		return {
			...item,
			label: isFav
				? item.label.replace(/^\$\([^)]*\)\s*/, "$(star-full) ")
				: item.label.replace(/^\$\(star-full\)\s*/, ""),
			buttons: buildModelButtons(item.modelInfo, isFav),
		} as ModelQuickPickItem;
	});
}
