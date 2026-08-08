/**
 * StateDbLocator — discovers the filesystem path to Copilot's state.vscdb.
 *
 * Pure path resolution across Windows, macOS, and Linux. No I/O beyond
 * the accessSync check in findStateDb(). Separated from the reader so
 * path discovery can be tested independently (mock process.platform,
 * HOME, APPDATA, etc.).
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Discover the path to Copilot's state.vscdb across Windows, macOS, and Linux.
 *
 * VS Code's globalStorage lives under the per-user "data" folder:
 *   Windows : %APPDATA%/<app>/User/globalStorage/state.vscdb
 *   macOS   : ~/Library/Application Support/<app>/User/globalStorage/state.vscdb
 *   Linux   : $XDG_CONFIG_HOME/<app>/User/globalStorage/state.vscdb
 *             (falls back to ~/.config/<app>/…)
 *
 * <app> is "Code", "Code - Insiders", "Code - OSS", or "VSCodium".
 */
export function findStateDb(): string | undefined {
	const baseDirs = getStateDbBaseDirs();
	if (baseDirs.length === 0) return undefined;

	const isInsiders = vscode.env.appName.includes("Insiders");

	const appFolders = isInsiders
		? ["Code - Insiders", "Code", "Code - OSS", "VSCodium"]
		: ["Code", "Code - Insiders", "Code - OSS", "VSCodium"];

	for (const base of baseDirs) {
		for (const app of appFolders) {
			const p = path.join(base, app, "User", "globalStorage", "state.vscdb");
			try {
				fs.accessSync(p, fs.constants.R_OK);
				return p;
			} catch {
				// File doesn't exist or isn't readable — try the next candidate
			}
		}
	}
	return undefined;
}

/** Return platform-specific base directories where VS Code stores per-user data. */
export function getStateDbBaseDirs(): string[] {
	switch (process.platform) {
		case "win32": {
			const appData = process.env.APPDATA;
			return appData ? [appData] : [];
		}
		case "darwin": {
			const home = process.env.HOME;
			return home ? [path.join(home, "Library", "Application Support")] : [];
		}
		case "linux": {
			const dirs: string[] = [];
			const xdgConfig = process.env.XDG_CONFIG_HOME;
			if (xdgConfig) dirs.push(xdgConfig);
			const home = process.env.HOME;
			if (home) {
				const fallback = path.join(home, ".config");
				if (fallback !== xdgConfig) dirs.push(fallback);
			}
			return dirs;
		}
		default:
			return [];
	}
}
