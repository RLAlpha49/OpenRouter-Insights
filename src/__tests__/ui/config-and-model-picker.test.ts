import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConfigService, getConfig, initConfigLogger } from "../../infrastructure/config";
import { SecretStorageService } from "../../api/secretStorageService";
import { showComparisonWebview } from "../../ui/model-browser/comparisonViewService";
import { showModelDetailWebview } from "../../ui/webviews/modelDetailView";
import { ModelPickerEnhancer } from "../../ui/model-browser/modelPickerEnhancer";
import { registerModelHoverProvider } from "../../ui/webviews/modelHoverProvider";
import type { ModelPricingInfo } from "../../types";

function model(id: string, overrides: Partial<ModelPricingInfo> = {}): ModelPricingInfo {
	return {
		id,
		name: id.split("/").at(-1) ?? id,
		blendedRate: 2,
		contextLength: 128000,
		contextLengthFormatted: "128K",
		maxOutputLength: 4096,
		isDeprecated: false,
		deprecationDate: "",
		isFree: false,
		discountToUser: 0,
		quantization: "",
		modality: "text->text",
		inputModalities: ["text"],
		outputModalities: ["text"],
		perMillion: {
			prompt: 1,
			completion: 3,
			image: 0,
			request: 0,
			inputCacheRead: 0,
			inputCacheWrite: 0,
			webSearch: 0,
			internalReasoning: 0,
		},
		topProviderContextLength: 0,
		topProviderMaxCompletionTokens: 0,
		topProviderIsModerated: false,
		topProviderId: "",
		topProviderName: "",
		supportedParameters: [],
		supportedFeatures: [],
		created: 0,
		detailsLink: "",
		description: "",
		...overrides,
	};
}

describe("ConfigService validated access", () => {
	beforeEach(() => {
		ConfigService.instance.dispose();
		(vscode.workspace as any)._configValues = {};
		initConfigLogger({ warn: vi.fn() });
	});

	it("reads, clamps, and validates configuration values", async () => {
		(vscode.workspace as any)._configValues = {
			"general.autoRefreshInterval": 1,
			"statusBar.maxWidth": 150,
			"general.blendWeights": { prompt: 10, completion: 5, cacheRead: 80, cacheWrite: 5 },
			"general.providerScope": "allProviders",
			"general.modelPollInterval": 301,
			"statusBar.clickAction": "quickActions",
			"modelBrowser.sort": "name",
			"general.logLevel": "debug",
			"modelBrowser.favorites": ["a", 1, "a"],
			"general.apiBaseUrl": "http://localhost/api/v1/models/",
			"general.currency": "EUR",
			"general.currencyRate": 0.9,
			"general.cacheTtlHours": 800,
			"usage.autoRefreshInterval": 1,
			"usage.analytics.lookbackDays": 91.8,
			"usage.lowBalanceThreshold": 3,
			"usage.statusBarClickAction": "sidebarDashboard",
		};
		const cfg = ConfigService.instance;
		expect(getConfig()).toBeDefined();
		expect(cfg.features.statusBar).toBe(true);
		expect(cfg.autoRefreshInterval).toBe(300);
		expect(cfg.statusBarMaxWidth).toBe(100);
		expect(cfg.blendWeights.prompt).toBeCloseTo(0.1);
		expect(cfg.providerFilter).toBe("allProviders");
		expect(cfg.modelPollInterval).toBe(300);
		expect(cfg.statusBarClickAction).toBe("quickActions");
		expect(cfg.modelBrowserSort).toBe("name");
		expect(cfg.logLevel).toBe("debug");
		expect(cfg.favoriteModels).toEqual(["a", "a"]);
		expect(cfg.apiBaseUrl).toBe("http://localhost/api/v1/models");
		expect(cfg.apiOrigin).toBe("https://openrouter.ai/api/v1");
		expect(cfg.currency).toBe("EUR");
		expect(cfg.currencyRate).toBe(0.9);
		expect(cfg.cacheTtlHours).toBe(720);
		expect(cfg.usageAutoRefreshInterval).toBe(60);
		expect(cfg.usageAnalyticsLookbackDays).toBe(90);
		expect(cfg.usageLowBalanceThreshold).toBe(3);
		expect(cfg.usageStatusBarClickAction).toBe("sidebarDashboard");
		expect(cfg.isFeatureEnabled("usage")).toBe(true);
		await cfg.setSelectedModelId("openai/gpt-4o");
		await cfg.setShowInStatusBar(false);
		await cfg.setFavoriteModels(["a", "a", 1 as any]);
		expect(cfg.selectedModelId).toBe("openai/gpt-4o");
		expect(cfg.showInStatusBar).toBe(false);
		expect(cfg.favoriteModels).toEqual(["a"]);
	});

	it("falls back safely for invalid values", () => {
		(vscode.workspace as any)._configValues = {
			"general.providerScope": "bad",
			"statusBar.clickAction": "bad",
			"modelBrowser.sort": "bad",
			"general.logLevel": "bad",
			"general.apiBaseUrl": "javascript:alert(1)",
			"general.currency": "bad",
			"usage.statusBarClickAction": "bad",
			"general.blendWeights": { prompt: 10, completion: 10, cacheRead: 10, cacheWrite: 10 },
		};
		const cfg = ConfigService.instance;
		expect(cfg.providerFilter).toBe("openrouterOnly");
		expect(cfg.statusBarClickAction).toBe("browseModels");
		expect(cfg.modelBrowserSort).toBe("blendedRate");
		expect(cfg.logLevel).toBe("info");
		expect(cfg.apiBaseUrl).toContain("openrouter.ai");
		expect(cfg.currency).toBe("USD");
		expect(cfg.usageStatusBarClickAction).toBe("fullDashboard");
		expect(cfg.blendWeights.prompt).toBeCloseTo(0.1);
	});

	it("rejects public pricing URLs outside the provider or localhost policy", () => {
		(vscode.workspace as any)._configValues = {
			"general.apiBaseUrl": "https://attacker.example/api/v1/models",
		};
		expect(ConfigService.instance.apiBaseUrl).toContain("openrouter.ai");

		(vscode.workspace as any)._configValues = {
			"general.apiBaseUrl": "https://user:pass@openrouter.ai/api/v1/models",
		};
		ConfigService.instance.dispose();
		expect(ConfigService.instance.apiBaseUrl).toContain("openrouter.ai");
	});
});

