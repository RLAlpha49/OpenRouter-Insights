import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate } from "../../extension";
import { createModelDetectors, resolveModelId } from "../../models/modelResolver";
import { ConfigService } from "../../infrastructure/config";
import { ExtensionRuntime } from "../../infrastructure/extensionRuntime";
import { RefreshScheduler } from "../../infrastructure/refreshScheduler";
import { ModelPollingService } from "../../infrastructure/modelPollingService";
import { UsagePollingService } from "../../infrastructure/usagePollingService";

vi.mock("../models/stateDbReader", () => ({
	resolveActiveModelFromCopilotState: vi.fn(async () => ({ model: undefined, diagnostic: "ok" })),
}));
import type { ModelPricingInfo } from "../../types";

function model(id: string): ModelPricingInfo {
	return {
		id,
		name: id,
		blendedRate: 1,
		contextLength: 1000,
		contextLengthFormatted: "1K",
		maxOutputLength: 100,
		isDeprecated: false,
		deprecationDate: "",
		isFree: false,
		discountToUser: 0,
		quantization: "",
		modality: "text",
		inputModalities: [],
		outputModalities: [],
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
	};
}

describe("extension activation", () => {
	it("activates with a minimal VS Code extension context", async () => {
		const context = {
			globalState: { get: vi.fn(), update: vi.fn(async () => {}) },
			secrets: { store: vi.fn(), get: vi.fn(async () => undefined), delete: vi.fn() },
			subscriptions: [],
			extensionPath: "C:/extension",
		} as any;
		await activate(context);
		expect(context.subscriptions.length).toBeGreaterThan(0);
		deactivate();
	});
});

describe("model resolution pipeline", () => {
	it("prefers an explicit configured model and maps Copilot identifiers", async () => {
		(vscode.workspace as any)._configValues = { "general.selectedModelId": "openai/gpt-4o" };
		ConfigService.instance.dispose();
		const lookup = new Map([["openai/gpt-4o", model("openai/gpt-4o")]]);
		const detectors = createModelDetectors(lookup);
		expect(await detectors[0].detect(lookup)).toMatchObject({ id: "openai/gpt-4o" });
		expect(await resolveModelId(lookup)).toMatchObject({ id: "openai/gpt-4o" });
	});

	it("returns no match when no detector can resolve a model", async () => {
		(vscode.workspace as any)._configValues = {
			"general.selectedModelId": "",
			"general.providerScope": "openrouterOnly",
		};
		ConfigService.instance.dispose();
		const lookup = new Map([["openai/gpt-4o", model("openai/gpt-4o")]]);
		await expect(resolveModelId(lookup)).resolves.toBeUndefined();
	});

	it("uses the Copilot state detector and fuzzy fallback branches", async () => {
		(vscode.workspace as any)._configValues = {
			"general.selectedModelId": "",
			"general.providerScope": "openrouterOnly",
		};
		ConfigService.instance.dispose();
		const lookup = new Map([["openai/gpt-4o", model("openai/gpt-4o")]]);
		const detectors = createModelDetectors(
			lookup,
			() => [...lookup.values()],
			() => new Map([["openai/gpt-4o", model("openai/gpt-4o")]]),
		);
		expect(
			await detectors[1].detect(lookup, {
				identifier: "openrouter/x/openai/gpt-4o",
				name: "GPT-4o",
				vendor: "openrouter",
				family: "gpt",
			}),
		).toMatchObject({ id: "openai/gpt-4o" });
		expect(
			await detectors[1].detect(lookup, {
				identifier: "other/model",
				name: "Other",
				vendor: "other",
				family: "other",
			}),
		).toBeUndefined();
		expect(
			await detectors[2].detect(lookup, {
				identifier: "openai/gpt-4o",
				name: "GPT-4o",
				vendor: "openrouter",
				family: "gpt",
			}),
		).toMatchObject({ id: "openai/gpt-4o" });
	});
});

