/**
 * RuntimeDisposables — the explicit ownership record for resources created by
 * the composition root.
 *
 * Composition factories register what they create here instead of relying on a
 * hand-maintained `dispose()` body, so a new timer, view, or subscription is
 * released exactly once and in reverse creation order. Disposal is idempotent,
 * and anything registered after disposal is released immediately.
 */

import type * as vscode from "vscode";

export class RuntimeDisposables implements vscode.Disposable {
	private readonly _items: vscode.Disposable[] = [];
	private _disposed = false;

	/** Whether this store has already released its resources. */
	get isDisposed(): boolean {
		return this._disposed;
	}

	/** Number of resources currently owned by the store. */
	get size(): number {
		return this._items.length;
	}

	/** Take ownership of a resource and return it for direct use. */
	add<T extends vscode.Disposable>(resource: T): T {
		if (this._disposed) {
			resource.dispose();
			return resource;
		}
		this._items.push(resource);
		return resource;
	}

	/** Register cleanup work that has no disposable object of its own. */
	addCallback(cleanup: () => void): void {
		this.add({ dispose: cleanup });
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		for (const resource of [...this._items].reverse()) resource.dispose();
		this._items.length = 0;
	}
}