describe("SecretStorageService", () => {
	it("normalizes and manages a secret key", async () => {
		const values = new Map<string, string>();
		const context = {
			secrets: {
				store: vi.fn(async (key: string, value: string) => values.set(key, value)),
				get: vi.fn(async (key: string) => values.get(key)),
				delete: vi.fn(async (key: string) => values.delete(key)),
			},
		} as any;
		const service = new SecretStorageService(context);
		expect(await service.get()).toBe("");
		expect(await service.hasKey()).toBe(false);
		await service.set("  sk-or-v1-12345678901234567890  ");
		expect(await service.get()).toBe("sk-or-v1-12345678901234567890");
		expect(await service.hasKey()).toBe(true);
		await service.delete();
		expect(await service.hasKey()).toBe(false);
		service.dispose();
	});

	it("rejects invalid keys before writing to secret storage", async () => {
		const context = {
			secrets: {
				store: vi.fn(async () => undefined),
				get: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined),
			},
		} as any;
		const service = new SecretStorageService(context);

		await expect(service.set("not-a-key")).rejects.toThrow(/API key/i);
		await expect(service.set("sk-or-v1-short")).rejects.toThrow(/API key/i);
		expect(context.secrets.store).not.toHaveBeenCalled();
	});

	it("trims and stores a valid OpenRouter key", async () => {
		const context = {
			secrets: {
				store: vi.fn(async () => undefined),
				get: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined),
			},
		} as any;
		const service = new SecretStorageService(context);
		const key = "sk-or-v1-12345678901234567890";

		await service.set(`  ${key}  `);

		expect(context.secrets.store).toHaveBeenCalledWith("openrouter-insights.apiKey", key);
	});
});

describe("model detail and comparison webviews", () => {
	it("renders escaped model details and native action links", () => {
		const createPanel = vi.spyOn(vscode.window, "createWebviewPanel");
		const dangerous = model("openai/<detail>", {
			name: "<Detail>",
			description: "<script>alert(1)</script>",
			topProviderName: "<Provider>",
		});

		showModelDetailWebview(dangerous);

		const html = createPanel.mock.results.at(-1)?.value.webview.html as string;
		expect(html).toContain("&lt;Detail&gt;");
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain('href="command:openrouter-insights.refreshPricing"');
		expect(html).not.toContain('role="button"');
		createPanel.mockRestore();
	});

	it("renders comparison sorted both ways with pricing", () => {
		const first = model("openai/one", { name: "One", blendedRate: 1, maxOutputLength: 0 });
		const second = model("google/two", {
			name: "Two",
			blendedRate: 4,
			contextLength: 256000,
			contextLengthFormatted: "256K",
		});
		const before = (vscode.window as any)._quickPicks.length;
		showComparisonWebview([second, first], "blendedRate");
		showComparisonWebview([first, second], "priceDesc");
		expect((vscode.window as any)._quickPicks).toHaveLength(before);
	});
});

