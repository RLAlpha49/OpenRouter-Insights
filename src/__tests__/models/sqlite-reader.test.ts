/**
 * Unit tests for sqliteReader — WAL-aware reads, identity-aware schema
 * caching, and per-snapshot key indexing.
 *
 * Uses real SQLite databases built with node:sqlite (DatabaseSync) so the
 * binary format, WAL files, and checksums are exercised against genuine
 * SQLite output rather than hand-crafted fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	readItemTableValue,
	readItemTableValueDetailed,
	readItemTableValueWalAware,
	readSnapshotSignature,
	sameSnapshotSignature,
	invalidateSchemaCache,
} from "../../models/sqliteReader";

let tmpDir: string;

// WAL stress fixtures are substantially slower on Windows because each update
// creates a committed WAL frame and exercises filesystem durability.
const SQLITE_STRESS_TEST_TIMEOUT = 60_000;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-reader-test-"));
	invalidateSchemaCache();
});

afterEach(() => {
	invalidateSchemaCache();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a state.vscdb-style database with an ItemTable. */
function createStateDb(dbPath: string, rows: Array<[string, string]>): DatabaseSync {
	if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
	for (const [k, v] of rows) {
		db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(k, v);
	}
	return db;
}

describe("readItemTableValueDetailed", () => {
	it("reads a value from a main-file-only database", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db = createStateDb(dbPath, [
			["chat.currentLanguageModel.panel", '{"model":"openai/gpt-4o"}'],
			["chatModelRecentlyUsed", '{"model":"anthropic/claude"}'],
		]);
		db.close();

		const result = readItemTableValueDetailed(dbPath, "chat.currentLanguageModel.panel");
		expect(result.diagnostic).toBe("ok");
		expect(result.value).toBe('{"model":"openai/gpt-4o"}');
	});

	it("returns no-match for a missing key", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db = createStateDb(dbPath, [["k1", "v1"]]);
		db.close();

		const result = readItemTableValueDetailed(dbPath, "missing");
		expect(result.diagnostic).toBe("no-match");
		expect(result.value).toBeUndefined();
	});

	it("returns not-found when the file does not exist", () => {
		const result = readItemTableValueDetailed(path.join(tmpDir, "nope.vscdb"), "k");
		expect(result.diagnostic).toBe("not-found");
	});

	it("returns corrupt for a non-SQLite file", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		fs.writeFileSync(dbPath, "this is not a sqlite database at all");
		const result = readItemTableValueDetailed(dbPath, "k");
		expect(result.diagnostic).toBe("corrupt");
	});

	it("returns unsupported-schema when ItemTable is absent", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db = new DatabaseSync(dbPath);
		db.exec("CREATE TABLE OtherTable (k TEXT)");
		db.close();

		const result = readItemTableValueDetailed(dbPath, "k");
		expect(result.diagnostic).toBe("unsupported-schema");
	});
});