describe("ExtensionRuntime lifecycle", () => {
	it("starts with a fresh cache and disposes twice", async () => {
		(vscode.workspace as any)._configValues = {
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": false,
		};
		ConfigService.instance.dispose();
		const services = {
			cache: { isStale: () => false, get: () => undefined, getLookup: () => new Map() },
			modelPicker: { warmConfiguredModelDiscovery: vi.fn() },
			statusBar: {
				setEnabled: vi.fn(),
				dispose: vi.fn(),
				showLoading: vi.fn(),
				clearLoading: vi.fn(),
			},
			statusBarUseCase: { execute: vi.fn(async () => {}), invalidateCache: vi.fn() },
			usageStatusBar: { setEnabled: vi.fn() },
			usageDashboard: {},
			secrets: { hasKey: vi.fn(async () => false) },
			eventBus: { emit: vi.fn() },
			refreshCoordinator: { dispose: vi.fn() },
			doRefresh: vi.fn(async () => {}),
			doUsageRefresh: vi.fn(async () => {}),
			commands: new Map(),
			features: { shouldRegisterCommand: () => true },
			dispose: vi.fn(),
		} as any;
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		await runtime.start();
		await runtime.start();
		runtime.dispose();
		runtime.dispose();
		expect(services.statusBarUseCase.execute).toHaveBeenCalled();
		expect(services.modelPicker.warmConfiguredModelDiscovery).toHaveBeenCalledOnce();
	});

	it("starts a stale cache and enables usage resources", async () => {
		(vscode.workspace as any)._configValues = {
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": true,
			"usage.showStatusBar": true,
		};
		ConfigService.instance.dispose();
		const services = {
			cache: { isStale: () => true, get: () => undefined, getLookup: () => new Map() },
			modelPicker: { warmConfiguredModelDiscovery: vi.fn() },
			statusBar: { setEnabled: vi.fn(), dispose: vi.fn() },
			usageStatusBar: { setEnabled: vi.fn() },
			usageDashboard: {},
			secrets: { hasKey: vi.fn(async () => true) },
			statusBarUseCase: { execute: vi.fn(async () => {}), invalidateCache: vi.fn() },
			usageRefreshUseCase: { loadDetails: vi.fn(async () => {}) },
			eventBus: { emit: vi.fn() },
			refreshCoordinator: { dispose: vi.fn() },
			doRefresh: vi.fn(async () => {}),
			doUsageRefresh: vi.fn(async () => {}),
			commands: new Map(),
			features: { shouldRegisterCommand: () => true },
			dispose: vi.fn(),
		} as any;
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		await runtime.start();
		runtime.dispose();
		expect(services.doRefresh).toHaveBeenCalled();
		expect((vscode.commands as any).executeCommand).toBeDefined();
	});

	it("enables resources and reports real refresh failures", async () => {
		(vscode.workspace as any)._configValues = {
			"features.statusBar.enabled": true,
			"features.hoverProvider.enabled": true,
			"features.usage.enabled": true,
			"statusBar.show": false,
			"usage.showStatusBar": false,
		};
		ConfigService.instance.dispose();
		const services = {
			cache: {
				isStale: () => true,
				get: () => undefined,
				getLookup: () => new Map(),
				getValues: () => [],
				age: () => "fresh",
			},
			modelPicker: { warmConfiguredModelDiscovery: vi.fn() },
			statusBar: { setEnabled: vi.fn(), dispose: vi.fn() },
			usageStatusBar: { setEnabled: vi.fn() },
			usageDashboard: {},
			secrets: { hasKey: vi.fn(async () => false) },
			statusBarUseCase: { execute: vi.fn(async () => {}), invalidateCache: vi.fn() },
			usageRefreshUseCase: { loadDetails: vi.fn(async () => {}) },
			eventBus: { emit: vi.fn() },
			refreshCoordinator: { dispose: vi.fn() },
			doRefresh: vi.fn(async () => {
				throw new Error("refresh failed");
			}),
			doUsageRefresh: vi.fn(async () => {}),
			commands: new Map(),
			features: { shouldRegisterCommand: () => true },
			dispose: vi.fn(),
		} as any;
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		await runtime.start();
		await Promise.resolve();
		await Promise.resolve();
		expect(services.statusBar.setEnabled).toHaveBeenCalledWith(false);
		expect(services.eventBus.emit).toHaveBeenCalledWith(
			"refreshFailed",
			expect.objectContaining({ error: "refresh failed" }),
		);
		runtime.dispose();
	});

	it("ignores refresh failures after disposal", async () => {
		(vscode.workspace as any)._configValues = {
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": false,
		};
		ConfigService.instance.dispose();
		const services = {
			cache: { isStale: () => true, get: () => undefined, getLookup: () => new Map() },
			modelPicker: { warmConfiguredModelDiscovery: vi.fn() },
			statusBar: { setEnabled: vi.fn(), dispose: vi.fn() },
			usageStatusBar: { setEnabled: vi.fn() },
			usageDashboard: {},
			secrets: { hasKey: vi.fn(async () => false) },
			statusBarUseCase: { execute: vi.fn(async () => {}), invalidateCache: vi.fn() },
			eventBus: { emit: vi.fn() },
			refreshCoordinator: { dispose: vi.fn() },
			doRefresh: vi.fn(async () => {
				throw { cancelled: true };
			}),
			doUsageRefresh: vi.fn(async () => {}),
			commands: new Map(),
			features: { shouldRegisterCommand: () => true },
			dispose: vi.fn(),
		} as any;
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		runtime.dispose();
		await runtime.start();
		expect(services.eventBus.emit).not.toHaveBeenCalledWith("refreshFailed", expect.anything());
	});
});

