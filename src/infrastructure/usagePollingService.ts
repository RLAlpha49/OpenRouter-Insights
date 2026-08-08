/**
 * UsagePollingService — encapsulates the usage refresh timer
 * extracted from extension.ts:activate().
 *
 * Schedules a periodic usage refresh via setInterval. When the
 * interval changes (config update), the timer is rescheduled.
 */

import * as vscode from "vscode";
import { ConfigService } from "./config";
import type { ReadonlyConfig } from "./config";
import { log } from "./logger";

export class UsagePollingService implements vscode.Disposable {
	private _timer: ReturnType<typeof setInterval> | undefined;
	private _disposed = false;

	constructor(
		private readonly _onTick: () => void,
		private readonly _config?: Pick<
			ReadonlyConfig,
			"usageBackgroundPollingEnabled" | "usageAutoRefreshInterval"
		>,
	) {
		this.schedule();
	}

	/** Recompute and reschedule the usage refresh timer from current config. */
	schedule(): void {
		if (this._disposed) return;
		if (this._timer) clearInterval(this._timer);
		const config = this._config ?? ConfigService.instance;
		if (!config.usageBackgroundPollingEnabled) {
			log.info("Usage refresh timer disabled (background polling is off)");
			return;
		}
		const interval = config.usageAutoRefreshInterval;
		if (interval > 0) {
			this._timer = setInterval(() => {
				if (!this._disposed) this._onTick();
			}, interval * 1000);
			log.info(`Usage refresh timer started: ${interval}s`);
		} else {
			log.info("Usage refresh timer disabled (interval=0)");
		}
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		if (this._timer) clearInterval(this._timer);
	}
}
