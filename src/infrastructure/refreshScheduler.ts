/**
 * RefreshScheduler — manages the pricing refresh interval timer.
 * Handles schedule changes driven by configuration updates.
 *
 * Purely about interval management. Callers decide when to trigger an
 * immediate refresh (e.g., on activation when the cache is stale).
 */

import type { Disposable } from "vscode";
import { log } from "./logger";
import { getAutoRefreshInterval } from "./config";
import type { ReadonlyConfig } from "./config";

export class RefreshScheduler implements Disposable {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly _onRefresh: () => void;
	private disposed = false;

	constructor(
		onRefresh: () => void,
		private readonly _config?: Pick<ReadonlyConfig, "autoRefreshInterval">,
	) {
		this._onRefresh = onRefresh;
	}

	/** Start or restart the refresh timer using the current config interval. */
	schedule(): void {
		if (this.disposed) return;
		this.clear();
		const interval = this._config?.autoRefreshInterval ?? getAutoRefreshInterval();
		log.info("Auto-refresh interval set to", interval, "s");
		if (interval > 0) {
			this.timer = setInterval(() => {
				if (!this.disposed) this._onRefresh();
			}, interval * 1000);
		}
	}

	private clear(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clear();
	}
}
