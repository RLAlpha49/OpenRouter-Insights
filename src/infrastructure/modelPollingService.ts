/**
 * ModelPollingService — encapsulates the model-status-bar poll timer
 * and coalesced debounce logic extracted from extension.ts:activate().
 *
 * Schedules a periodic check via setInterval. Each tick runs a
 * coalesced check: rapid events within 1s are debounced into a
 * single call, and the check is skipped when VS Code is not focused.
 */

import * as vscode from "vscode";
import { getModelPollInterval } from "./config";
import type { ReadonlyConfig } from "./config";
import { log } from "./logger";

export class ModelPollingService implements vscode.Disposable {
	private _coalesceTimer: ReturnType<typeof setTimeout> | undefined;
	private _pollTimer: ReturnType<typeof setInterval> | undefined;
	private _disposed = false;

	constructor(
		private readonly _onTick: () => void,
		private readonly _config?: Pick<ReadonlyConfig, "modelPollInterval">,
	) {
		this.schedule();
	}

	/** Recompute and reschedule the poll timer from current config. */
	schedule(): void {
		if (this._disposed) return;
		if (this._pollTimer) clearInterval(this._pollTimer);
		const interval = this._config?.modelPollInterval ?? getModelPollInterval();
		if (interval > 0) {
			this._pollTimer = setInterval(() => this._coalescedCheck(), interval * 1000);
			log.info(`Model poll timer started: ${interval}s`);
		} else {
			log.info("Model poll timer disabled (interval=0, relying on file watcher only)");
		}
	}

	/** Debounced check — coalesces rapid triggers into a single call. */
	private _coalescedCheck(): void {
		if (this._disposed) return;
		if (this._coalesceTimer) clearTimeout(this._coalesceTimer);
		this._coalesceTimer = setTimeout(() => {
			if (this._disposed) return;
			if (!vscode.window.state.focused) return;
			this._onTick();
		}, 1000);
	}

	/** Expose the coalesced check so the file watcher can trigger it directly. */
	coalescedCheck(): void {
		this._coalescedCheck();
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		if (this._pollTimer) clearInterval(this._pollTimer);
		if (this._coalesceTimer) clearTimeout(this._coalesceTimer);
	}
}