describe("readItemTableValueWalAware", () => {
	it("reads the newest committed value from the WAL before checkpoint", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db = createStateDb(dbPath, [
			["chat.currentLanguageModel.panel", '{"model":"openai/gpt-4o"}'],
		]);
		db.exec("PRAGMA journal_mode=WAL");
		// Update the value while the WAL is active — the newest committed
		// value lives only in the -wal file until a checkpoint.
		db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
			'{"model":"anthropic/claude-3-5-sonnet"}',
			"chat.currentLanguageModel.panel",
		);

		// The main file alone does NOT contain the newest value.
		const mainOnly = readItemTableValueDetailed(dbPath, "chat.currentLanguageModel.panel");
		expect(mainOnly.value).toBe('{"model":"openai/gpt-4o"}');

		// The WAL-aware read observes the newest committed value.
		const walAware = readItemTableValueWalAware(dbPath, "chat.currentLanguageModel.panel");
		expect(walAware.diagnostic).toBe("ok");
		expect(walAware.value).toBe('{"model":"anthropic/claude-3-5-sonnet"}');

		db.close();
	});

	it("falls back to the main file when no WAL exists", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db = createStateDb(dbPath, [["k1", "v1"]]);
		db.close();

		const result = readItemTableValueWalAware(dbPath, "k1");
		expect(result.diagnostic).toBe("ok");
		expect(result.value).toBe("v1");
	});

	it(
		"does not publish a value from a capped WAL snapshot as successful",
		() => {
			const dbPath = path.join(tmpDir, "state.vscdb");
			const db = createStateDb(dbPath, [["k1", "v1"]]);
			db.exec("PRAGMA journal_mode=WAL");
			db.exec("PRAGMA wal_autocheckpoint=0");
			const update = db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?");
			for (let index = 0; index < 4097; index++) {
				update.run(`v${index}`, "k1");
			}

			const result = readItemTableValueWalAware(dbPath, "k1");
			db.close();

			expect(result.diagnostic).toBe("wal-incomplete");
			expect(result.value).toBeUndefined();
		},
		SQLITE_STRESS_TEST_TIMEOUT,
	);

	it("returns wal-unreadable for a corrupt WAL file", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db = createStateDb(dbPath, [["k1", "v1"]]);
		db.exec("PRAGMA journal_mode=WAL");
		db.close();
		// Corrupt the WAL file after close (checkpoint may have removed it).
		const walPath = `${dbPath}-wal`;
		if (fs.existsSync(walPath)) {
			fs.writeFileSync(walPath, "garbage-not-a-wal");
			const result = readItemTableValueWalAware(dbPath, "k1");
			expect(result.diagnostic).toBe("wal-unreadable");
		}
	});
});

describe("identity-aware schema cache", () => {
	it("invalidates the cached schema when the file is replaced at the same path", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");

		// First database: ItemTable exists.
		const db1 = createStateDb(dbPath, [["k1", "v1"]]);
		db1.close();
		expect(readItemTableValue(dbPath, "k1")).toBe("v1");

		// Replace the file with a different database that has a different
		// schema (no ItemTable). The identity (content hash) changes, so the
		// cached root page must be invalidated.
		fs.rmSync(dbPath, { force: true });
		const db2 = new DatabaseSync(dbPath);
		db2.exec("CREATE TABLE OtherTable (k TEXT)");
		db2.close();

		const result = readItemTableValueDetailed(dbPath, "k1");
		expect(result.diagnostic).toBe("unsupported-schema");
	});

	it("re-reads the schema when the file content changes at the same path", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db1 = createStateDb(dbPath, [["k1", "v1"]]);
		db1.close();
		expect(readItemTableValue(dbPath, "k1")).toBe("v1");

		// Rewrite with a new ItemTable row set.
		const db2 = createStateDb(dbPath, [["k2", "v2"]]);
		db2.close();

		expect(readItemTableValue(dbPath, "k2")).toBe("v2");
		expect(readItemTableValue(dbPath, "k1")).toBeUndefined();
	});
});

describe("per-snapshot index", () => {
	it("resolves multiple keys from one snapshot without rescanning", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db = createStateDb(dbPath, [
			["chat.currentLanguageModel.panel", '{"model":"openai/gpt-4o"}'],
			["chatModelRecentlyUsed", '{"model":"anthropic/claude"}'],
		]);
		db.close();

		// Both lookups hit the same snapshot identity → one index build.
		expect(readItemTableValue(dbPath, "chat.currentLanguageModel.panel")).toBe(
			'{"model":"openai/gpt-4o"}',
		);
		expect(readItemTableValue(dbPath, "chatModelRecentlyUsed")).toBe(
			'{"model":"anthropic/claude"}',
		);
	});

	it("rebuilds the index when the snapshot changes", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db1 = createStateDb(dbPath, [["k1", "v1"]]);
		db1.close();
		expect(readItemTableValue(dbPath, "k1")).toBe("v1");

		const db2 = createStateDb(dbPath, [
			["k1", "v1-updated"],
			["k2", "v2"],
		]);
		db2.close();

		expect(readItemTableValue(dbPath, "k1")).toBe("v1-updated");
		expect(readItemTableValue(dbPath, "k2")).toBe("v2");
	});
});

