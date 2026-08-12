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
	readItemTableValuesWalAware,
	readSnapshotSignature,
	sameSnapshotSignature,
	invalidateSchemaCache,
	type SnapshotSignature,
	type SqliteReadDiagnostic,
} from "./sqliteReader";
import type { RuntimeDiagnostics } from "../infrastructure/runtimeDiagnostics";
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

const RESULT_CACHE_TTL_MS = 15_000;
const SNAPSHOT_RETRIES = 2;

/**
 * Whether a single-key read result is safe enough to keep probing for the
 * model id. `ok` and `no-match` are authoritative; `partial-scan` means the
 * key may simply live on a page the reader could not decode, so we fall back
 * to the recent-model key rather than giving up. `wal-incomplete`, `busy`,
 * `corrupt`, `unsupported-schema`, `not-found` and `unreadable` stop the
 * resolution because the snapshot itself is untrustworthy.
 */
function canContinueAfter(diagnostic: SqliteReadDiagnostic): boolean {
	return diagnostic === "ok" || diagnostic === "no-match" || diagnostic === "partial-scan";
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
	private _lastSignature: SnapshotSignature | undefined;
	private _lastResult: ResolvedActiveModel | undefined;
	private _lastResultAt = 0;

	constructor(private _diagnostics?: RuntimeDiagnostics) {}

	get lastDiagnostic(): SqliteReadDiagnostic {
		return this._lastDiagnostic;
	}

	/** Record a bounded state-DB boundary diagnostic (no model values logged). */
	private _record(diagnostic: SqliteReadDiagnostic, fallback?: string): void {
		this._diagnostics?.recordBoundary({
			kind: "state-db",
			operation: "resolve",
			diagnostic,
			fallback,
		});
	}

	/** Attach a runtime diagnostics sink after construction (module singleton). */
	setDiagnostics(diagnostics: RuntimeDiagnostics): void {
		this._diagnostics = diagnostics;
	}

	async resolve(logger?: StateReaderLogger): Promise<StateDbResolution> {
		for (let attempt = 0; attempt < SNAPSHOT_RETRIES; attempt++) {
			const result = await this._resolveOnce(logger);
			if (result.diagnostic !== "unstable-snapshot") return result;
		}

		this._lastDiagnostic = "busy";
		this._lastResult = undefined;
		this._lastResultAt = 0;
		this._record("busy");
		return { diagnostic: "busy" };
	}

	private async _resolveOnce(logger?: StateReaderLogger): Promise<StateDbResolution> {
		const dbPath = findStateDb();
		logger?.("[StateDbReader] dbPath=" + String(dbPath));
		if (!dbPath) {
			this._lastDiagnostic = "not-found";
			this._lastResult = undefined;
			this._lastResultAt = 0;
			this._lastSignature = undefined;
			log.debug("StateDbReader: state.vscdb not found, returning undefined");
			this._record("not-found");
			return { diagnostic: "not-found" };
		}

		let signature: SnapshotSignature;
		try {
			// The signature covers the main file and its companion WAL, so a
			// commit that only lands in the WAL still invalidates this cache.
			signature = readSnapshotSignature(dbPath);
			if (
				sameSnapshotSignature(this._lastSignature, signature) &&
				Date.now() - this._lastResultAt < RESULT_CACHE_TTL_MS
			) {
				logger?.(
					"[StateDbReader] file and WAL unchanged + TTL still valid, returning cached result",
				);
				return { model: this._lastResult, diagnostic: this._lastDiagnostic };
			}
			if (!sameSnapshotSignature(this._lastSignature, signature)) invalidateSchemaCache();
		} catch (err) {
			const errMsg = formatError(err);
			this._lastDiagnostic = "unreadable";
			this._lastResult = undefined;
			this._lastResultAt = 0;
			this._lastSignature = undefined;
			logger?.(`[StateDbReader] failed to stat state.vscdb: ${errMsg}`);
			log.debug(`StateDbReader: failed to stat state.vscdb: ${errMsg}`);
			this._record("unreadable");
			return { diagnostic: "unreadable" };
		}

		try {
			const snapshot = readStableFileState(dbPath);
			if (!snapshot) {
				this._lastDiagnostic = "busy";
				this._lastResult = undefined;
				this._lastResultAt = 0;
				logger?.("[StateDbReader] state.vscdb changed during read");
				this._record("busy");
				return { diagnostic: "busy" };
			}

			const valuesResult = readItemTableValuesWalAware(
				dbPath,
				["chat.currentLanguageModel.panel", "chatModelRecentlyUsed"],
				snapshot,
			);
			this._lastDiagnostic = valuesResult.diagnostic;
			const panelResult = {
				value: valuesResult.values.get("chat.currentLanguageModel.panel"),
				diagnostic: valuesResult.diagnostic,
			};
			const panelId = parseModelIdentifier(panelResult.value);
			logger?.(`[StateDbReader] panel model id = ${panelId ?? "undefined"}`);
			if (!canContinueAfter(panelResult.diagnostic)) {
				this._lastResult = undefined;
				this._lastResultAt = 0;
				this._record(panelResult.diagnostic);
				return { diagnostic: panelResult.diagnostic };
			}

			const recentId = panelId
				? undefined
				: parseRecentModel(valuesResult.values.get("chatModelRecentlyUsed"), logger);

			const identifier = panelId ?? recentId;
			let finalSignature: SnapshotSignature;
			try {
				finalSignature = readSnapshotSignature(dbPath);
			} catch {
				this._lastDiagnostic = "busy";
				this._lastResult = undefined;
				this._lastResultAt = 0;
				this._record("busy");
				return { diagnostic: "busy" };
			}
			if (!sameSnapshotSignature(signature, finalSignature)) {
				this._lastDiagnostic = "unstable-snapshot";
				this._lastResult = undefined;
				this._lastResultAt = 0;
				this._record("unstable-snapshot");
				return { diagnostic: "unstable-snapshot" };
			}
			this._lastSignature = finalSignature;

			if (!identifier) {
				this._lastResult = undefined;
				this._lastResultAt = Date.now();
				this._record(this._lastDiagnostic, "no-match");
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
			this._record(this._lastDiagnostic);
			return { model, diagnostic: this._lastDiagnostic };
		} catch (err) {
			const errMsg = formatError(err);
			this._lastDiagnostic = "corrupt";
			this._lastResult = undefined;
			this._lastResultAt = 0;
			logger?.(`[StateDbReader] error reading state DB: ${errMsg}`);
			log.warn(`StateDbReader: error reading state DB: ${errMsg}`);
			this._record("corrupt");
			return { diagnostic: "corrupt" };
		}
	}
}

const defaultReader = new StateDbReader();

/** Attach the process-wide runtime diagnostics sink used for boundary events. */
export function configureStateDbDiagnostics(diagnostics: RuntimeDiagnostics): void {
	defaultReader.setDiagnostics(diagnostics);
}

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
