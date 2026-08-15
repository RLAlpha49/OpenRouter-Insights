import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ModelPollingService } from "../../infrastructure/modelPollingService";
import { RefreshScheduler } from "../../infrastructure/refreshScheduler";
import { registerCommands } from "../../infrastructure/commandRegistrar";
import { FeatureRegistry } from "../../infrastructure/featureRegistry";
import { createServices } from "../../infrastructure/services";
import * as analyticsService from "../../api/clients/analyticsService";
import { RefreshCoordinator } from "../../infrastructure/refreshCoordinator";
import { RuntimeDiagnostics } from "../../infrastructure/runtimeDiagnostics";
import { RefreshUseCase } from "../../use-cases/refreshUseCase";
import { StatusBarUpdateUseCase } from "../../use-cases/statusBarUpdateUseCase";
import { UsageRefreshUseCase } from "../../use-cases/usageRefreshUseCase";
import { Logger, formatError, formatErrorBrief, initLogger } from "../../infrastructure/logger";
import { observeConfiguration } from "../../infrastructure/configurationObserver";
import { createStateDbWatcher } from "../../infrastructure/stateDbWatcher";
import * as stateDbLocator from "../../models/stateDbLocator";
import * as stateDbReader from "../../models/stateDbReader";

describe("polling and scheduling infrastructure", () => {
	it("coalesces focused model polling and skips unfocused ticks", () => {
		vi.useFakeTimers();
		const tick = vi.fn();
		const service = new ModelPollingService(tick);
		(vscode.window as any).state.focused = false;
		service.coalescedCheck();
		vi.advanceTimersByTime(1000);
		expect(tick).not.toHaveBeenCalled();
		(vscode.window as any).state.focused = true;
		service.coalescedCheck();
		vi.advanceTimersByTime(1000);
		expect(tick).toHaveBeenCalledOnce();
		service.schedule();
		service.dispose();
		service.dispose();
		vi.useRealTimers();
	});

	it("schedules refreshes and stops after disposal", () => {
		vi.useFakeTimers();
		const refresh = vi.fn();
		const scheduler = new RefreshScheduler(refresh);
		scheduler.schedule();
		vi.advanceTimersByTime(3600 * 1000);
		expect(refresh).toHaveBeenCalled();
		scheduler.dispose();
		const count = refresh.mock.calls.length;
		vi.advanceTimersByTime(3600 * 1000);
		expect(refresh).toHaveBeenCalledTimes(count);
		vi.useRealTimers();
	});
});

