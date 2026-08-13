import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
	adaptKeyHash,
	adaptModelId,
	adaptNoArgs,
	adaptOptionalScalar,
	SetModelOverrideCommand,
} from "../../infrastructure/commands";
import { SelectUsageKeyCommand } from "../../infrastructure/usageCommands";
import { registerCommands } from "../../infrastructure/commandRegistrar";

describe("command argument adapters", () => {
	it("adaptNoArgs drops every positional argument", () => {
		expect(adaptNoArgs(["stray", 1, true])).toEqual([]);
		expect(adaptNoArgs([])).toEqual([]);
	});

	it("adaptModelId extracts a string model ID and coerces non-strings to undefined", () => {
		expect(adaptModelId(["openai/gpt-4o"])).toEqual(["openai/gpt-4o"]);
		expect(adaptModelId([42])).toEqual([undefined]);
		expect(adaptModelId([])).toEqual([undefined]);
	});

	it("adaptKeyHash extracts a string key hash and coerces non-strings to undefined", () => {
		expect(adaptKeyHash(["abc123"])).toEqual(["abc123"]);
		expect(adaptKeyHash([{}])).toEqual([undefined]);
	});

	it("adaptOptionalScalar preserves string or boolean scalars only", () => {
		expect(adaptOptionalScalar([true])).toEqual([true]);
		expect(adaptOptionalScalar(["x"])).toEqual(["x"]);
		expect(adaptOptionalScalar([null])).toEqual([undefined]);
	});
});

describe("command contract preservation through registration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("binds the typed adapter to each command descriptor", () => {
		const cache = { get: () => undefined } as any;
		const picker = { discoverConfiguredModelIds: vi.fn() } as any;
		expect(new SetModelOverrideCommand(cache, picker).argAdapter).toBe(adaptNoArgs);
		expect(new SelectUsageKeyCommand(vi.fn()).argAdapter).toBe(adaptKeyHash);
	});

	it("routes raw VS Code args through the adapter before invoking the typed command", async () => {
		const handlers = new Map<string, (..._args: unknown[]) => unknown>();
		vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
			(id: string, cb: (..._args: unknown[]) => unknown) => {
				handlers.set(id, cb);
				return { dispose: () => {} };
			},
		);

		const doRefreshWithKey = vi.fn(async () => {});
		const setModelOverride = new SetModelOverrideCommand(
			{ get: () => undefined } as any,
			{ discoverConfiguredModelIds: vi.fn(), showModelSwitcher: vi.fn() } as any,
		);
		const commands = new Map<string, any>([
			["openrouter-insights.selectUsageKey", new SelectUsageKeyCommand(doRefreshWithKey)],
			["openrouter-insights.setModelOverride", setModelOverride],
		]);
		const svc = {
			commands,
			features: { shouldRegisterCommand: () => true },
			diagnostics: { recordFailure: vi.fn() },
		};
		registerCommands({} as any, svc as any);

		// SelectUsageKey: a string key hash is normalized and forwarded.
		await handlers.get("openrouter-insights.selectUsageKey")!("key-hash-123");
		expect(doRefreshWithKey).toHaveBeenCalledWith("key-hash-123");

		// SelectUsageKey: a missing key hash must not trigger a refresh.
		doRefreshWithKey.mockClear();
		await handlers.get("openrouter-insights.selectUsageKey")!();
		expect(doRefreshWithKey).not.toHaveBeenCalled();

		// SetModelOverride is a no-argument command: stray args are dropped.
		await handlers.get("openrouter-insights.setModelOverride")!("stray");
		expect(setModelOverride.argAdapter).toBe(adaptNoArgs);
	});

	it("ignores disabled commands at the registration boundary", async () => {
		const handlers = new Map<string, (..._args: unknown[]) => unknown>();
		vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
			(id: string, cb: (..._args: unknown[]) => unknown) => {
				handlers.set(id, cb);
				return { dispose: () => {} };
			},
		);

		const doRefreshWithKey = vi.fn(async () => {});
		const commands = new Map<string, any>([
			["openrouter-insights.selectUsageKey", new SelectUsageKeyCommand(doRefreshWithKey)],
		]);
		const svc = {
			commands,
			features: { shouldRegisterCommand: () => false },
			diagnostics: { recordFailure: vi.fn() },
		};
		registerCommands({} as any, svc as any);

		await handlers.get("openrouter-insights.selectUsageKey")!("key-hash-123");
		expect(doRefreshWithKey).not.toHaveBeenCalled();
	});

	it("routes synchronous command execution failures through recovery", async () => {
		const handlers = new Map<string, (..._args: unknown[]) => unknown>();
		vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
			(id: string, cb: (..._args: unknown[]) => unknown) => {
				handlers.set(id, cb);
				return { dispose: () => {} };
			},
		);
		const diagnostics = { recordFailure: vi.fn() };
		const commands = new Map<string, any>([
			[
				"openrouter-insights.syncFailure",
				{
					id: "openrouter-insights.syncFailure",
					argAdapter: adaptNoArgs,
					execute: () => {
						throw new Error("sync failure");
					},
				},
			],
		]);
		const svc = {
			commands,
			features: { shouldRegisterCommand: () => true },
			diagnostics,
		};
		registerCommands({} as any, svc as any);

		await expect(handlers.get("openrouter-insights.syncFailure")!()).resolves.toBeUndefined();
		expect(diagnostics.recordFailure).toHaveBeenCalledWith("command", expect.any(Error));
	});
});
