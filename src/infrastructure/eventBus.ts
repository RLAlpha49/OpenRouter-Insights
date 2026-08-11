/**
 * EventBus — lightweight typed event mediator for decoupled communication.
 *
 * Uses vscode.EventEmitter under the hood for lifecycle-safe event
 * subscription (disposables, no manual cleanup). Typed events ensure
 * compile-time safety for event payloads.
 *
 * Events:
 *   pricingRefreshed — emitted after a successful pricing data fetch + persist
 *   modelChanged     — emitted when the active Copilot model changes
 *   configChanged    — emitted when any openrouterInsights setting changes
 *   refreshStarted   — emitted when a refresh cycle begins
 *   refreshFailed    — emitted when a refresh cycle fails
 *
 * Usage:
 *   const bus = new EventBus();
 *   bus.on("pricingRefreshed", (data) => { ... });
 *   bus.emit("pricingRefreshed", cachedData);
 */

import * as vscode from "vscode";
import type { CachedPricingData } from "../types";

// ── Event payload types ────────────────────────────────────────

export interface EventMap {
	pricingRefreshed: CachedPricingData;
	modelChanged: { modelId: string | undefined; displayName: string | undefined };
	configChanged: void;
	refreshStarted: void;
	refreshFailed: {
		label?: "pricing" | "usage" | "statusBar";
		error: string;
		refreshId?: number;
		durationMs?: number;
	};
	/** Consistent terminal event for any scheduled or manual refresh operation. */
	refreshTerminal: {
		label: string;
		outcome: "started" | "completed" | "failed" | "skipped" | "cancelled";
		reason?: string;
		refreshId?: number;
		durationMs?: number;
	};
}

export type EventName = keyof EventMap;

// ── EventBus ───────────────────────────────────────────────────

export class EventBus implements vscode.Disposable {
	private readonly _emitters = new Map<EventName, vscode.EventEmitter<unknown>>();
	private readonly _subscriptions: vscode.Disposable[] = [];

	/** Subscribe to a typed event. Returns a disposable. */
	on<E extends EventName>(event: E, handler: (_payload: EventMap[E]) => void): vscode.Disposable {
		const emitter = this._getOrCreateEmitter(event);
		const sub = emitter.event(handler as (_e: unknown) => void);
		this._subscriptions.push(sub);
		return sub;
	}

	/** Emit a typed event to all subscribers. */
	emit<E extends EventName>(event: E, payload: EventMap[E]): void {
		const emitter = this._emitters.get(event);
		if (emitter) emitter.fire(payload);
	}

	private _getOrCreateEmitter<E extends EventName>(event: E): vscode.EventEmitter<EventMap[E]> {
		let emitter = this._emitters.get(event);
		if (!emitter) {
			emitter = new vscode.EventEmitter<EventMap[E]>();
			this._emitters.set(event, emitter);
			this._subscriptions.push(emitter);
		}
		return emitter as vscode.EventEmitter<EventMap[E]>;
	}

	dispose(): void {
		for (const sub of this._subscriptions) sub.dispose();
		this._subscriptions.length = 0;
		this._emitters.clear();
	}
}