describe("FeatureRegistry and command registration", () => {
	it("reports enabled features and command registration eligibility", () => {
		const registry = new FeatureRegistry();
		expect(registry.isEnabled("usage")).toBe(true);
		expect(registry.shouldRegisterCommand("openrouter-insights.refreshPricing")).toBe(true);
		registry.dispose();
	});

	it("registers enabled commands and ignores disabled commands", () => {
		const callbacks = new Map<string, (..._args: unknown[]) => unknown>();
		(vscode.commands as any).registerCommand = vi.fn(
			(id: string, callback: (..._args: unknown[]) => unknown) => {
				callbacks.set(id, callback);
				return { dispose: () => callbacks.delete(id) };
			},
		);
		const command = { id: "openrouter-insights.refreshPricing", execute: vi.fn(async () => {}) };
		const svc = {
			commands: new Map([[command.id, command]]),
			features: { shouldRegisterCommand: () => true },
		} as any;
		const disposable = registerCommands({} as any, svc);
		callbacks.get(command.id)?.();
		expect(command.execute).toHaveBeenCalledOnce();
		disposable.dispose();
	});

	it("does not execute a command when its feature is disabled", () => {
		const callbacks = new Map<string, (..._args: unknown[]) => unknown>();
		(vscode.commands as any).registerCommand = vi.fn(
			(id: string, callback: (..._args: unknown[]) => unknown) => {
				callbacks.set(id, callback);
				return { dispose: () => callbacks.delete(id) };
			},
		);
		const command = { id: "openrouter-insights.refreshPricing", execute: vi.fn(async () => {}) };
		const svc = {
			commands: new Map([[command.id, command]]),
			features: { shouldRegisterCommand: () => false },
		} as any;
		const disposable = registerCommands({} as any, svc);

		callbacks.get(command.id)?.();

		expect(command.execute).not.toHaveBeenCalled();
		disposable.dispose();
	});

	it("passes command arguments through to enabled commands", async () => {
		const callbacks = new Map<string, (..._args: unknown[]) => unknown>();
		(vscode.commands as any).registerCommand = vi.fn(
			(id: string, callback: (..._args: unknown[]) => unknown) => {
				callbacks.set(id, callback);
				return { dispose: () => callbacks.delete(id) };
			},
		);
		const command = { id: "openrouter-insights.refreshPricing", execute: vi.fn(async () => {}) };
		const svc = {
			commands: new Map([[command.id, command]]),
			features: { shouldRegisterCommand: () => true },
		} as any;
		const disposable = registerCommands({} as any, svc);

		await callbacks.get(command.id)?.("model-id");

		expect(command.execute).toHaveBeenCalledWith("model-id");
		disposable.dispose();
	});

	it("captures rejected command execution as a bounded runtime failure", async () => {
		const callbacks = new Map<string, (..._args: unknown[]) => unknown>();
		(vscode.commands as any).registerCommand = vi.fn(
			(id: string, callback: (..._args: unknown[]) => unknown) => {
				callbacks.set(id, callback);
				return { dispose: () => callbacks.delete(id) };
			},
		);
		const command = {
			id: "openrouter-insights.refreshPricing",
			execute: vi.fn(async () => {
				throw new Error("Bearer secret-token failed");
			}),
		};
		const diagnostics = { recordFailure: vi.fn() };
		const svc = {
			commands: new Map([[command.id, command]]),
			features: { shouldRegisterCommand: () => true },
			diagnostics,
		} as any;
		const disposable = registerCommands({} as any, svc);

		await expect(callbacks.get(command.id)?.()).resolves.toBeUndefined();
		expect(diagnostics.recordFailure).toHaveBeenCalledWith("command", expect.any(Error));
		disposable.dispose();
	});

	it("captures synchronous command argument-adapter failures", async () => {
		const callbacks = new Map<string, (..._args: unknown[]) => unknown>();
		(vscode.commands as any).registerCommand = vi.fn(
			(id: string, callback: (..._args: unknown[]) => unknown) => {
				callbacks.set(id, callback);
				return { dispose: () => callbacks.delete(id) };
			},
		);
		const error = new Error("invalid command argument");
		const command = {
			id: "openrouter-insights.refreshPricing",
			execute: vi.fn(async () => {}),
			argAdapter: vi.fn(() => {
				throw error;
			}),
		};
		const diagnostics = { recordFailure: vi.fn() };
		const svc = {
			commands: new Map([[command.id, command]]),
			features: { shouldRegisterCommand: () => true },
			diagnostics,
		} as any;
		const disposable = registerCommands({} as any, svc);

		await expect(callbacks.get(command.id)?.()).resolves.toBeUndefined();
		expect(diagnostics.recordFailure).toHaveBeenCalledWith("command", error);
		expect(command.execute).not.toHaveBeenCalled();
		disposable.dispose();
	});
});

