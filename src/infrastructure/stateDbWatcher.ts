/**
 * StateDbWatcher — watches Copilot's state.vscdb for model changes.
 * Debounces rapid changes and only fires when the model ID actually differs.
 *
 * Uses VS Code's cross-platform FileSystemWatcher (via
 * vscode.workspace.createFileSystemWatcher) with a RelativePattern to
 * avoid glob-escaping issues on Windows (backslashes in absolute paths
 * are interpreted as glob escape characters).
 *
 * A RelativePattern separates the base directory from the filename
 * pattern, so the watcher correctly monitors the file regardless of OS
 * path conventions.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import { log, formatError } from "./logger";
import { findStateDb } from "../models/stateDbLocator";
import { resolveActiveModelFromCopilotState } from "../models/stateDbReader";
import type { SqliteReadDiagnostic } from "../models/sqliteReader";

/** Diagnostics that indicate a persistent database problem worth surfacing. */
const PERSISTENT_DIAGNOSTICS: ReadonlySet<SqliteReadDiagnostic> = new Set([
	"corrupt",
	"unsupported-schema",
]);

/**
 * Create a file watcher for Copilot's state.vscdb and its WAL companion.
 * Debounces rapid triggers (500ms) and enforces a max frequency cap
 * (1 check per second) to prevent DoS from rapid file changes. Only
 * calls onChange when the model identifier differs from the last
 * known value.
 */
export function createStateDbWatcher(onChange: () => void): vscode.Disposable {
	const dbPath = findStateDb();
	if (!dbPath) {
		log.warn("createStateDbWatcher: state.vscdb not found");
		return new vscode.Disposable(() => {});
	}

	let lastModelId: string | undefined;
	let lastLoggedDiagnostic: SqliteReadDiagnostic | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let lastCheckTime = 0;
	let rapidChangeCount = 0;
	let disposed = false;

	const dbDir = path.dirname(dbPath);
	const dbFileName = path.basename(dbPath);
	const walFileName = `${dbFileName}-wal`;
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(dbDir, dbFileName),
		/* ignoreCreateEvents */ false,
		/* ignoreChangeEvents */ false,
		/* ignoreDeleteEvents */ false,
	);
	const walWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(dbDir, walFileName),
		/* ignoreCreateEvents */ false,
		/* ignoreChangeEvents */ false,
		/* ignoreDeleteEvents */ false,
	);

	const scheduleCheck = (_eventKind: string) => {
		if (disposed) return;
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(async () => {
			if (disposed) return;
			if (await shouldBackoff()) return;
			lastCheckTime = Date.now();
			try {
				if (disposed) return;
				const resolution = await resolveActiveModelFromCopilotState();
				logDiagnostic(resolution.diagnostic);
				if (resolution.diagnostic === "unstable-snapshot") return;
				const currentId = resolution.model?.identifier;
				if (currentId !== lastModelId) {
					lastModelId = currentId;
					log.info(
						"[stateDB watcher] model changed:",
						currentId ? `to "${currentId}"` : "to undefined",
					);
					onChange();
				}
			} catch (err) {
				log.error("[stateDB watcher] error:", formatError(err));
			}
		}, 500);
	};

	/** Enforce the max frequency cap with exponential backoff. Returns true when the check should be skipped. */
	const shouldBackoff = async (): Promise<boolean> => {
		const elapsed = Date.now() - lastCheckTime;
		const minInterval = 1000;
		if (elapsed >= minInterval) {
			rapidChangeCount = 0;
			return false;
		}
		rapidChangeCount++;
		if (rapidChangeCount <= 10) {
			return true;
		}
		const backoffMs = Math.min(1000 * Math.pow(2, rapidChangeCount - 10), 30_000);
		log.warn(
			`[stateDB watcher] ${rapidChangeCount} rapid changes — backing off ` +
				`${(backoffMs / 1000).toFixed(0)}s`,
		);
		await new Promise((r) => setTimeout(r, backoffMs));
		return disposed;
	};

	/** Surface bounded diagnostics for fallback conditions, suppressing duplicates. */
	const logDiagnostic = (diagnostic: SqliteReadDiagnostic): void => {
		if (diagnostic === "ok" || diagnostic === lastLoggedDiagnostic) return;
		lastLoggedDiagnostic = diagnostic;
		if (PERSISTENT_DIAGNOSTICS.has(diagnostic)) {
			log.warn(
				`[stateDB watcher] state.vscdb diagnostic: ${diagnostic} — ` +
					"model resolution will fall back to configured selection",
			);
		} else {
			log.debug(`[stateDB watcher] state.vscdb diagnostic: ${diagnostic}`);
		}
	};

	watcher.onDidChange(() => {
		scheduleCheck("change");
	});
	watcher.onDidCreate(() => {
		scheduleCheck("create");
	});
	watcher.onDidDelete(() => {
		scheduleCheck("delete");
	});
	walWatcher.onDidChange(() => {
		scheduleCheck("wal-change");
	});
	walWatcher.onDidCreate(() => {
		scheduleCheck("wal-create");
	});
	walWatcher.onDidDelete(() => {
		scheduleCheck("wal-delete");
	});

	log.info("createStateDbWatcher: watching", dbPath);

	return {
		dispose: () => {
			if (disposed) return;
			disposed = true;
			if (debounce) clearTimeout(debounce);
			watcher.dispose();
			walWatcher.dispose();
			log.info("createStateDbWatcher: disposed");
		},
	};
}