describe("WAL-aware snapshot signature (DB-002)", () => {
	it("reports no WAL when only the main file exists", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		createStateDb(dbPath, [["k1", "v1"]]).close();
		const sig = readSnapshotSignature(dbPath);
		expect(sig.walPresent).toBe(false);
		expect(sig.walSize).toBe(0);
	});

	it("reports the WAL identity once it is present", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db = createStateDb(dbPath, [["k1", "v1"]]);
		db.exec("PRAGMA journal_mode=WAL");
		db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run("v2", "k1");
		const sig = readSnapshotSignature(dbPath);
		expect(sig.walPresent).toBe(true);
		expect(sig.walSize).toBeGreaterThan(0);
		db.close();
	});

	it("treats a WAL change as a different snapshot", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		const db = createStateDb(dbPath, [["k1", "v1"]]);
		db.exec("PRAGMA journal_mode=WAL");
		const before = readSnapshotSignature(dbPath);
		expect(sameSnapshotSignature(before, before)).toBe(true);

		db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run("v3", "k1");
		const after = readSnapshotSignature(dbPath);
		expect(sameSnapshotSignature(before, after)).toBe(false);
		db.close();
	});

	it("treats two absent WALs as the same signature", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		createStateDb(dbPath, [["k1", "v1"]]).close();
		const a = readSnapshotSignature(dbPath);
		const b = readSnapshotSignature(dbPath);
		expect(sameSnapshotSignature(a, b)).toBe(true);
	});
});

describe("partial B-tree scan surfacing (DB-003)", () => {
	it("reports a complete scan for a healthy database", () => {
		const dbPath = path.join(tmpDir, "state.vscdb");
		createStateDb(dbPath, [
			["chat.currentLanguageModel.panel", '{"model":"openai/gpt-4o"}'],
		]).close();

		const result = readItemTableValueDetailed(dbPath, "chat.currentLanguageModel.panel");
		expect(result.diagnostic).toBe("ok");
		expect(result.scan?.complete).toBe(true);
		expect(result.scan?.skippedPages).toBe(0);
		expect(result.scan?.invalidCellPointers).toBe(0);
	});

	it(
		"surfaces scan health alongside a capped WAL snapshot",
		() => {
			const dbPath = path.join(tmpDir, "state.vscdb");
			const db = createStateDb(dbPath, [["k1", "v1"]]);
			db.exec("PRAGMA journal_mode=WAL");
			db.exec("PRAGMA wal_autocheckpoint=0");
			const update = db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?");
			for (let index = 0; index < 4097; index++) {
				update.run(`v${index}`, "k1");
			}

			const result = readItemTableValueWalAware(dbPath, "k1");
			db.close();

			expect(result.diagnostic).toBe("wal-incomplete");
			expect(result.scan).toBeDefined();
		},
		SQLITE_STRESS_TEST_TIMEOUT,
	);

	it(
		"returns partial-scan (not no-match) when a leaf page is undecodable",
		() => {
			const dbPath = path.join(tmpDir, "state.vscdb");
			// Enough rows to force an interior root with multiple leaf pages.
			const rows: Array<[string, string]> = [];
			for (let i = 0; i < 1000; i++) rows.push([`key-${i}`, `value-${i}`]);
			createStateDb(dbPath, rows).close();

			// Zero page 2 (a leaf page) so the B-tree walk skips it. The main
			// file header (page 1, the schema root) stays intact so the database
			// still opens, but the scan is no longer complete.
			const buf = fs.readFileSync(dbPath);
			buf.fill(0, 4096, 8192);
			fs.writeFileSync(dbPath, buf);

			const result = readItemTableValueDetailed(dbPath, "definitely-missing-key");
			expect(result.diagnostic).toBe("partial-scan");
			expect(result.scan?.complete).toBe(false);
			expect(result.scan?.skippedPages).toBeGreaterThan(0);
		},
		SQLITE_STRESS_TEST_TIMEOUT,
	);
});
