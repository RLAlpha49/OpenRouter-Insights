import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveActiveModelFromCopilotState } from "../../models/stateDbReader";
import { getLastStateDbDiagnostic } from "../../models/stateDbReader";

const { readSingleMock } = vi.hoisted(() => ({ readSingleMock: vi.fn() }));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, statSync: vi.fn(), readFileSync: vi.fn() };
});

vi.mock("../../models/stateDbLocator", () => ({
	findStateDb: vi.fn(),
}));

vi.mock("../../models/sqliteReader", () => ({
	readItemTableValueWalAware: readSingleMock,
	readItemTableValuesWalAware: vi.fn((dbPath: string, keys: string[], snapshot?: Buffer) => {
		const values = new Map<string, string>();
		let diagnostic = "ok";
		for (const key of keys) {
			const result = readSingleMock(dbPath, key, snapshot);
			diagnostic = result.diagnostic;
			if (result.value !== undefined) values.set(key, result.value);
			if (diagnostic !== "ok" && diagnostic !== "no-match") break;
		}
		return { values, diagnostic };
	}),
	invalidateSchemaCache: vi.fn(),
	readSnapshotSignature: vi.fn((p: string) => {
		const stat = fs.statSync(p);
		let walPresent = false;
		try {
			fs.statSync(`${p}-wal`);
			walPresent = true;
		} catch {
			walPresent = false;
		}
		return {
			dbMtimeMs: stat.mtimeMs,
			dbSize: stat.size,
			walPresent,
			walMtimeMs: 0,
			walSize: 0,
		};
	}),
	sameSnapshotSignature: vi.fn((a, b) => {
		if (!a || !b) return false;
		return (
			a.dbMtimeMs === b.dbMtimeMs &&
			a.dbSize === b.dbSize &&
			a.walPresent === b.walPresent &&
			a.walMtimeMs === b.walMtimeMs &&
			a.walSize === b.walSize
		);
	}),
}));

import { findStateDb } from "../../models/stateDbLocator";
afterEach(() => {
	vi.clearAllMocks();
});

beforeEach(() => {
	readSingleMock.mockReturnValue({ diagnostic: "ok" });
});

describe("state database reader", () => {
	it("returns not-found when the locator finds no database", async () => {
		vi.mocked(findStateDb).mockReturnValue(undefined);

		expect(await resolveActiveModelFromCopilotState()).toEqual({ diagnostic: "not-found" });
	});

	it("resolves the panel model from a stable database snapshot", async () => {
		const dbPath = path.join(process.cwd(), "state.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1, size: 4 } as fs.Stats);
		vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("data"));
		readSingleMock.mockReturnValue({
			value: "openai/gpt-4o",
			diagnostic: "ok",
		});

		const result = await resolveActiveModelFromCopilotState();

		expect(result.diagnostic).toBe("ok");
		expect(result.model).toMatchObject({
			identifier: "openai/gpt-4o",
			vendor: "openai",
		});
	});

	it("does not log the local path or resolved model identifier", async () => {
		const dbPath = path.join(process.cwd(), "private-state.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1, size: 4 } as fs.Stats);
		vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("data"));
		readSingleMock.mockReturnValue({ value: "openai/private-model", diagnostic: "ok" });
		const messages: string[] = [];

		await resolveActiveModelFromCopilotState((message) => messages.push(message));

		const output = messages.join("\n");
		expect(output).not.toContain(dbPath);
		expect(output).not.toContain("openai/private-model");
		expect(output).toContain("state database located");
	});

	it("falls back to the recently used model when no panel model exists", async () => {
		const dbPath = path.join(process.cwd(), "state-recent.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 3, size: 4 } as fs.Stats);
		vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("data"));
		readSingleMock
			.mockReturnValueOnce({ value: undefined, diagnostic: "ok" })
			.mockReturnValueOnce({ value: '["anthropic/claude"]', diagnostic: "ok" });

		const result = await resolveActiveModelFromCopilotState();

		expect(result.model).toMatchObject({ identifier: "anthropic/claude", vendor: "anthropic" });
	});

	it("returns corrupt when the database reader throws", async () => {
		const dbPath = path.join(process.cwd(), "state.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2, size: 4 } as fs.Stats);
		vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("data"));
		readSingleMock.mockImplementation(() => {
			throw new Error("invalid database");
		});

		expect((await resolveActiveModelFromCopilotState()).diagnostic).toBe("corrupt");
	});

	it("updates the last diagnostic when stat fails", async () => {
		const dbPath = path.join(process.cwd(), "unreadable-state.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockImplementation(() => {
			throw new Error("database unavailable");
		});

		expect(await resolveActiveModelFromCopilotState()).toEqual({ diagnostic: "unreadable" });
		expect(getLastStateDbDiagnostic()).toBe("unreadable");
	});

	it("resets the previous failure when the database is no longer found", async () => {
		const dbPath = path.join(process.cwd(), "missing-after-failure.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockImplementation(() => {
			throw new Error("database unavailable");
		});
		await resolveActiveModelFromCopilotState();

		vi.mocked(findStateDb).mockReturnValue(undefined);

		expect(await resolveActiveModelFromCopilotState()).toEqual({ diagnostic: "not-found" });
		expect(getLastStateDbDiagnostic()).toBe("not-found");
	});

	it("does not publish a model from an incomplete WAL read", async () => {
		const dbPath = path.join(process.cwd(), "incomplete-state.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 10, size: 4 } as fs.Stats);
		vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("data"));
		readSingleMock.mockReturnValue({
			value: '{"model":"openai/gpt-4o"}',
			diagnostic: "wal-incomplete",
		});

		expect(await resolveActiveModelFromCopilotState()).toEqual({ diagnostic: "wal-incomplete" });
	});

	it("retries an unstable snapshot before publishing the resolved model", async () => {
		const dbPath = path.join(process.cwd(), "unstable-state.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 10, size: 4 } as fs.Stats);
		vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("data"));
		readSingleMock
			.mockReturnValueOnce({ diagnostic: "unstable-snapshot" })
			.mockReturnValueOnce({ value: "openai/gpt-4o", diagnostic: "ok" });

		const result = await resolveActiveModelFromCopilotState();

		expect(result.model?.identifier).toBe("openai/gpt-4o");
		expect(readSingleMock).toHaveBeenCalledTimes(3);
	});

	it("records a bounded state-db boundary diagnostic when a sink is attached", async () => {
		const { configureStateDbDiagnostics } = await import("../../models/stateDbReader");
		const { RuntimeDiagnostics } = await import("../../infrastructure/runtimeDiagnostics");
		const diagnostics = new RuntimeDiagnostics();
		configureStateDbDiagnostics(diagnostics);

		const dbPath = path.join(process.cwd(), "state.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockImplementation(() => {
			throw new Error("database unavailable");
		});

		expect(await resolveActiveModelFromCopilotState()).toEqual({ diagnostic: "unreadable" });

		const boundary = diagnostics.snapshot().boundary;
		expect(boundary.length).toBeGreaterThanOrEqual(1);
		expect(boundary[boundary.length - 1]).toMatchObject({
			kind: "state-db",
			operation: "resolve",
			diagnostic: "unreadable",
		});
	});
});
