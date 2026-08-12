import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createStateDbWatcher } from "../../infrastructure/stateDbWatcher";

vi.mock("../../models/stateDbLocator", () => ({
	findStateDb: vi.fn(),
}));
vi.mock("../../models/stateDbReader", () => ({
	resolveActiveModelFromCopilotState: vi.fn(),
}));

import { findStateDb } from "../../models/stateDbLocator";
import { resolveActiveModelFromCopilotState } from "../../models/stateDbReader";

type WatcherKind = "change" | "create" | "delete";

function makeFakeWatcher() {
	const listeners: Record<WatcherKind, Array<() => void>> = { change: [], create: [], delete: [] };
	return {
		onDidChange: (l: () => void) => {
			listeners.change.push(l);
			return { dispose: () => {} };
		},
		onDidCreate: (l: () => void) => {
			listeners.create.push(l);
			return { dispose: () => {} };
		},
		onDidDelete: (l: () => void) => {
			listeners.delete.push(l);
			return { dispose: () => {} };
		},
		dispose: vi.fn(),
		emit(kind: WatcherKind) {
			listeners[kind].forEach((l) => l());
		},
	};
}

function makeResolve(id: string, diagnostic: string = "ok") {
	return async () => ({ model: id ? { identifier: id } : undefined, diagnostic });
}

describe("state database watcher", () => {
	let watchers: ReturnType<typeof makeFakeWatcher>[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1000));
		watchers = [];
		(findStateDb as any).mockReturnValue("/state/state.vscdb");
		vi.spyOn(vscode.workspace, "createFileSystemWatcher").mockImplementation(() => {
			watchers.push(makeFakeWatcher());
			return watchers[watchers.length - 1] as unknown as vscode.FileSystemWatcher;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function trigger(kind: WatcherKind, advanceMs = 1500) {
		watchers[0].emit(kind);
		await vi.advanceTimersByTimeAsync(advanceMs);
	}

	it("returns a no-op disposable when the state database is missing", () => {
		(findStateDb as any).mockReturnValue(undefined);
		const onChange = vi.fn();
		const watcher = createStateDbWatcher(onChange);
		expect(watchers).toHaveLength(0);
		expect(() => watcher.dispose()).not.toThrow();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("fires onChange only when the resolved model identifier changes", async () => {
		const onChange = vi.fn();
		(resolveActiveModelFromCopilotState as any).mockImplementation(makeResolve("openai/gpt-4o"));
		createStateDbWatcher(onChange);

		await trigger("change");
		await trigger("change");
		expect(onChange).toHaveBeenCalledTimes(1);

		(resolveActiveModelFromCopilotState as any).mockImplementation(makeResolve("anthropic/claude"));
		await trigger("change");
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it("coalesces a burst of change events into a single model check", async () => {
		const onChange = vi.fn();
		(resolveActiveModelFromCopilotState as any).mockImplementation(makeResolve("openai/gpt-4o"));
		createStateDbWatcher(onChange);

		for (let i = 0; i < 5; i++) {
			watchers[0].emit("change");
			await vi.advanceTimersByTimeAsync(100);
		}
		await vi.advanceTimersByTimeAsync(1500);

		expect(resolveActiveModelFromCopilotState).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("enforces the max-frequency cap so rapid events skip intervening checks", async () => {
		const onChange = vi.fn();
		(resolveActiveModelFromCopilotState as any).mockImplementation(makeResolve("openai/gpt-4o"));
		createStateDbWatcher(onChange);

		await trigger("change");
		expect(resolveActiveModelFromCopilotState).toHaveBeenCalledTimes(1);

		for (let i = 0; i < 3; i++) {
			watchers[0].emit("change");
			await vi.advanceTimersByTimeAsync(200);
		}
		await vi.advanceTimersByTimeAsync(1500);

		expect(resolveActiveModelFromCopilotState).toHaveBeenCalledTimes(2);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("triggers from WAL companion events", async () => {
		const onChange = vi.fn();
		(resolveActiveModelFromCopilotState as any).mockImplementation(makeResolve("openai/gpt-4o"));
		createStateDbWatcher(onChange);

		await trigger("change");
		expect(onChange).toHaveBeenCalledTimes(1);
		watchers[1].emit("change");
		await vi.advanceTimersByTimeAsync(1500);
		expect(resolveActiveModelFromCopilotState).toHaveBeenCalledTimes(2);
	});

	it("surfaces persistent diagnostics without changing the model", async () => {
		const onChange = vi.fn();
		(resolveActiveModelFromCopilotState as any).mockImplementation(
			makeResolve("openai/gpt-4o", "corrupt"),
		);
		createStateDbWatcher(onChange);

		await trigger("change");

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(resolveActiveModelFromCopilotState).toHaveBeenCalled();
	});

	it("does not publish a model change for transient diagnostics", async () => {
		const onChange = vi.fn();
		(resolveActiveModelFromCopilotState as any).mockImplementation(
			makeResolve("", "unstable-snapshot"),
		);
		createStateDbWatcher(onChange);

		await trigger("change");

		expect(onChange).not.toHaveBeenCalled();
	});

	it("stops reacting and disposes both watchers after disposal", async () => {
		const onChange = vi.fn();
		(resolveActiveModelFromCopilotState as any).mockImplementation(makeResolve("openai/gpt-4o"));
		const watcher = createStateDbWatcher(onChange);

		await trigger("change");
		expect(onChange).toHaveBeenCalledTimes(1);

		watcher.dispose();
		expect(watchers[0].dispose).toHaveBeenCalled();
		expect(watchers[1].dispose).toHaveBeenCalled();

		watchers[0].emit("change");
		await vi.advanceTimersByTimeAsync(1500);
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});