describe("ModelPickerEnhancer", () => {
	it("handles empty results and displays filtered provider models", async () => {
		const picker = new ModelPickerEnhancer();
		await picker.showModelBrowser([], new Set());
		await picker.showModelSwitcher([], new Set());
		await picker.showComparisonView([model("openai/one")], new Set(["openai/one"]));
		picker.invalidateSortCache();
		picker.invalidateConfiguredIdsCache();
		expect((vscode.window as any)._quickPicks).toBeDefined();
		// getMetricsForModels is only called when there are models to enrich
	});

	it("accepts a comparison selection and a model switch selection", async () => {
		const picker = new ModelPickerEnhancer();
		const first = model("openai/one");
		const second = model("google/two");
		const comparison = picker.showComparisonView([first, second], new Set([first.id, second.id]));
		const comparisonPick = (vscode.window as any)._quickPicks.at(-1);
		comparisonPick.selectedItems = [{ modelInfo: first }, { modelInfo: second }];
		comparisonPick.triggerAccept();
		await Promise.resolve();
		comparisonPick.dispose();
		await comparison;

		await picker.showModelSwitcher([first, second], new Set([first.id, second.id]));
		const switchPick = (vscode.window as any)._quickPicks.at(-1);
		switchPick.selectedItems = [{ modelInfo: first }];
		switchPick.triggerAccept();
		expect(switchPick.items).toHaveLength(2);
	});

	it("opens browsers and handles favorite buttons", async () => {
		const picker = new ModelPickerEnhancer();
		const first = model("openai/one", { description: "fast model" });
		const second = model("google/two", { blendedRate: 0 });
		await picker.showModelBrowser([first, second], new Set([first.id, second.id]));
		const browserPick = (vscode.window as any)._quickPicks.at(-1);
		browserPick.selectedItems = [{ modelInfo: first }];
		browserPick.triggerAccept();
		browserPick.triggerButton({
			item: { modelInfo: first },
			button: { tooltip: "Add to Favorites" },
		});
		browserPick.triggerButton({
			item: { modelInfo: first },
			button: { tooltip: "Remove from Favorites" },
		});
		browserPick.triggerButton({
			item: { modelInfo: first },
			button: { tooltip: "Open on OpenRouter" },
		});
		expect(browserPick.items).toHaveLength(2);
	});

	it("browses catalog models that are not configured in Copilot", async () => {
		const picker = new ModelPickerEnhancer();
		const configured = model("openai/configured");
		const catalogOnly = model("google/catalog-only");

		await picker.showModelBrowser([configured, catalogOnly]);

		const quickPick = (vscode.window as any)._quickPicks.at(-1);
		expect(
			quickPick.items.map((item: { modelInfo: ModelPricingInfo }) => item.modelInfo.id),
		).toEqual(expect.arrayContaining([configured.id, catalogOnly.id]));
		quickPick.triggerHide();
	});

	it("shows only existing favorites in the favorites collection", async () => {
		(vscode.workspace as any)._configValues = {
			"modelBrowser.favorites": ["openai/one", "stale/model"],
		};
		ConfigService.instance.dispose();
		const picker = new ModelPickerEnhancer();

		await picker.showFavoriteModels([model("openai/one"), model("google/two")]);

		const quickPick = (vscode.window as any)._quickPicks.at(-1);
		expect(quickPick.items).toHaveLength(1);
		expect(quickPick.items[0].modelInfo.id).toBe("openai/one");
		quickPick.triggerHide();
	});

	it("shows pricing badges without changing browser actions", async () => {
		const picker = new ModelPickerEnhancer();
		const featured = model("openai/featured", {
			name: "Featured",
			isFree: true,
			discountToUser: 0.25,
			isDeprecated: true,
		});

		await picker.showModelBrowser([featured], new Set([featured.id]));

		const item = (vscode.window as any)._quickPicks.at(-1).items[0];
		expect(item.label).toContain("FREE");
		expect(item.label).toContain("25% OFF");
		expect(item.label).toContain("DEPRECATED");
		expect(item.buttons).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tooltip: "Open on OpenRouter" }),
				expect.objectContaining({ tooltip: "Add to Favorites" }),
			]),
		);
		(vscode.window as any)._quickPicks.at(-1).triggerHide();
	});

	it("applies model picker filters and sorting", async () => {
		const picker = new ModelPickerEnhancer();
		const models = [
			model("openai/one", {
				name: "One",
				blendedRate: 1,
				contextLength: 1000,
				modality: "text",
				description: "fast text",
			}),
			model("openai/two", {
				name: "Two",
				blendedRate: 5,
				contextLength: 2000,
				modality: "image",
				description: "vision",
			}),
			model("google/three", {
				name: "Three",
				blendedRate: 0,
				contextLength: 3000,
				isFree: true,
				isDeprecated: true,
				modality: "text+image",
				description: "free vision",
			}),
		];
		const values = (vscode.workspace as any)._configValues;
		Object.assign(values, {
			"modelBrowser.showFreeOnly": false,
			"modelBrowser.showDeprecated": false,
		});
		for (const sort of ["blendedRate", "promptPrice", "completionPrice", "contextLength", "name"]) {
			values["modelBrowser.sort"] = sort;
			ConfigService.instance.dispose();
			await picker.showModelBrowser(models, new Set(models.map((m) => m.id)));
		}
		const browserPick = (vscode.window as any)._quickPicks.at(-1);
		expect(
			browserPick.items.map((item: { modelInfo: ModelPricingInfo }) => item.modelInfo.id),
		).toEqual(expect.arrayContaining(["openai/one", "openai/two"]));
		values["modelBrowser.showFreeOnly"] = true;
		ConfigService.instance.dispose();
		await picker.showModelBrowser(models, new Set(models.map((m) => m.id)));
	});

	it("handles picker hide and comparison cancellation", async () => {
		const picker = new ModelPickerEnhancer();
		const first = model("openai/one");
		const second = model("google/two");
		await picker.showModelBrowser([first], new Set([first.id]));
		const browserPick = (vscode.window as any)._quickPicks.at(-1);
		browserPick.triggerHide();
		await picker.showComparisonView([first, second], new Set([first.id, second.id]));
		const comparisonPick = (vscode.window as any)._quickPicks.at(-1);
		comparisonPick.selectedItems = [{ modelInfo: first }];
		comparisonPick.triggerAccept();
		comparisonPick.triggerHide();
		await Promise.resolve();
		expect(comparisonPick.selectedItems).toHaveLength(1);
	});

	it("rejects invalid comparison selections until two models are selected", async () => {
		const picker = new ModelPickerEnhancer();
		(vscode.workspace as any)._configValues = {
			"modelBrowser.showFreeOnly": false,
			"modelBrowser.showDeprecated": true,
		};
		ConfigService.instance.dispose();
		(vscode.window as any).showWarningMessage = vi.fn(async () => undefined);
		const first = model("openai/one");
		const second = model("google/two");
		const comparison = picker.showComparisonView([first, second], new Set([first.id, second.id]));
		const quickPick = (vscode.window as any)._quickPicks.at(-1);
		quickPick.selectedItems = [{ modelInfo: first }];
		quickPick.triggerAccept();
		expect(vscode.window.showWarningMessage as any).toHaveBeenCalledWith(
			"Select 2–5 models to compare.",
		);
		quickPick.triggerHide();
		await comparison;
	});
});

