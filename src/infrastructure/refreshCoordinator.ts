/**
 * RefreshCoordinator — coordinates outbound API calls across use cases
 * with cancellation and stale-result suppression.
 *
 * Replaces global serialization with a small concurrency model:
 *   - a `latestId` generation counter — when a newer refresh starts,
 *     older in-flight refreshes are cancelled and cannot publish
 *   - each acquired refresh receives a RefreshContext with an AbortSignal
 *   - per-use-case promise coalescing remains in each use case; the
 *     coordinator adds supersession on top
 *
 * Usage:
 *   const coordinator = new RefreshCoordinator();
 *   await coordinator.acquire("pricing", async (ctx) => { ... });
 */

import { log } from "./logger";
import { createRefreshContext, type RefreshContext, type RefreshReason } from "./refreshContext";
import { RuntimeDiagnostics } from "./runtimeDiagnostics";
import { isCancellationError } from "../api/transport/fetchHelpers";

/** How long to wait for an in-flight refresh before superseding it (ms). */
const SUPERSEDE_WAIT_MS = 150;

export class RefreshCoordinator {
	readonly diagnostics: RuntimeDiagnostics;
	private _disposed = false;
	/** Generation counter — bumped on every acquire. */
	private _latestId = 0;
	/** Currently in-flight refresh (or undefined when idle). */
	private _pending: Promise<void> | undefined;
	private _pendingLabel: string | undefined;
	/** Context of the in-flight refresh (aborted on supersession). */
	private _pendingCtx: RefreshContext | undefined;

	constructor(diagnostics: RuntimeDiagnostics = new RuntimeDiagnostics()) {
		this.diagnostics = diagnostics;
	}

	/** Current generation ID — consumers compare against this to publish. */
	get latestId(): number {
		return this._latestId;
	}

	/**
	 * Acquire a refresh slot and run `fn` with a RefreshContext.
	 *
	 * If another refresh is in progress, this call waits a short grace
	 * period (SUPERSEDE_WAIT_MS) for it to finish; if it hasn't, the
	 * in-flight refresh is aborted and detached (superseded). Each
	 * acquire bumps the generation so obsolete results cannot publish.
	 *
	 * @param label  Human-readable label for logging
	 * @param reason Why this refresh was triggered
	 * @param fn     The async work; receives a RefreshContext
	 * @returns      The resolved value of `fn` (undefined when superseded)
	 */
	async acquire<T>(
		label: string,
		reason: RefreshReason,
		fn: (_ctx: RefreshContext) => Promise<T>,
	): Promise<T | undefined> {
		if (this._disposed) return undefined;
		if (this._pending && this._pendingLabel === label) {
			this.diagnostics.recordRefreshDeduplicated();
			return (await this._pending) as T;
		}
		// Supersede any in-flight refresh after a short grace period.
		if (this._pending) {
			log.info(`RefreshCoordinator: "${label}" waiting for in-flight "${this._pendingLabel}"`);
			const inFlight = this._pending;
			const settled = await Promise.race([
				inFlight.then(() => true),
				// After the grace period, abort the in-flight refresh.
				delay(SUPERSEDE_WAIT_MS).then(() => false),
			]);
			if (!settled) {
				log.info(`RefreshCoordinator: "${label}" superseding "${this._pendingLabel}"`);
				this._pendingCtx?.abort();
				// Detach the old refresh — do not block the new one on it.
				this._pending = undefined;
				this._pendingLabel = undefined;
				this._pendingCtx = undefined;
			}
		}

		const ctx = createRefreshContext(reason);
		const startedAt = Date.now();
		this._latestId = ctx.refreshId;
		this._pendingLabel = label;
		this._pendingCtx = ctx;
		this.diagnostics.recordRefreshStarted(label);

		log.info(`RefreshCoordinator: "${label}" acquired lock (id ${ctx.refreshId})`);

		const promise = fn(ctx);
		this._pending = promise
			.then(() => {
				let outcome = "success";
				if (ctx.isCancelled()) outcome = "cancelled";
				else if (ctx.isFailed()) outcome = "failure";
				if (outcome === "success") this.diagnostics.recordRefreshCompleted(label);
				else if (outcome === "cancelled") this.diagnostics.recordRefreshCancelled(label);
				else this.diagnostics.recordRefreshFailed(label);
				log.info(
					`RefreshCoordinator: "${label}" terminal outcome=${outcome} refresh=${ctx.refreshId} durationMs=${Date.now() - startedAt}`,
				);
			})
			.catch((err) => {
				const outcome = isCancellationError(err, ctx.signal) ? "cancelled" : "failure";
				if (outcome === "cancelled") this.diagnostics.recordRefreshCancelled(label);
				else this.diagnostics.recordRefreshFailed(label);
				log.info(
					`RefreshCoordinator: "${label}" terminal outcome=${outcome} refresh=${ctx.refreshId} durationMs=${Date.now() - startedAt}`,
				);
			});

		try {
			const result = await promise;
			// Only publish when this refresh is still the latest.
			if (ctx.isCancelled() || ctx.refreshId !== this._latestId) {
				log.debug(`RefreshCoordinator: "${label}" result discarded (superseded)`);
				return undefined;
			}
			return result;
		} finally {
			// Only clear state if we are still the tracked refresh.
			if (this._pendingCtx === ctx) {
				this._pending = undefined;
				this._pendingLabel = undefined;
				this._pendingCtx = undefined;
			}
		}
	}

	/** Cancel the active refresh and reject future acquisitions. */
	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		this._pendingCtx?.abort();
		this._pending = undefined;
		this._pendingLabel = undefined;
		this._pendingCtx = undefined;
		this._latestId++;
	}

	/** Whether a refresh is currently in progress. */
	get isInProgress(): boolean {
		return this._pending !== undefined;
	}
}

/** Promise-based delay helper. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
