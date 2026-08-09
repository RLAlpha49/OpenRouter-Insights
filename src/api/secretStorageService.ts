/**
 * SecretStorageService — manages OpenRouter API keys via VS Code's
 * SecretStorage API (OS keychain: Windows Credential Manager,
 * macOS Keychain, libsecret on Linux).
 *
 * Keys are never written to disk in plain text. This is the only
 * path through which the extension reads or writes API keys.
 */

import * as vscode from "vscode";

const SECRET_KEY = "openrouter-insights.apiKey";
const API_KEY_PATTERN = /^sk-or-v1-[A-Za-z0-9_-]{20,}$/;

/** Why the authenticated-derived-data cache was invalidated. */
export type CredentialChangeReason = "set" | "delete";

/**
 * Event published whenever the stored credential changes. The generation is a
 * monotonic, non-secret counter; it never contains the key material itself.
 */
export interface CredentialChangeEvent {
	readonly generation: number;
	readonly reason: CredentialChangeReason;
}

export type CredentialChangeCallback = (_event: CredentialChangeEvent) => void;

function normalizeApiKey(apiKey: string): string {
	const normalized = apiKey.trim();
	if (!API_KEY_PATTERN.test(normalized)) {
		throw new Error("Invalid OpenRouter API key");
	}
	return normalized;
}

export class SecretStorageService implements vscode.Disposable {
	private readonly _secrets: vscode.SecretStorage;
	private _generation = 0;
	private readonly _listeners = new Set<CredentialChangeCallback>();

	constructor(context: vscode.ExtensionContext) {
		this._secrets = context.secrets;
	}

	dispose(): void {
		this._listeners.clear();
	}

	/**
	 * Monotonic counter that advances on every set/delete. Cache owners key
	 * their entries on this value so derived data from a previous credential
	 * is never served after a rotation or removal. Only the counter — never
	 * the key — is held in memory.
	 */
	get credentialGeneration(): number {
		return this._generation;
	}

	/**
	 * Subscribe to credential changes. Returns a disposable that unsubscribes.
	 * The current generation is delivered immediately so late subscribers can
	 * align their caches without waiting for the next write.
	 */
	onCredentialChange(callback: CredentialChangeCallback): vscode.Disposable {
		this._listeners.add(callback);
		callback({ generation: this._generation, reason: "set" });
		return {
			dispose: () => {
				this._listeners.delete(callback);
			},
		};
	}

	/** Store an API key in the OS keychain. */
	async set(apiKey: string): Promise<void> {
		await this._secrets.store(SECRET_KEY, normalizeApiKey(apiKey));
		this._emitChange("set");
	}

	/** Retrieve the API key from the OS keychain. Returns empty string if not set. */
	async get(): Promise<string> {
		return (await this._secrets.get(SECRET_KEY)) ?? "";
	}

	/** Remove the API key from the OS keychain. */
	async delete(): Promise<void> {
		await this._secrets.delete(SECRET_KEY);
		this._emitChange("delete");
	}

	/** Check whether an API key is present. */
	async hasKey(): Promise<boolean> {
		const key = await this.get();
		return key.length > 0;
	}

	private _emitChange(reason: CredentialChangeReason): void {
		this._generation++;
		const event: CredentialChangeEvent = { generation: this._generation, reason };
		for (const listener of this._listeners) listener(event);
	}
}
