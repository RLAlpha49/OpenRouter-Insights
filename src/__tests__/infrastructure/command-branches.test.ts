import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
	ShowQuickActionsCommand,
	ToggleStatusBarCommand,
	AddToFavoritesCommand,
	RemoveFromFavoritesCommand,
	CopyModelIdCommand,
	OpenOnOpenRouterCommand,
	ViewModelDetailCommand,
} from "../../infrastructure/commands";
import { UsageStatusBarView } from "../../ui/status/usageStatusBarView";
import { buildDashboardBody } from "../../ui/webviews/usageDashboard";
import { ConfigService } from "../../infrastructure/config";
import { parseModelIdentifier, parseRecentModel } from "../../models/sqlModelParser";
import { UsagePollingService } from "../../infrastructure/usagePollingService";

describe("remaining high-value command branches", () => {
	it("handles favorite, clipboard, external-link, and detail command paths", async () => {
		(vscode.workspace as any)._configValues = { "modelBrowser.favorites": [] };
		ConfigService.instance.dispose();
		const cache = {
			get: () => ({
				models: [
					{
						id: "openai/gpt-4o",
						name: "GPT",
						blendedRate: 1,
						contextLengthFormatted: "128K",
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
						contextLength: 128000,
						maxOutputLength: 4096,
						isDeprecated: false,
						isFree: false,
						deprecationDate: "",
						discountToUser: 0,
						quantization: "",
						modality: "text",
						inputModalities: [],
						outputModalities: [],
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
					},
				],
			}),
			getLookup: () => new Map(),
		} as any;
		const picker = {
			discoverConfiguredModelIds: vi.fn(async () => new Set(["openai/gpt-4o"])),
		} as any;
		(vscode.window as any).showQuickPick = vi.fn(async (items: any[]) => items[0]);
		(vscode.window as any).showInformationMessage = vi.fn(async () => undefined);
		await new AddToFavoritesCommand().execute("openai/gpt-4o");
		await new RemoveFromFavoritesCommand().execute("openai/gpt-4o");
		await new CopyModelIdCommand(cache, picker, {} as any).execute();
		await new OpenOnOpenRouterCommand(cache, picker).execute();
		await new ViewModelDetailCommand(cache, picker).execute("missing");
		expect((vscode.window as any).showQuickPick).toHaveBeenCalled();
	});

	it("executes a selected quick action and toggles status bar settings", async () => {
		const command = { id: "child", execute: vi.fn(async () => {}) } as any;
		(vscode.window as any).showQuickPick = vi.fn(async () => ({ action: "child" }));
		await new ShowQuickActionsCommand(new Map([["child", command]])).execute();
		const status = { setEnabled: vi.fn() } as any;
		await new ToggleStatusBarCommand(status).execute();
		expect(command.execute).toHaveBeenCalledOnce();
	});
});

