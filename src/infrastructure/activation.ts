/**
 * ExtensionActivation — the single owner of activation-scoped resources.
 *
 * Activation produces one handle that holds the composed service graph and the
 * runtime. Disposal is ordered and idempotent: runtime registrations first,
 * then the service container (which releases the refresh coordinator, views,
 * secrets, and subscriptions in reverse creation order), then the
 * configuration singleton those services read from.
 *
 * Registering the handle in `context.subscriptions` and calling it again from
 * `deactivate()` are both safe, so no resource depends on which path the host
 * takes.
 */

import type * as vscode from "vscode";
import { ConfigService } from "./config";
import { ExtensionRuntime } from "./extensionRuntime";
import { createServices, type ServiceContainer } from "./services";

export class ExtensionActivation implements vscode.Disposable {
	private _disposed = false;

	readonly services: ServiceContainer;
	readonly runtime: ExtensionRuntime;

	private constructor(services: ServiceContainer, runtime: ExtensionRuntime) {
		this.services = services;
		this.runtime = runtime;
	}

	/**
	 * Compose the service graph and the runtime for one activation.
	 * If runtime construction fails, the partially created graph is released
	 * before the error propagates.
	 */
	static create(context: vscode.ExtensionContext): ExtensionActivation {
		const services = createServices(context);
		try {
			return new ExtensionActivation(services, new ExtensionRuntime(context, services));
		} catch (error) {
			services.dispose();
			ConfigService.instance.dispose();
			throw error;
		}
	}

	/** Run the initial refresh and context-key work for this activation. */
	async start(): Promise<void> {
		await this.runtime.start();
	}

	get isDisposed(): boolean {
		return this._disposed;
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		this.runtime.dispose();
		this.services.dispose();
		ConfigService.instance.dispose();
	}
}
