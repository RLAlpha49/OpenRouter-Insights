/**
 * FeatureReconciler — one lifecycle policy for every toggleable feature.
 *
 * Each feature declares an enabled predicate, an optional resource factory, an
 * optional configuration sync step, and optional activation/deactivation
 * hooks. The reconciler owns the resulting resource, so enable, disable, and
 * re-enable follow the same path for every feature instead of being spread
 * across per-feature callbacks.
 *
 * Reconciliation is idempotent: reconciling an active feature only re-applies
 * configuration, and reconciling a disabled feature releases its resource once.
 */

import * as vscode from "vscode";
import type { FeatureId } from "./config";

export interface FeatureLifecycle {
	/** Feature flag this lifecycle belongs to. */
	readonly id: FeatureId;
	/** Whether the feature should own resources right now. */
	isEnabled(): boolean;
	/** Create the resource held while the feature is active. */
	activate?(): vscode.Disposable | undefined;
	/** Apply current configuration to an already-active feature. */
	sync?(): void;
	/** Run once after a fresh activation and its first sync. */
	activated?(): void;
	/** Apply the disabled state; runs on every reconcile while disabled. */
	deactivated?(): void;
}

/**
 * A resource that exists only while a setting is on, without changing the
 * enablement of the feature that owns it (for example the dashboard view
 * registration inside the usage feature).
 */
export class ToggledResource implements vscode.Disposable {
	private _current: vscode.Disposable | undefined;

	constructor(private readonly _create: () => vscode.Disposable) {}

	get isActive(): boolean {
		return this._current !== undefined;
	}

	/** Create or release the resource so it matches `shouldExist`. */
	sync(shouldExist: boolean): void {
		if (shouldExist && !this._current) {
			this._current = this._create();
			return;
		}
		if (!shouldExist && this._current) {
			this._current.dispose();
			this._current = undefined;
		}
	}

	dispose(): void {
		this._current?.dispose();
		this._current = undefined;
	}
}

export class FeatureReconciler implements vscode.Disposable {
	private readonly _definitions: ReadonlyMap<FeatureId, FeatureLifecycle>;
	private readonly _resources = new Map<FeatureId, vscode.Disposable | undefined>();
	private _disposed = false;

	constructor(
		definitions: readonly FeatureLifecycle[],
		private readonly _onError?: (_feature: FeatureId, _error: unknown) => void,
	) {
		this._definitions = new Map(definitions.map((definition) => [definition.id, definition]));
	}

	/** Features managed by this reconciler, in declaration order. */
	get managedFeatures(): FeatureId[] {
		return [...this._definitions.keys()];
	}

	/** Whether the feature currently holds its activation resource. */
	isActive(feature: FeatureId): boolean {
		return this._resources.has(feature);
	}

	/** Converge every managed feature with current configuration. */
	reconcileAll(): void {
		for (const feature of this._definitions.keys()) this.reconcile(feature);
	}

	/** Converge one feature with current configuration. */
	reconcile(feature: FeatureId): void {
		if (this._disposed) return;
		const definition = this._definitions.get(feature);
		if (!definition) return;

		try {
			if (!definition.isEnabled()) {
				this._deactivate(definition);
				return;
			}
			if (this._resources.has(feature)) {
				definition.sync?.();
				return;
			}
			const resource = definition.activate?.();
			this._resources.set(feature, resource);
			try {
				definition.sync?.();
				definition.activated?.();
			} catch (error) {
				this._resources.delete(feature);
				resource?.dispose();
				throw error;
			}
		} catch (error) {
			this._onError?.(feature, error);
		}
	}

	private _deactivate(definition: FeatureLifecycle): void {
		if (this._resources.has(definition.id)) {
			this._resources.get(definition.id)?.dispose();
			this._resources.delete(definition.id);
		}
		definition.deactivated?.();
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		for (const resource of [...this._resources.values()].reverse()) resource?.dispose();
		this._resources.clear();
	}
}
