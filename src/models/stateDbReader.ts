/**
 * Reads and parses Copilot's state.vscdb to extract the active model.
 *
 * The reader owns its cache and diagnostic state so model resolution does not
 * depend on hidden process-global lifecycle state.
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

export interface StateDbResolution {
	model?: ResolvedActiveModel;
	diagnostic: SqliteReadDiagnostic;
}

interface FileSignature {
	mtimeMs: number;
	size: number;
	walMtimeMs: number;
	walSize: number;
}

const RESULT_CACHE_TTL_MS = 15_000;
const SNAPSHOT_RETRIES = 2;

function sameSignature(a: FileSignature | undefined, b: FileSignature): boolean {
	if (!a) return false;
	return (
		a.mtimeMs === b.mtimeMs &&
		a.size === b.size &&
		a.walMtimeMs === b.walMtimeMs &&
		a.walSize === b.walSize
	);
}

function readFileSignature(dbPath: string): FileSignature {
	const stat = fs.statSync(dbPath);
	let walMtimeMs = 0;
	let walSize = 0;
	try {
		const walStat = fs.statSync(`${dbPath}-wal`);
		walMtimeMs = walStat.mtimeMs;
		walSize = walStat.size;
	} catch {
		// A missing WAL is a valid SQLite state.
	}
	return { mtimeMs: stat.mtimeMs, size: stat.size, walMtimeMs, walSize };
}

function readStableFileState(dbPath: string): Buffer | undefined {
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
				return buffer;
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export class StateDbReader {
	private _lastDiagnostic: SqliteReadDiagnostic = "not-found";
	private _lastSignature: FileSignature | undefined;
	private _lastResult: ResolvedActiveModel | undefined;
	private _lastResultAt = 0;

	get lastDiagnostic(): SqliteReadDiagnostic {
		return this._lastDiagnostic;
	}

	async resolve(logger?: StateReaderLogger): Promise<StateDbResolution> {
		const dbPath = findStateDb();
		logger?.("[StateDbReader] dbPath=" + String(dbPath));
		if (!dbPath) {
			this._lastDiagnostic = "not-found";
			this._lastResult = undefined;
			this._lastResultAt = 0;
			log.debug("StateDbReader: state.vscdb not found, returning undefined");
			return { diagnostic: "not-found" };
		}

		let signature: FileSignature;
		try {
			signature = readFileSignature(dbPath);
			if (
				sameSignature(this._lastSignature, signature) &&
				Date.now() - this._lastResultAt < RESULT_CACHE_TTL_MS
			) {
				logger?.(
					"[StateDbReader] file and WAL unchanged + TTL still valid, returning cached result",
				);
				return { model: this._lastResult, diagnostic: this._lastDiagnostic };
			}
			if (!sameSignature(this._lastSignature, signature)) invalidateSchemaCache();
			this._lastSignature = signature;
		} catch (err) {
			const errMsg = formatError(err);
			this._lastDiagnostic = "unreadable";
			this._lastResult = undefined;
			this._lastResultAt = 0;
			logger?.(`[StateDbReader] failed to stat state.vscdb: ${errMsg}`);
			log.debug(`StateDbReader: failed to stat state.vscdb: ${errMsg}`);
			return { diagnostic: "unreadable" };
		}

		try {
			const snapshot = readStableFileState(dbPath);
			if (!snapshot) {
				this._lastDiagnostic = "busy";
				this._lastResult = undefined;
				this._lastResultAt = 0;
				logger?.("[StateDbReader] state.vscdb changed during read");
				return { diagnostic: "busy" };
			}

			const panelResult = readItemTableValueWalAware(
				dbPath,
				"chat.currentLanguageModel.panel",
				snapshot,
			);
			this._lastDiagnostic = panelResult.diagnostic;
			const panelId = parseModelIdentifier(panelResult.value);
			logger?.(`[StateDbReader] panel model id = ${panelId ?? "undefined"}`);
			if (panelResult.diagnostic !== "ok" && panelResult.diagnostic !== "no-match") {
				this._lastResult = undefined;
				this._lastResultAt = 0;
				return { diagnostic: panelResult.diagnostic };
			}

			let recentId: string | undefined;
			if (!panelId) {
				const recentResult = readItemTableValueWalAware(dbPath, "chatModelRecentlyUsed", snapshot);
				this._lastDiagnostic = recentResult.diagnostic;
				if (recentResult.diagnostic !== "ok" && recentResult.diagnostic !== "no-match") {
					this._lastResult = undefined;
					this._lastResultAt = 0;
					return { diagnostic: recentResult.diagnostic };
				}
				recentId = parseRecentModel(recentResult.value, logger);
			}

			const identifier = panelId ?? recentId;
			if (!identifier) {
				this._lastResult = undefined;
				this._lastResultAt = Date.now();
				return { diagnostic: this._lastDiagnostic };
			}

			const model: ResolvedActiveModel = {
				identifier,
				name: deriveName(identifier),
				vendor: identifier.split("/")[0],
				family: "",
			};
			this._lastResult = model;
			this._lastResultAt = Date.now();
			return { model, diagnostic: this._lastDiagnostic };
		} catch (err) {
			const errMsg = formatError(err);
			this._lastDiagnostic = "corrupt";
			this._lastResult = undefined;
			this._lastResultAt = 0;
			logger?.(`[StateDbReader] error reading state DB: ${errMsg}`);
			log.warn(`StateDbReader: error reading state DB: ${errMsg}`);
			return { diagnostic: "corrupt" };
		}
	}
}

const defaultReader = new StateDbReader();

export async function resolveActiveModelFromCopilotState(
	logger?: StateReaderLogger,
): Promise<StateDbResolution> {
	return defaultReader.resolve(logger);
}

export function getLastStateDbDiagnostic(): SqliteReadDiagnostic {
	return defaultReader.lastDiagnostic;
}

export function hasStateDbReadFailed(): boolean {
	const diagnostic = defaultReader.lastDiagnostic;
	return (
		diagnostic === "corrupt" || diagnostic === "unsupported-schema" || diagnostic === "unreadable"
	);
}
