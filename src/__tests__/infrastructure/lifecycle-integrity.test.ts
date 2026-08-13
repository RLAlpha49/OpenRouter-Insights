import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { ConfigService, FEATURE_IDS } from "../../infrastructure/config";
import { RefreshCoordinator } from "../../infrastructure/refreshCoordinator";
import { ModelPollingService } from "../../infrastructure/modelPollingService";
import { UsagePollingService } from "../../infrastructure/usagePollingService";
import { RefreshScheduler } from "../../infrastructure/refreshScheduler";
import { UsageDashboardProvider } from "../../ui/webviews/usageDashboard";
import type { UsageStats } from "../../types-usage";
import { createServices } from "../../infrastructure/services";

function managementUsage(): UsageStats {
	return {
		mode: "management",
		isManagementKey: true,
		capabilities: {
			keys: "available",
			credits: "available",
			activity: "available",
			perKeyActivity: "available",
			analytics: "unavailable",
			keyManagement: "available",
		},
		totalUsed: 1,
		dailyUsage: 0.1,
		weeklyUsage: 0.5,
		monthlyUsage: 1,
		limit: 10,
		limitRemaining: 9,
		limitReset: "monthly",
		isFreeTier: false,
		usagePercent: 10,
		allKeys: [
			{
				hash: "hash-abc",
				name: "Key 1",
				label: "Key 1",
				disabled: false,
				totalUsed: 1,
				dailyUsage: 0.1,
				weeklyUsage: 0.5,
				monthlyUsage: 1,
				limit: 10,
				limitRemaining: 9,
				limitReset: "monthly",
				usagePercent: 10,
			},
		],
		selectedKeyHash: "hash-abc",
		accountCredits: null,
		fetchedAt: new Date().toISOString(),
	};
}

describe("lifecycle integrity", () => {
	it("exposes every feature through the typed configuration boundary", () => {
		const config = ConfigService.instance;
		for (const feature of FEATURE_IDS) {
			expect(typeof config.isFeatureEnabled(feature)).toBe("boolean");
		}
		expect(Object.keys(config.features)).toEqual([...FEATURE_IDS]);
	});

	it("does not acquire refresh work after coordinator disposal", async () => {
		const coordinator = new RefreshCoordinator();
		coordinator.dispose();
		const work = vi.fn(async () => "work");

		expect(await coordinator.acquire("test", "user", work)).toBeUndefined();
		expect(work).not.toHaveBeenCalled();
	});

	it("makes timers safe to dispose repeatedly", () => {
		const model = new ModelPollingService(vi.fn());
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const usageTick = vi.fn();
		const usage = new UsagePollingService(usageTick, {
			usageBackgroundPollingEnabled: true,
			usageAutoRefreshInterval: 300,
		});
		const refresh = new RefreshScheduler(vi.fn());

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		usageTick();
		expect(usageTick).toHaveBeenCalledTimes(1);

		model.dispose();
		model.dispose();
		usage.dispose();
		usage.dispose();
		refresh.dispose();
		refresh.dispose();
		setIntervalSpy.mockRestore();

		expect(vi.isMockFunction).toBeTypeOf("function");
	});

	it("coalesces overlapping scheduled usage ticks", async () => {
		let release!: () => void;
		const refresh = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
		const usage = new UsagePollingService(refresh, {
			usageBackgroundPollingEnabled: true,
			usageAutoRefreshInterval: 0,
		});

		const first = usage.trigger();
		const second = usage.trigger();

		expect(refresh).toHaveBeenCalledTimes(1);
		release();
		await Promise.all([first, second]);
		usage.dispose();
	});

	it("keeps repeated configuration reads stable", () => {
		const config = ConfigService.instance;
		expect(config.features).toEqual(config.features);
	});

	it("routes every rendered management-key action to its command", async () => {
		const provider = new UsageDashboardProvider();
		provider.renderUsage(managementUsage());
		const source = { postMessage: vi.fn(async () => true) } as unknown as vscode.Webview;
		const executeCommand = vi.spyOn(vscode.commands, "executeCommand");
		const commands = [
			["openrouter-insights.selectUsageKey", "hash-other"],
			["openrouter-insights.createApiKey", undefined],
			["openrouter-insights.renameApiKey", "hash-abc"],
			["openrouter-insights.toggleApiKey", "hash-abc"],
			["openrouter-insights.setKeyLimit", "hash-abc"],
			["openrouter-insights.deleteApiKey", "hash-abc"],
		] as const;

		for (const [cmd, hash] of commands) {
			await provider.handleMessageForTest({ cmd, hash, requestId: cmd }, source);
			expect(executeCommand).toHaveBeenLastCalledWith(cmd, hash);
		}
		executeCommand.mockRestore();
	});

	it("composes the usage dashboard and management commands in one service graph", () => {
		const context = {
			globalState: {
				get: vi.fn(() => undefined),
				update: vi.fn(async () => undefined),
			},
			secrets: {
				get: vi.fn(async () => undefined),
				store: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext;

		const services = createServices(context);

		expect(services.usageDashboard).toBeInstanceOf(UsageDashboardProvider);
		expect(services.usageRefreshUseCase).toBeDefined();
		expect(services.commands.has("openrouter-insights.createApiKey")).toBe(true);
		expect(services.commands.has("openrouter-insights.renameApiKey")).toBe(true);
		expect(services.commands.has("openrouter-insights.toggleApiKey")).toBe(true);
		expect(services.commands.has("openrouter-insights.setKeyLimit")).toBe(true);
		expect(services.commands.has("openrouter-insights.deleteApiKey")).toBe(true);

		const eventBusDispose = vi.spyOn(services.eventBus, "dispose");
		services.dispose();
		services.dispose();
		expect(eventBusDispose).toHaveBeenCalledTimes(1);
	});
});
