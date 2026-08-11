/**
 * Shared refresh-observation helper — emits one consistent terminal event
 * model for scheduled and manual refresh operations so operators can tell
 * whether a quiet period meant no work, skipped work, or successful work.
 *
 * Wraps an async refresh operation, emits `started`, and on completion emits
 * `completed`, `failed`, `skipped`, or `cancelled` with the operation label,
 * an optional reason, a refresh id when available, and the measured duration.
 * `RefreshCoordinator` remains the source of supersession semantics; this
 * helper only normalizes the terminal event contract.
 */

import type { EventBus } from "./eventBus";

export type RefreshOutcome = "completed" | "failed" | "skipped" | "cancelled";

export interface RefreshObservationOptions {
	label: string;
	eventBus?: EventBus;
	refreshId?: number;
	/** Reason for skipped/cancelled outcomes (e.g. "window not focused"). */
	reason?: string;
}

/**
 * Run `work`, emitting a `refreshTerminal` started event up front and a
 * terminal event (completed/failed/skipped/cancelled) on resolution. Failures
 * are rethrown so the caller's existing error handling still applies.
 */
export async function observeRefresh<T>(
	options: RefreshObservationOptions,
	work: () => Promise<T>,
): Promise<T> {
	const { label, eventBus, refreshId } = options;
	eventBus?.emit("refreshTerminal", {
		label,
		outcome: "started",
		refreshId,
	});
	const startedAt = Date.now();
	try {
		const result = await work();
		eventBus?.emit("refreshTerminal", {
			label,
			outcome: "completed",
			refreshId,
			durationMs: Date.now() - startedAt,
		});
		return result;
	} catch (error) {
		const cancelled = (error as { cancelled?: boolean } | null)?.cancelled === true;
		eventBus?.emit("refreshTerminal", {
			label,
			outcome: cancelled ? "cancelled" : "failed",
			reason: options.reason ?? (error instanceof Error ? error.message : String(error)),
			refreshId,
			durationMs: Date.now() - startedAt,
		});
		throw error;
	}
}

/** Emit a terminal `skipped` event for work that was intentionally not run. */
export function emitRefreshSkipped(options: RefreshObservationOptions): void {
	options.eventBus?.emit("refreshTerminal", {
		label: options.label,
		outcome: "skipped",
		reason: options.reason,
		refreshId: options.refreshId,
	});
}