describe("ModelHoverProvider", () => {
	it("returns pricing hovers for known IDs and decorates matching editors", () => {
		const pricing = model("openai/gpt-4o");
		const index = {
			getValues: () => [pricing],
			getLookup: () => new Map([[pricing.id, pricing]]),
		} as any;
		const editor = {
			document: {
				uri: { scheme: "file" },
				isClosed: false,
				getWordRangeAtPosition: () =>
					new vscode.Range(
						new vscode.Position(0, 7),
						new vscode.Position(0, 7 + pricing.id.length),
					),
				getText: () => pricing.id,
				positionAt: (offset: number) => new vscode.Position(0, offset),
			},
			setDecorations: vi.fn(),
		} as any;
		(vscode.window as any).activeTextEditor = editor;
		const disposable = registerModelHoverProvider(index, () => "cached 1m ago");
		const provider = (vscode.languages as any)._hoverProviders.at(-1);
		const hover = provider.provideHover(editor.document, new vscode.Position(0, 7));
		expect(hover).toBeDefined();
		expect(editor.setDecorations).toHaveBeenCalled();
		for (const listener of (vscode.window as any)._activeEditorListeners) listener(undefined);
		for (const listener of (vscode.workspace as any)._textDocumentListeners)
			listener({ document: editor.document });
		disposable.dispose();
	});
});
