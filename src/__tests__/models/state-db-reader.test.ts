import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveActiveModelFromCopilotState } from "../../models/stateDbReader";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, statSync: vi.fn(), readFileSync: vi.fn() };
});

vi.mock("../../models/stateDbLocator", () => ({
	findStateDb: vi.fn(),
}));

vi.mock("../../models/sqliteReader", () => ({
	readItemTableValueWalAware: vi.fn(),
	invalidateSchemaCache: vi.fn(),
}));

import { findStateDb } from "../../models/stateDbLocator";
import { readItemTableValueWalAware } from "../../models/sqliteReader";

afterEach(() => {
	vi.clearAllMocks();
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
		vi.mocked(readItemTableValueWalAware).mockReturnValue({
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

	it("falls back to the recently used model when no panel model exists", async () => {
		const dbPath = path.join(process.cwd(), "state-recent.vscdb");
		vi.mocked(findStateDb).mockReturnValue(dbPath);
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 3, size: 4 } as fs.Stats);
		vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("data"));
		vi.mocked(readItemTableValueWalAware)
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
		vi.mocked(readItemTableValueWalAware).mockImplementation(() => {
			throw new Error("invalid database");
		});

		expect((await resolveActiveModelFromCopilotState()).diagnostic).toBe("corrupt");
	});
});
