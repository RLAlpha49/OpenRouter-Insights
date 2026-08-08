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

function normalizeApiKey(apiKey: string): string {
	const normalized = apiKey.trim();
	if (!API_KEY_PATTERN.test(normalized)) {
		throw new Error("Invalid OpenRouter API key");
	}
	return normalized;
}

export class SecretStorageService implements vscode.Disposable {
	private readonly _secrets: vscode.SecretStorage;

	constructor(context: vscode.ExtensionContext) {
		this._secrets = context.secrets;
	}

	dispose(): void {
		// SecretStorage is owned by ExtensionContext — nothing to clean up
	}

	/** Store an API key in the OS keychain. */
	async set(apiKey: string): Promise<void> {
		await this._secrets.store(SECRET_KEY, normalizeApiKey(apiKey));
	}

	/** Retrieve the API key from the OS keychain. Returns empty string if not set. */
	async get(): Promise<string> {
		return (await this._secrets.get(SECRET_KEY)) ?? "";
	}

	/** Remove the API key from the OS keychain. */
	async delete(): Promise<void> {
		await this._secrets.delete(SECRET_KEY);
	}

	/** Check whether an API key is present. */
	async hasKey(): Promise<boolean> {
		const key = await this.get();
		return key.length > 0;
	}
}