describe("ExtensionRuntime feature reconciliation", () => {
	function baseServices() {
		return {
			cache: {
				isStale: () => false,
				get: () => undefined,
				getLookup: () => new Map(),
				getValues: () => [],
				age: () => "fresh",
				set: vi.fn(),
			},
			modelPicker: { warmConfiguredModelDiscovery: vi.fn(), invalidateSortCache: vi.fn() },
			statusBar: {
				setEnabled: vi.fn(),
				dispose: vi.fn(),
				showLoading: vi.fn(),
				clearLoading: vi.fn(),
			},
			statusBarUseCase: { execute: vi.fn(async () => {}), invalidateCache: vi.fn() },
			usageStatusBar: { setEnabled: vi.fn() },
			usageDashboard: {},
			usageRefreshUseCase: { loadDetails: vi.fn(async () => {}) },
			secrets: { hasKey: vi.fn(async () => false) },
			eventBus: { emit: vi.fn() },
			refreshCoordinator: { dispose: vi.fn() },
			doRefresh: vi.fn(async () => {}),
			doUsageRefresh: vi.fn(async () => {}),
			commands: new Map(),
			features: { shouldRegisterCommand: () => true },
			showLoading: vi.fn(),
			clearLoading: vi.fn(),
			diagnostics: { recordFailure: vi.fn(), recordSuccess: vi.fn() },
			dispose: vi.fn(),
		} as any;
	}

	function setConfig(values: Record<string, unknown>): void {
		(vscode.workspace as any)._configValues = values;
		ConfigService.instance.dispose();
	}

	function updateConfig(values: Record<string, unknown>): void {
		(vscode.workspace as any)._configValues = values;
		(ConfigService.instance as any)._cache?.clear();
	}

	it("waits for the initial pricing refresh before starting usage refresh", async () => {
		setConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": true,
			"usage.showDashboard": true,
			"usage.showStatusBar": false,
		});
		vi.spyOn(vscode.window, "registerWebviewViewProvider").mockImplementation(() => ({
			dispose: vi.fn(),
		}));
		let releasePricing: (() => void) | undefined;
		const pricingPending = new Promise<void>((resolve) => {
			releasePricing = resolve;
		});
		const services = baseServices();
		services.cache.isStale = () => true;
		services.doRefresh = vi.fn(() => pricingPending);
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();

		expect(services.doUsageRefresh).not.toHaveBeenCalled();
		const start = runtime.start();
		await vi.waitFor(() => expect(services.doRefresh).toHaveBeenCalledOnce());
		expect(services.doUsageRefresh).not.toHaveBeenCalled();

		releasePricing?.();
		await start;
		expect(services.doUsageRefresh).toHaveBeenCalledOnce();
		runtime.dispose();
	});

	it("registers and disposes the hover provider from the feature flag", () => {
		setConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": true,
			"features.usage.enabled": false,
		});
		const hoverDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
		vi.spyOn(vscode.languages, "registerHoverProvider").mockImplementation((_sel, provider) => {
			const disposable = { dispose: vi.fn() };
			hoverDisposables.push(disposable);
			(vscode.languages as any)._hoverProviders.push(provider);
			return disposable;
		});
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, baseServices());
		runtime.initialize();
		expect(hoverDisposables).toHaveLength(1);

		updateConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": false,
		});
		(runtime as any).reconcileFeature("hoverProvider");
		expect(hoverDisposables[0].dispose).toHaveBeenCalled();

		updateConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": true,
			"features.usage.enabled": false,
		});
		(runtime as any).reconcileFeature("hoverProvider");
		expect(hoverDisposables).toHaveLength(2);
		runtime.dispose();
	});

	it("toggles the status bar from the statusBar feature and display settings", () => {
		setConfig({
			"features.statusBar.enabled": true,
			"statusBar.show": true,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": false,
		});
		const services = baseServices();
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		expect(services.statusBar.setEnabled).toHaveBeenCalledWith(true);

		updateConfig({
			"features.statusBar.enabled": true,
			"statusBar.show": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": false,
		});
		(runtime as any).reconcileFeature("statusBar");
		expect(services.statusBar.setEnabled).toHaveBeenCalledWith(false);
		runtime.dispose();
	});

	it("registers and tears down usage resources with the usage feature", async () => {
		setConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": true,
			"usage.showStatusBar": true,
		});
		const webviewRegistrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
		vi.spyOn(vscode.window, "registerWebviewViewProvider").mockImplementation(() => {
			const disposable = { dispose: vi.fn() };
			webviewRegistrations.push(disposable);
			return disposable;
		});
		const services = baseServices();
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		await runtime.start();
		expect(webviewRegistrations).toHaveLength(1);
		expect(services.usageStatusBar.setEnabled).toHaveBeenCalledWith(true);
		expect(services.doUsageRefresh).toHaveBeenCalled();

		updateConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": false,
			"usage.showStatusBar": true,
		});
		(runtime as any).reconcileFeature("usage");
		expect(webviewRegistrations[0].dispose).toHaveBeenCalled();
		expect((runtime as any)._features.isActive("usage")).toBe(false);

		updateConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": true,
			"usage.showStatusBar": false,
		});
		(runtime as any).reconcileFeature("usage");
		expect(webviewRegistrations).toHaveLength(2);
		expect(services.usageStatusBar.setEnabled).toHaveBeenCalledWith(false);
		runtime.dispose();
	});

	it("starts the initial usage refresh when only the dashboard is enabled", async () => {
		setConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": true,
			"usage.showDashboard": true,
			"usage.showStatusBar": false,
		});
		vi.spyOn(vscode.window, "registerWebviewViewProvider").mockImplementation(() => ({
			dispose: vi.fn(),
		}));
		const services = baseServices();
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		await runtime.start();

		expect(services.usageStatusBar.setEnabled).toHaveBeenCalledWith(false);
		expect(services.doUsageRefresh).toHaveBeenCalled();
		runtime.dispose();
	});

	it("follows dashboard visibility without stopping usage polling", async () => {
		setConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": true,
			"usage.showDashboard": false,
			"usage.showStatusBar": true,
		});
		const webviewRegistrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
		vi.spyOn(vscode.window, "registerWebviewViewProvider").mockImplementation(() => {
			const disposable = { dispose: vi.fn() };
			webviewRegistrations.push(disposable);
			return disposable;
		});
		const services = baseServices();
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		await runtime.start();

		expect(webviewRegistrations).toHaveLength(0);
		expect(services.usageStatusBar.setEnabled).toHaveBeenCalledWith(true);
		expect(services.doUsageRefresh).toHaveBeenCalled();

		updateConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": true,
			"usage.showDashboard": true,
			"usage.showStatusBar": true,
		});
		(runtime as any).reconcileFeature("usage");
		expect(webviewRegistrations).toHaveLength(1);

		updateConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": true,
			"usage.showDashboard": false,
			"usage.showStatusBar": true,
		});
		(runtime as any).reconcileFeature("usage");
		expect(webviewRegistrations[0].dispose).toHaveBeenCalled();
		expect((runtime as any)._features.isActive("usage")).toBe(true);
		runtime.dispose();
	});

	it("records and surfaces background work failures through diagnostics", async () => {
		setConfig({
			"features.statusBar.enabled": false,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": false,
		});
		const services = baseServices();
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();

		(runtime as any).runInBackground("probe", async () => {
			throw new Error("background boom");
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(services.diagnostics.recordFailure).toHaveBeenCalledWith(
			"background",
			expect.any(Error),
		);
		expect(services.eventBus.emit).toHaveBeenCalledWith(
			"refreshFailed",
			expect.objectContaining({ error: "background boom" }),
		);
		runtime.dispose();
	});

	it("ignores reconcile work after disposal", async () => {
		setConfig({
			"features.statusBar.enabled": true,
			"statusBar.show": true,
			"features.hoverProvider.enabled": false,
			"features.usage.enabled": false,
		});
		const services = baseServices();
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		services.statusBar.setEnabled.mockClear();

		runtime.dispose();
		(runtime as any).reconcileFeature("statusBar");
		expect(services.statusBar.setEnabled).not.toHaveBeenCalled();

		(runtime as any).runInBackground("after-dispose", async () => {
			throw { cancelled: true };
		});
		await Promise.resolve();
		expect(services.eventBus.emit).not.toHaveBeenCalledWith("refreshFailed", expect.anything());
	});

	it("reacts to configuration changes by refreshing the affected areas", async () => {
		setConfig({
			"features.statusBar.enabled": true,
			"statusBar.show": true,
			"features.hoverProvider.enabled": true,
			"features.usage.enabled": true,
			"usage.showStatusBar": true,
			"general.autoRefreshInterval": 3600,
			"general.modelPollInterval": 600,
			"general.blendWeights": { prompt: 10, completion: 5, cacheRead: 80, cacheWrite: 5 },
		});
		const services = baseServices();
		services.cache.get = vi.fn(() => ({ models: [] }));
		const runtime = new ExtensionRuntime({ subscriptions: [] } as any, services);
		runtime.initialize();
		const listeners = (vscode.workspace as any)._createConfigListeners;
		const fire = (key: string) =>
			listeners.forEach(
				(listener: (_event: { affectsConfiguration: (_k: string) => boolean }) => void) =>
					listener({
						affectsConfiguration: (k) => k === "openrouterInsights" || k === key,
					}),
			);

		fire("openrouterInsights.general.autoRefreshInterval");
		fire("openrouterInsights.general.modelPollInterval");
		fire("openrouterInsights.statusBar");
		fire("openrouterInsights.usage.analytics.enabled");
		fire("openrouterInsights.general.blendWeights");

		await Promise.resolve();
		await Promise.resolve();

		expect(services.statusBarUseCase.invalidateCache).toHaveBeenCalled();
		expect(services.doUsageRefresh).toHaveBeenCalled();
		expect(services.usageRefreshUseCase.loadDetails).toHaveBeenCalled();
		expect(services.modelPicker.invalidateSortCache).toHaveBeenCalled();
		expect(services.cache.set).toHaveBeenCalled();
		runtime.dispose();
	});
});

describe("runtime-owned polling configuration", () => {
	it("accepts an injected configuration snapshot", () => {
		const config = {
			autoRefreshInterval: 0,
			modelPollInterval: 0,
			usageBackgroundPollingEnabled: false,
			usageAutoRefreshInterval: 0,
		} as any;
		const refresh = new RefreshScheduler(vi.fn(), config);
		const model = new ModelPollingService(vi.fn(), config);
		const usage = new UsagePollingService(vi.fn(), config);
		refresh.dispose();
		model.dispose();
		usage.dispose();
		expect(refresh).toBeInstanceOf(RefreshScheduler);
	});
});