describe("remaining usage presentation branches", () => {
	it("renders free-tier, no-limit, and disabled states", () => {
		const usage = {
			mode: "regular",
			isManagementKey: false,
			capabilities: {
				keys: "notApplicable",
				credits: "notApplicable",
				activity: "unavailable",
				perKeyActivity: "unavailable",
				analytics: "notApplicable",
				keyManagement: "notApplicable",
			},
			totalUsed: 1,
			dailyUsage: 0.1,
			weeklyUsage: 0.2,
			monthlyUsage: 0.3,
			limit: null,
			limitRemaining: null,
			limitReset: null,
			isFreeTier: true,
			usagePercent: null,
			allKeys: null,
			selectedKeyHash: null,
			accountCredits: null,
			fetchedAt: new Date().toISOString(),
			dailyUsageHistory: [],
			analytics: null,
		} as any;
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			"usage.backgroundPolling.enabled": true,
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();
		const html = buildDashboardBody(usage, false);
		expect(html).toContain("Free Tier");
		const view = new (UsageStatusBarView as any)();
		view.showUsage(usage, 5);
		view.setEnabled(false);
		view.render({ text: "x", tooltip: "x", show: false });
		view.dispose();
		(vscode.workspace as any)._configValues = original;
	});

	it("renders activity capability and analytics fallback messages", () => {
		const original = (vscode.workspace as any)._configValues;
		(vscode.workspace as any)._configValues = {
			"usage.backgroundPolling.enabled": true,
			"usage.analytics.enabled": true,
		};
		ConfigService.instance.dispose();
		const base = {
			mode: "regular",
			isManagementKey: false,
			capabilities: {
				keys: "notApplicable",
				credits: "notApplicable",
				activity: "unavailable",
				perKeyActivity: "unavailable",
				analytics: "notApplicable",
				keyManagement: "notApplicable",
			},
			totalUsed: 0,
			dailyUsage: 0,
			weeklyUsage: 0,
			monthlyUsage: 0,
			limit: null,
			limitRemaining: null,
			limitReset: null,
			isFreeTier: false,
			usagePercent: null,
			allKeys: null,
			selectedKeyHash: null,
			accountCredits: null,
			fetchedAt: new Date().toISOString(),
			dailyUsageHistory: null,
			analytics: null,
		};
		expect(
			buildDashboardBody(
				{ ...base, analyticsUnavailableReason: "managementKeyRequired" } as any,
				false,
			),
		).toContain("requires a management key");
		expect(
			buildDashboardBody({ ...base, analyticsUnavailableReason: "unavailable" } as any, false),
		).toContain("could not be loaded");
		(vscode.workspace as any)._configValues = original;
		ConfigService.instance.dispose();
	});
});

describe("small infrastructure and parser branches", () => {
	it("parses valid, fallback, and invalid model state values", () => {
		expect(parseModelIdentifier('{"identifier":"openai/gpt-4o"}')).toBe("openai/gpt-4o");
		expect(parseModelIdentifier('{"id":"openai/gpt-4o"}')).toBe("openai/gpt-4o");
		expect(parseModelIdentifier("openai/gpt-4o")).toBe("openai/gpt-4o");
		expect(parseModelIdentifier(undefined)).toBeUndefined();
		expect(parseRecentModel('["openai/gpt-4o"]')).toBe("openai/gpt-4o");
		expect(parseRecentModel("bad", vi.fn())).toBeUndefined();
		expect(parseRecentModel("[]")).toBeUndefined();
	});

	it("enables and disables usage polling based on configuration", () => {
		vi.useFakeTimers();
		(vscode.workspace as any)._configValues = { "usage.backgroundPolling.enabled": false };
		ConfigService.instance.dispose();
		const tick = vi.fn();
		const polling = new UsagePollingService(tick);
		vi.advanceTimersByTime(3600 * 1000);
		expect(tick).not.toHaveBeenCalled();
		(vscode.workspace as any)._configValues = {
			"usage.backgroundPolling.enabled": true,
			"usage.autoRefreshInterval": 60,
		};
		ConfigService.instance.dispose();
		polling.schedule();
		vi.advanceTimersByTime(60 * 1000);
		expect(tick).toHaveBeenCalled();
		polling.dispose();
		vi.useRealTimers();
	});

	it("does not schedule usage polling when the interval is zero", () => {
		vi.useFakeTimers();
		(vscode.workspace as any)._configValues = {
			"usage.backgroundPolling.enabled": true,
			"usage.autoRefreshInterval": 0,
		};
		ConfigService.instance.dispose();
		const tick = vi.fn();
		const polling = new UsagePollingService(tick);
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		expect(tick).not.toHaveBeenCalled();
		polling.dispose();
		polling.dispose();
		vi.useRealTimers();
	});

	it("does not tick after usage polling is disposed", () => {
		vi.useFakeTimers();
		(vscode.workspace as any)._configValues = {
			"usage.backgroundPolling.enabled": true,
			"usage.autoRefreshInterval": 60,
		};
		ConfigService.instance.dispose();
		const tick = vi.fn();
		const polling = new UsagePollingService(tick);
		polling.dispose();
		vi.advanceTimersByTime(60 * 1000);
		expect(tick).not.toHaveBeenCalled();
		vi.useRealTimers();
	});
});
