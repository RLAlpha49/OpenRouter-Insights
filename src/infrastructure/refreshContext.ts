/**
 * RefreshContext — caller-owned cancellation and identity for refresh
 * cycles.
 *
 * A refresh context carries:
 *   - an AbortSignal composed from timeout, disposal, and supersession
 *   - a unique refresh ID (generation) used to suppress stale results
 *   - a reason (user / scheduled / config / activation)
 *   - an optional deadline epoch (ms)
 *
 * Cancellation is treated as non-error control flow: consumers check
 * `context.isCancelled` and stop early; late results whose refresh ID
 * is no longer current are discarded by the publisher.
 */

/** Why a refresh was started. */
export type RefreshReason = "activation" | "user" | "scheduled" | "config" | "poll";

export interface RefreshContext {
	/** Unique generation ID for this refresh cycle. */
	readonly refreshId: number;
	/** Composed abort signal (timeout, disposal, supersession). */
	readonly signal: AbortSignal;
	readonly reason: RefreshReason;
	/** Optional deadline epoch ms. */
	readonly deadlineEpochMs?: number;
	/** True when the refresh has been cancelled. */
	isCancelled(): boolean;
	/** Throw if cancelled — call at safe points to stop early. */
	throwIfCancelled(): void;
	/** Request cancellation (used by the coordinator on supersession). */
	abort(): void;
	/** Mark the refresh as failed without throwing through the use-case boundary. */
	markFailed(): void;
	/** Whether the refresh recorded a non-cancellation failure. */
	isFailed(): boolean;
}

/** Refresh metadata attached to request signals for transport correlation. */
export interface RefreshSignal extends AbortSignal {
	readonly refreshId?: number;
}

/** Incrementing generation counter shared across refreshes. */
let nextRefreshId = 1;

/** Create a new refresh context with an optional timeout. */
export function createRefreshContext(
	reason: RefreshReason,
	timeoutMs?: number,
	externalSignal?: AbortSignal,
): RefreshContext {
	const controller = new AbortController();
	const refreshId = nextRefreshId++;
	let failed = false;
	Object.defineProperty(controller.signal, "refreshId", {
		value: refreshId,
		enumerable: false,
	});

	if (timeoutMs !== undefined && timeoutMs > 0) {
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	}
	if (externalSignal) {
		externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	const deadlineEpochMs = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;

	const ctx: RefreshContext = {
		refreshId,
		signal: controller.signal,
		reason,
		deadlineEpochMs,
		isCancelled: () => controller.signal.aborted,
		throwIfCancelled: () => {
			if (controller.signal.aborted) {
				const err = new Error(`Refresh ${refreshId} cancelled (${reason})`);
				(err as Error & { cancelled?: boolean }).cancelled = true;
				throw err;
			}
		},
		abort: () => controller.abort(),
		markFailed: () => {
			failed = true;
		},
		isFailed: () => failed,
	};
	return ctx;
}

/** Wrap an async task so its result is only published when still current. */
export async function publishIfCurrent<T>(
	ctx: RefreshContext,
	currentId: () => number,
	task: () => Promise<T>,
): Promise<T | undefined> {
	const result = await task();
	if (ctx.isCancelled() || currentId() !== ctx.refreshId) {
		return undefined;
	}
	return result;
}
