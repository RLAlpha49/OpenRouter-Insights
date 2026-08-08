/**
 * StateDbReader — reads and parses Copilot's state.vscDB to extract
 * the currently active model.
 *
 * Uses a zero-dependency binary SQLite reader (sqliteReader.ts).
 * Depends on:
 *   - StateDbLocator (path discovery)
 *   - SqlModelParser (string parsing helpers)
 *   - ModelNameDeriver (display name derivation)
 *   - SqliteReader (binary SQLite file reader)
 */

import * as fs from "node:fs";
import { log, formatError } from "../infrastructure/logger";
import { findStateDb } from "./stateDbLocator";
import { parseModelIdentifier, parseRecentModel } from "./sqlModelParser";
import { deriveName } from "./modelNameDeriver";
import {
	readItemTableValueWalAware,
	invalidateSchemaCache,
	type SqliteReadDiagnostic,
} from "./sqliteReader";
import type { StateReaderLogger } from "./sqlModelParser";

export type { StateReaderLogger };

export interface ResolvedActiveModel {
	identifier: string;
	name: string;
	vendor: string;
	family: string;
}

/**
 * Typed resolution result that carries the optional model and the
 * database condition that produced it. Callers can
 * distinguish a valid "no selected model" from a corrupt, busy, or
 * unsupported database.
 */
export interface StateDbResolution {
	model?: ResolvedActiveModel;
	diagnostic: SqliteReadDiagnostic;
}

// ── Readiness tracking ─────────────────────────────────────────

/** Track whether the state DB read has ever permanently failed. */
let _lastDiagnostic: SqliteReadDiagnostic = "not-found";

export function getLastStateDbDiagnostic(): SqliteReadDiagnostic {
	return _lastDiagnostic;
}

/** Returns true when the reader has permanently failed. */
export function hasStateDbReadFailed(): boolean {
	return (
		_lastDiagnostic === "corrupt" ||
		_lastDiagnostic === "unsupported-schema" ||
		_lastDiagnostic === "unreadable"
	);
}

// ── Mtime + result caching ─────────────────────────────────────

let _lastMtimeMs = 0;
let _lastSize = 0;
let _lastResult: ResolvedActiveModel | undefined;
let _lastResultAt = 0;
/** Short TTL (15 s) keeps the parsed result alive across back-to-back triggers. */
const RESULT_CACHE_TTL_MS = 15_000;
const SNAPSHOT_RETRIES = 2;

function readStableFileState(
	dbPath: string,
): { buffer: Buffer; mtimeMs: number; size: number } | undefined {
	for (let attempt = 0; attempt < SNAPSHOT_RETRIES; attempt++) {
		try {
			const before = fs.statSync(dbPath);
			const buffer = fs.readFileSync(dbPath);
			const after = fs.statSync(dbPath);
			if (
				before.mtimeMs === after.mtimeMs &&
				before.size === after.size &&
				buffer.length === after.size
			) {
				return { buffer, mtimeMs: after.mtimeMs, size: after.size };
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

// ── Main read pipeline ─────────────────────────────────────────

/**
 * Read the active model from Copilot's state DB using the zero-dependency
 * binary SQLite reader.
 * Falls back through: panel model → recent model → undefined.
 *
 * Returns a typed resolution result carrying the optional model and the
 * database condition that produced it.
 */
export async function resolveActiveModelFromCopilotState(
	logger?: StateReaderLogger,
): Promise<StateDbResolution> {
	const dbPath = findStateDb();
	logger?.("[StateDbReader] dbPath=" + String(dbPath));
	if (!dbPath) {
		log.debug("StateDbReader: state.vscdb not found, returning undefined");
		return { diagnostic: "not-found" };
	}

	try {
		const stat = fs.statSync(dbPath);
		if (
			stat.mtimeMs === _lastMtimeMs &&
			stat.size === _lastSize &&
			Date.now() - _lastResultAt < RESULT_CACHE_TTL_MS
		) {
			logger?.("[StateDbReader] file unchanged + TTL still valid, returning cached result");
			return { model: _lastResult, diagnostic: _lastDiagnostic };
		}

		// File changed — invalidate schema cache
		if (stat.mtimeMs !== _lastMtimeMs || stat.size !== _lastSize) {
			invalidateSchemaCache();
		}

		_lastMtimeMs = stat.mtimeMs;
		_lastSize = stat.size;
	} catch (err) {
		const errMsg = formatError(err);
		logger?.(`[StateDbReader] failed to stat state.vscdb: ${errMsg}`);
		log.debug(`StateDbReader: failed to stat state.vscdb: ${errMsg}`);
		return { diagnostic: "unreadable" };
	}

	try {
		const snapshot = readStableFileState(dbPath);
		if (!snapshot) {
			_lastDiagnostic = "busy";
			logger?.("[StateDbReader] state.vscdb changed during read");
			return { diagnostic: "busy" };
		}

		// 1. Primary: currently selected model from the dropdown picker.
		// WAL-aware read merges the companion -wal file so the newest
		// committed value is observed even before a checkpoint.
		const panelResult = readItemTableValueWalAware(
			dbPath,
			"chat.currentLanguageModel.panel",
			snapshot.buffer,
		);
		_lastDiagnostic = panelResult.diagnostic;
		const panelRaw = panelResult.value;
		logger?.(`[StateDbReader] panel model raw = ${panelRaw ?? "undefined"}`);
		const panelId = parseModelIdentifier(panelRaw);
		logger?.(`[StateDbReader] panel model id = ${panelId ?? "undefined"}`);

		// 2. Fallback: most recently used model
		let recentId: string | undefined;
		if (!panelId) {
			const recentResult = readItemTableValueWalAware(
				dbPath,
				"chatModelRecentlyUsed",
				snapshot.buffer,
			);
			_lastDiagnostic = recentResult.diagnostic;
			const recentRaw = recentResult.value;
			recentId = parseRecentModel(recentRaw, logger);
		}
		logger?.(`[StateDbReader] recent model = ${recentId ?? (panelId ? "skipped" : "undefined")}`);

		const identifier = panelId ?? recentId;
		if (!identifier) {
			_lastResult = undefined;
			_lastResultAt = Date.now();
			return { diagnostic: _lastDiagnostic };
		}

		const result: ResolvedActiveModel = {
			identifier,
			name: deriveName(identifier),
			vendor: identifier.split("/")[0],
			family: "",
		};
		logger?.(`[StateDbReader] resolved -> ${JSON.stringify(result)}`);
		_lastResult = result;
		_lastResultAt = Date.now();
		return { model: result, diagnostic: "ok" };
	} catch (err) {
		const errMsg = formatError(err);
		logger?.(`[StateDbReader] error reading state DB: ${errMsg}`);
		log.warn(`StateDbReader: error reading state DB: ${errMsg}`);
		_lastDiagnostic = "corrupt";
		return { diagnostic: "corrupt" };
	}
}