describe("service composition", () => {
	it("creates the activation service container and disposes owned resources", () => {
		const context = {
			globalState: { get: vi.fn(), update: vi.fn(async () => {}) },
			secrets: { store: vi.fn(), get: vi.fn(async () => undefined), delete: vi.fn() },
			subscriptions: [],
			extensionPath: "C:/extension",
		} as any;
		const services = createServices(context);
		expect(services.commands.size).toBeGreaterThan(20);
		expect(services.features.shouldRegisterCommand("openrouter-insights.refreshPricing")).toBe(
			true,
		);
		services.showLoading();
		services.clearLoading();
		services.dispose();
		services.dispose();
		expect(services.statusBar.dispose).toBeDefined();
	});

	it("executes the pricing and usage refresh orchestration", async () => {
		const acquireSpy = vi
			.spyOn(RefreshCoordinator.prototype, "acquire")
			.mockImplementation(async (_label, _reason, fn) => {
				const ctx = {
					isCancelled: () => false,
					isFailed: () => false,
					refreshId: 1,
					signal: { aborted: false },
					abort: vi.fn(),
				} as any;
				await fn(ctx);
				return undefined;
			});
		vi.spyOn(RefreshUseCase.prototype, "execute").mockResolvedValue(undefined as any);
		vi.spyOn(StatusBarUpdateUseCase.prototype, "execute").mockResolvedValue(undefined as any);
		vi.spyOn(UsageRefreshUseCase.prototype, "execute").mockResolvedValue(undefined as any);

		const context = {
			globalState: { get: vi.fn(), update: vi.fn(async () => {}) },
			secrets: { store: vi.fn(), get: vi.fn(async () => undefined), delete: vi.fn() },
			subscriptions: [],
			extensionPath: "C:/extension",
		} as any;

		try {
			const services = createServices(context);
			await services.doRefresh();
			await services.doUsageRefresh("user", "detailed");
			await services.doUsageRefresh("schedule", "summary");
			expect(acquireSpy).toHaveBeenCalledTimes(3);

			vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
			const openDashboard = services.commands.get("openrouter-insights.openUsageDashboard");
			await openDashboard?.execute();

			vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("sk-or-v1-" + "e".repeat(32));
			const setKey = services.commands.get("openrouter-insights.setApiKey");
			await setKey?.execute();

			services.dispose();
			services.dispose();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("shares the runtime diagnostics instance with refresh coordination", () => {
		const diagnostics = new RuntimeDiagnostics();
		const coordinator = new RefreshCoordinator(diagnostics);
		expect(coordinator.diagnostics).toBe(diagnostics);
		coordinator.dispose();
	});
});

describe("credential-change invalidation boundary", () => {
	it("clears authenticated derived data when the key is set or removed", async () => {
		const clearSpy = vi.spyOn(analyticsService, "clearAnalyticsCache");
		const generationSpy = vi.spyOn(analyticsService, "setCredentialGeneration");

		let stored: string | undefined;
		const context = {
			globalState: { get: vi.fn(), update: vi.fn(async () => {}) },
			secrets: {
				store: vi.fn(async (_k: string, value: string) => {
					stored = value;
				}),
				get: vi.fn(async () => stored),
				delete: vi.fn(async () => {
					stored = undefined;
				}),
			},
			subscriptions: [],
			extensionPath: "C:/extension",
		} as any;

		const services = createServices(context);
		clearSpy.mockClear();
		generationSpy.mockClear();

		await services.secrets.set("sk-or-v1-" + "e".repeat(32));
		expect(generationSpy).toHaveBeenCalledWith(1);
		expect(clearSpy).toHaveBeenCalled();

		await services.secrets.delete();
		expect(generationSpy).toHaveBeenCalledWith(2);
		expect(clearSpy).toHaveBeenCalledTimes(2);

		services.dispose();
		services.dispose();
		clearSpy.mockRestore();
		generationSpy.mockRestore();
	});
});

describe("Logger", () => {
	it("filters levels, formats errors, and initializes an output channel", () => {
		const output = { appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() };
		const logger = new Logger("test", output as any);
		logger.info("safe");
		logger.warn("warning");
		logger.error(new Error("failure"));
		logger.debug({ value: 1 });
		logger.for("child").info("child");
		expect(output.appendLine).toHaveBeenCalled();
		expect(formatError(new Error("failure"), false)).toBe("failure");
		expect(formatErrorBrief("failure")).toBe("failure");
		const context = { subscriptions: [] } as any;
		initLogger(context);
		expect(context.subscriptions).toHaveLength(1);
		logger.dispose();
	});
});

describe("configuration observer callbacks", () => {
	it("forwards typed configuration events and optional callbacks", () => {
		const handlers = {
			onRefreshIntervalChanged: vi.fn(),
			onDisplaySettingsChanged: vi.fn(),
			onPollIntervalChanged: vi.fn(),
			onUsageDataSettingsChanged: vi.fn(),
			onBlendWeightsChanged: vi.fn(),
		};
		const disposable = observeConfiguration(handlers);
		for (const listener of (vscode.workspace as any)._createConfigListeners) {
			listener({
				affectsConfiguration: (key: string) =>
					key === "openrouterInsights" || key.includes("autoRefreshInterval"),
			});
		}
		expect(handlers.onRefreshIntervalChanged).toHaveBeenCalled();
		disposable.dispose();
	});
});

describe("state database watcher", () => {
	it("returns a disposable when no state database is discoverable", () => {
		const watcher = createStateDbWatcher(vi.fn());
		watcher.dispose();
		expect(watcher).toHaveProperty("dispose");
	});

	it("debounces changes and only reports model identity changes", async () => {
		vi.useFakeTimers();
		const findStateDb = vi
			.spyOn(stateDbLocator, "findStateDb")
			.mockReturnValue("C:/state/state.vscdb");
		const resolveState = vi
			.spyOn(stateDbReader, "resolveActiveModelFromCopilotState")
			.mockResolvedValue({
				model: { identifier: "openai/gpt-4o", name: "GPT-4o", vendor: "openai", family: "" },
				diagnostic: "ok",
			});
		let onChange: (() => void) | undefined;
		let onCreate: (() => void) | undefined;
		let onDelete: (() => void) | undefined;
		const watcher = {
			onDidChange: (listener: () => void) => {
				onChange = listener;
				return { dispose: vi.fn() };
			},
			onDidCreate: (listener: () => void) => {
				onCreate = listener;
				return { dispose: vi.fn() };
			},
			onDidDelete: (listener: () => void) => {
				onDelete = listener;
				return { dispose: vi.fn() };
			},
			dispose: vi.fn(),
		};
		const createWatcher = vi
			.spyOn(vscode.workspace, "createFileSystemWatcher")
			.mockReturnValue(watcher as any);
		const changed = vi.fn();
		const disposable = createStateDbWatcher(changed);

		onChange?.();
		onCreate?.();
		onDelete?.();
		await vi.advanceTimersByTimeAsync(500);
		expect(resolveState).toHaveBeenCalledOnce();
		expect(changed).toHaveBeenCalledOnce();

		vi.advanceTimersByTime(1000);
		onChange?.();
		await vi.advanceTimersByTimeAsync(500);
		expect(changed).toHaveBeenCalledOnce();

		resolveState.mockResolvedValueOnce({
			model: { identifier: "anthropic/claude", name: "Claude", vendor: "anthropic", family: "" },
			diagnostic: "ok",
		});
		vi.advanceTimersByTime(1000);
		onChange?.();
		await vi.advanceTimersByTimeAsync(500);
		expect(changed).toHaveBeenCalledTimes(2);

		disposable.dispose();
		disposable.dispose();
		onChange?.();
		await vi.advanceTimersByTimeAsync(500);
		expect(watcher.dispose).toHaveBeenCalled();
		expect(createWatcher).toHaveBeenCalled();
		findStateDb.mockRestore();
		resolveState.mockRestore();
		createWatcher.mockRestore();
		vi.useRealTimers();
	});

	it("logs reader failures and backs off after rapid repeated changes", async () => {
		vi.useFakeTimers();
		vi.spyOn(stateDbLocator, "findStateDb").mockReturnValue("C:/state/state.vscdb");
		const resolveState = vi
			.spyOn(stateDbReader, "resolveActiveModelFromCopilotState")
			.mockRejectedValueOnce(new Error("temporary read failure"))
			.mockResolvedValue({ model: undefined, diagnostic: "busy" });
		let onChange: (() => void) | undefined;
		const watcher = {
			onDidChange: (listener: () => void) => {
				onChange = listener;
				return { dispose: vi.fn() };
			},
			onDidCreate: () => ({ dispose: vi.fn() }),
			onDidDelete: () => ({ dispose: vi.fn() }),
			dispose: vi.fn(),
		};
		const createWatcher = vi
			.spyOn(vscode.workspace, "createFileSystemWatcher")
			.mockReturnValue(watcher as any);
		const disposable = createStateDbWatcher(vi.fn());

		onChange?.();
		await vi.advanceTimersByTimeAsync(500);
		for (let i = 0; i < 11; i++) {
			onChange?.();
			await vi.advanceTimersByTimeAsync(500);
		}
		await vi.advanceTimersByTimeAsync(2500);
		expect(resolveState).toHaveBeenCalled();
		disposable.dispose();
		createWatcher.mockRestore();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("skips callbacks after disposal and handles diagnostic-only resolutions", async () => {
		vi.useFakeTimers();
		vi.spyOn(stateDbLocator, "findStateDb").mockReturnValue("C:/state/state.vscdb");
		const resolveState = vi
			.spyOn(stateDbReader, "resolveActiveModelFromCopilotState")
			.mockResolvedValue({ model: undefined, diagnostic: "corrupt" });
		let onChange: (() => void) | undefined;
		const watcher = {
			onDidChange: (listener: () => void) => {
				onChange = listener;
				return { dispose: vi.fn() };
			},
			onDidCreate: () => ({ dispose: vi.fn() }),
			onDidDelete: () => ({ dispose: vi.fn() }),
			dispose: vi.fn(),
		};
		vi.spyOn(vscode.workspace, "createFileSystemWatcher").mockReturnValue(watcher as any);
		const changed = vi.fn();
		const disposable = createStateDbWatcher(changed);
		disposable.dispose();
		onChange?.();
		await vi.advanceTimersByTimeAsync(1000);
		expect(resolveState).not.toHaveBeenCalled();
		expect(changed).not.toHaveBeenCalled();

		vi.restoreAllMocks();
		const secondWatcher = {
			onDidChange: (listener: () => void) => {
				onChange = listener;
				return { dispose: vi.fn() };
			},
			onDidCreate: () => ({ dispose: vi.fn() }),
			onDidDelete: () => ({ dispose: vi.fn() }),
			dispose: vi.fn(),
		};
		vi.spyOn(stateDbLocator, "findStateDb").mockReturnValue("C:/state/state.vscdb");
		vi.spyOn(stateDbReader, "resolveActiveModelFromCopilotState").mockResolvedValue({
			model: undefined,
			diagnostic: "not-found",
		});
		vi.spyOn(vscode.workspace, "createFileSystemWatcher").mockReturnValue(secondWatcher as any);
		const second = createStateDbWatcher(changed);
		onChange?.();
		await vi.advanceTimersByTimeAsync(500);
		expect(changed).not.toHaveBeenCalled();
		second.dispose();
		vi.useRealTimers();
	});
});
