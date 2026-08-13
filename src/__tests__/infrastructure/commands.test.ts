import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
	BrowseModelsCommand,
	ShowFavoritesCommand,
	ClearCacheCommand,
	CompareModelsCommand,
	ExportCsvCommand,
	ExportJsonCommand,
	AddToFavoritesCommand,
	RemoveFromFavoritesCommand,
	CopyModelIdCommand,
	OpenOnOpenRouterCommand,
	ViewModelDetailCommand,
	RefreshPricingCommand,
	SetModelOverrideCommand,
	ShowCacheInfoCommand,
	ShowQuickActionsCommand,
	buildQuickActionItems,
} from "../../infrastructure/commands";
import { exportPricing } from "../../ui/exportService";
import type { ModelPricingInfo } from "../../types";

function model(id = "openai/gpt-4o", overrides: Partial<ModelPricingInfo> = {}): ModelPricingInfo {
	return {
		id,
		name: "GPT-4o",
		blendedRate: 1,
		contextLength: 128000,
		contextLengthFormatted: "128K",
		maxOutputLength: 4096,
		isDeprecated: false,
		deprecationDate: "",
		isFree: false,
		discountToUser: 0,
		quantization: "",
		modality: "text",
		inputModalities: ["text"],
		outputModalities: ["text"],
		perMillion: {
			prompt: 1,
			completion: 2,
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

function store(data: { models: ModelPricingInfo[] } | undefined) {
	return {
		get: () => data,
		getLookup: () => new Map((data?.models ?? []).map((m) => [m.id, m])),
		clear: vi.fn(async () => {}),
		cacheInfo: vi.fn(() => ({
			age: "1m",
			modelCount: data?.models.length ?? 0,
			sizeEstimate: "1KB",
			lastReadMs: 1,
			lastWriteMs: 2,
			ttlHours: 24,
			stale: false,
			truncated: false,
		})),
	};
}

describe("command orchestration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("orders enabled quick actions by command rank", () => {
		const commands = new Map<string, any>([
			[
				"openrouter-insights.showLogs",
				{ id: "openrouter-insights.showLogs", quickAction: { label: "Logs", description: "logs" } },
			],
			[
				"openrouter-insights.refreshPricing",
				{
					id: "openrouter-insights.refreshPricing",
					quickAction: { label: "Refresh", description: "refresh" },
				},
			],
			[
				"openrouter-insights.browseModels",
				{
					id: "openrouter-insights.browseModels",
					quickAction: { label: "Browse", description: "browse" },
				},
			],
		]);
		expect(
			buildQuickActionItems(commands, (id) => id !== "openrouter-insights.showLogs").map(
				(item) => item.action,
			),
		).toEqual(["openrouter-insights.refreshPricing", "openrouter-insights.browseModels"]);
	});

	it("refreshes through the injected callback", async () => {
		const refresh = vi.fn(async () => {});
		await new RefreshPricingCommand(refresh).execute();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("warns when browse commands have no pricing data", async () => {
		const cache = store(undefined);
		const picker = { discoverConfiguredModelIds: vi.fn(), showModelBrowser: vi.fn() } as any;
		await new BrowseModelsCommand(cache as any, picker).execute();
		await new CompareModelsCommand(cache as any, picker).execute();
		await new SetModelOverrideCommand(cache as any, picker).execute();
		expect(picker.showModelBrowser).not.toHaveBeenCalled();
	});

	it("routes browse commands to the full catalog and configured actions", async () => {
		const data = { models: [model()] };
		const cache = store(data);
		const configured = new Set(["openai/gpt-4o"]);
		const picker = {
			discoverConfiguredModelIds: vi.fn(async () => configured),
			showModelBrowser: vi.fn(),
			showComparisonView: vi.fn(),
			showModelSwitcher: vi.fn(),
		} as any;
		await new BrowseModelsCommand(cache as any, picker).execute();
		await new CompareModelsCommand(cache as any, picker).execute();
		await new SetModelOverrideCommand(cache as any, picker).execute();
		expect(picker.showModelBrowser).toHaveBeenCalledWith(data.models);
		expect(picker.showComparisonView).toHaveBeenCalledWith(data.models, configured);
		expect(picker.showModelSwitcher).toHaveBeenCalledWith(data.models, configured);
	});

	it("routes the favorites command to the cached catalog", async () => {
		const data = { models: [model()] };
		const cache = store(data);
		const picker = { showFavoriteModels: vi.fn() } as any;

		await new ShowFavoritesCommand(cache as any, picker).execute();

		expect(picker.showFavoriteModels).toHaveBeenCalledWith(data.models);
	});

	it("opens detail view for a requested model instead of the browser", async () => {
		const data = { models: [model()] };
		const cache = store(data);
		const picker = {
			discoverConfiguredModelIds: vi.fn(async () => new Set(["openai/gpt-4o"])),
			showModelBrowser: vi.fn(),
		} as any;
		const showDetail = await import("../../ui/webviews/modelDetailView");
		const detailSpy = vi.spyOn(showDetail, "showModelDetailWebview").mockImplementation(() => {});

		await new BrowseModelsCommand(cache as any, picker).execute("openai/gpt-4o");

		expect(detailSpy).toHaveBeenCalledWith(data.models[0]);
		expect(picker.showModelBrowser).not.toHaveBeenCalled();
		detailSpy.mockRestore();
	});

	it("falls back to the browser for an unknown requested model", async () => {
		const data = { models: [model()] };
		const cache = store(data);
		const configured = new Set(["openai/gpt-4o"]);
		const picker = {
			discoverConfiguredModelIds: vi.fn(async () => configured),
			showModelBrowser: vi.fn(),
		} as any;

		await new BrowseModelsCommand(cache as any, picker).execute("missing/model");

		expect(picker.showModelBrowser).toHaveBeenCalledWith(data.models);
	});

	it("ignores cancelled or unknown quick actions", async () => {
		const child = { id: "child", execute: vi.fn(async () => {}) } as any;
		const command = new ShowQuickActionsCommand(new Map([["child", child]]));
		(vscode.window as any).showQuickPick = vi.fn(async () => undefined);
		await command.execute();
		(vscode.window as any).showQuickPick = vi.fn(async () => ({ action: "missing" }));
		await command.execute();
		expect(child.execute).not.toHaveBeenCalled();
	});

	it("coalesces concurrent model-browser requests", async () => {
		const data = { models: [model()] };
		const cache = store(data);
		let resolveBrowser: (() => void) | undefined;
		const browser = new Promise<void>((resolve) => {
			resolveBrowser = resolve;
		});
		const picker = {
			showModelBrowser: vi.fn(() => browser),
		} as any;
		const command = new BrowseModelsCommand(cache as any, picker);

		const first = command.execute();
		const second = command.execute();
		resolveBrowser?.();
		await Promise.all([first, second]);

		expect(picker.showModelBrowser).toHaveBeenCalledOnce();
	});

	it("clears confirmed cache and displays cache information", async () => {
		const cache = store({ models: [model()] });
		(vscode.window as any).showWarningMessage = vi.fn(async () => "Clear");
		(vscode.window as any).showInformationMessage = vi.fn(async () => undefined);
		await new ClearCacheCommand(cache as any).execute();
		await new ShowCacheInfoCommand(cache as any).execute();
		expect(cache.clear).toHaveBeenCalledOnce();
		expect(cache.cacheInfo).toHaveBeenCalledOnce();
	});

	it("executes the selected quick action", async () => {
		const child = { id: "child", execute: vi.fn(async () => {}) } as any;
		const commands = new Map([["child", child]]);
		(vscode.window as any).showQuickPick = vi.fn(async () => ({ action: "child" }));
		await new ShowQuickActionsCommand(commands).execute();
		expect(child.execute).toHaveBeenCalledOnce();
	});
});

describe("exportPricing", () => {
	it("writes CSV and JSON exports to a selected file", async () => {
		const fs = await import("node:fs");
		const writeFile = vi.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
		const uri = { fsPath: "C:/tmp/pricing.csv" };
		(vscode.window as any).showSaveDialog = vi.fn(async () => uri);
		(vscode.window as any).withProgress = vi.fn(
			async (_options: unknown, task: () => Promise<void>) => task(),
		);
		const priced = model("openai/model,quoted", { name: 'Quoted "model"' });

		await exportPricing([priced], "csv");
		expect(writeFile.mock.calls[0][1]).toContain('"openai/model,quoted"');
		(vscode.window as any).showSaveDialog = vi.fn(async () => ({ fsPath: "C:/tmp/pricing.json" }));
		await exportPricing([priced], "json");
		expect(writeFile.mock.calls[1][1]).toContain('"name": "Quoted \\"model\\""');
		(vscode.window as any).showSaveDialog = vi.fn(async () => ({ fsPath: "C:/tmp/line.csv" }));
		await exportPricing([model("openai/line", { name: "line\nbreak" })], "csv");
		expect(writeFile.mock.calls[2][1]).toContain('"line\nbreak"');
		writeFile.mockRestore();
	});

	it("rejects empty, cancelled, and mismatched exports", async () => {
		(vscode.window as any).showWarningMessage = vi.fn(async () => undefined);
		await exportPricing([], "csv");
		(vscode.window as any).showSaveDialog = vi.fn(async () => undefined);
		await exportPricing([model()], "json");
		(vscode.window as any).showSaveDialog = vi.fn(async () => ({ fsPath: "C:/tmp/pricing.csv" }));
		await exportPricing([model()], "json");
		expect((vscode.window as any).showWarningMessage).toHaveBeenCalled();
	});

	it("guards export commands when the cache is empty", async () => {
		const cache = store(undefined);
		(vscode.window as any).showWarningMessage = vi.fn(async () => undefined);

		await new ExportCsvCommand(cache as any).execute();
		await new ExportJsonCommand(cache as any).execute();

		expect((vscode.window as any).showWarningMessage).toHaveBeenCalledTimes(2);
	});

	it("rejects an export to an unsupported file extension without writing", async () => {
		const fs = await import("node:fs");
		const writeFile = vi.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
		(vscode.window as any).showSaveDialog = vi.fn(async () => ({ fsPath: "C:/tmp/pricing.txt" }));
		(vscode.window as any).showWarningMessage = vi.fn(async () => undefined);

		await exportPricing([model()], "csv");

		expect(writeFile).not.toHaveBeenCalled();
		expect((vscode.window as any).showWarningMessage).toHaveBeenCalled();
		writeFile.mockRestore();
	});

	it("reports a failed write through the UI without surfacing a secret", async () => {
		const fs = await import("node:fs");
		const secret = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789";
		const writeFile = vi
			.spyOn(fs.promises, "writeFile")
			.mockRejectedValue(
				new Error(`ENOENT: no such file or directory, open 'C:/Users/alex/${secret}.csv'`),
			);
		(vscode.window as any).showSaveDialog = vi.fn(async () => ({
			fsPath: "C:/Users/alex/out.csv",
		}));
		const errorMessage = vi.fn();
		(vscode.window as any).showErrorMessage = errorMessage;

		await exportPricing([model()], "csv");

		expect(writeFile).toHaveBeenCalled();
		expect(errorMessage).toHaveBeenCalled();
		expect(String(errorMessage.mock.calls[0][0])).not.toContain(secret);
		writeFile.mockRestore();
	});

	it("routes export commands to the selected format", async () => {
		const cache = store({ models: [model()] });
		const exportModule = await import("../../ui/exportService");
		const exportSpy = vi.spyOn(exportModule, "exportPricing").mockResolvedValue(undefined);

		await new ExportCsvCommand(cache as any).execute();
		await new ExportJsonCommand(cache as any).execute();

		expect(exportSpy).toHaveBeenNthCalledWith(
			1,
			[expect.objectContaining({ id: "openai/gpt-4o" })],
			"csv",
		);
		expect(exportSpy).toHaveBeenNthCalledWith(
			2,
			[expect.objectContaining({ id: "openai/gpt-4o" })],
			"json",
		);
		exportSpy.mockRestore();
	});
});

describe("command guard and cancellation paths", () => {
	it("does not add duplicate favorites or remove an unknown favorite", async () => {
		(vscode.workspace as any)._configValues = { "modelBrowser.favorites": ["openai/gpt-4o"] };
		const config = await import("../../infrastructure/config");
		config.ConfigService.instance.dispose();

		await new AddToFavoritesCommand().execute("openai/gpt-4o");
		await new RemoveFromFavoritesCommand().execute("missing/model");

		expect((vscode.workspace as any)._configValues["modelBrowser.favorites"]).toEqual([
			"openai/gpt-4o",
		]);
	});

	it("ignores missing model IDs for favorite commands", async () => {
		const config = await import("../../infrastructure/config");
		const setFavoriteSpy = vi.spyOn(config.ConfigService.instance, "setFavoriteModels");

		await new AddToFavoritesCommand().execute();
		await new RemoveFromFavoritesCommand().execute();

		expect(setFavoriteSpy).not.toHaveBeenCalled();
		setFavoriteSpy.mockRestore();
	});

	it("does nothing when copy or open commands are cancelled", async () => {
		const cache = store({ models: [model()] });
		const picker = {
			discoverConfiguredModelIds: vi.fn(async () => new Set(["openai/gpt-4o"])),
		} as any;
		(vscode.window as any).showQuickPick = vi.fn(async () => undefined);
		const clipboard = vi.spyOn(vscode.env.clipboard, "writeText");
		const openExternal = vi.spyOn(vscode.env, "openExternal");

		await new CopyModelIdCommand(cache as any, picker, {} as any).execute();
		await new OpenOnOpenRouterCommand(cache as any, picker).execute();

		expect(clipboard).not.toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
		clipboard.mockRestore();
		openExternal.mockRestore();
	});

	it("handles model-detail guards without opening a panel", async () => {
		const picker = { discoverConfiguredModelIds: vi.fn(async () => new Set()) } as any;
		await new ViewModelDetailCommand(store(undefined) as any, picker).execute();
		await new ViewModelDetailCommand(store({ models: [model()] }) as any, picker).execute();

		expect(picker.discoverConfiguredModelIds).toHaveBeenCalledOnce();
	});

	it("keeps cache unchanged when cache clearing is cancelled", async () => {
		const cache = store({ models: [model()] });
		(vscode.window as any).showWarningMessage = vi.fn(async () => "Cancel");

		await new ClearCacheCommand(cache as any).execute();

		expect(cache.clear).not.toHaveBeenCalled();
	});
});
