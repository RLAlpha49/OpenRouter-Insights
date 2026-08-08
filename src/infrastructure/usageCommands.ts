/**
 * Usage commands — VS Code commands for the OpenRouter usage/credits feature.
 *
 * Includes: API key management (create/rename/toggle/delete/limit),
 * usage refresh, and key selection for the dashboard.
 */

import * as vscode from "vscode";
import { type ICommand, adaptKeyHash, adaptNoArgs, adaptOptionalScalar } from "./commands";
import type { SecretStorageService } from "../api/secretStorageService";
import type { IUsageStore } from "../api/cache/usageStore";
import { UsageRefreshUseCase } from "../use-cases/usageRefreshUseCase";
import { createApiKey, updateApiKey, deleteApiKey } from "../api/clients/usageService";
import { formatErrorBrief } from "../infrastructure/logger";
import { maskKeyLabel } from "../api/redaction";
import type { KeyManagementResult } from "../types-usage";
import type { HttpClient } from "../api/transport/httpClient";

export class SetApiKeyCommand implements ICommand {
	readonly id = "openrouter-insights.setApiKey";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(key) Set Extension API Key",
		description: "Connect your OpenRouter key to this extension",
	};

	constructor(
		private readonly _secrets: SecretStorageService,
		private readonly _doRefresh: () => Promise<void>,
	) {}

	async execute(): Promise<void> {
		const key = await vscode.window.showInputBox({
			prompt:
				"Enter an OpenRouter API key. Management keys are recommended\u2014they unlock account-level features.",
			placeHolder: "sk-or-v1-...",
			password: true,
			ignoreFocusOut: true,
			validateInput: (value) => {
				if (!value.trim()) return "API key cannot be empty";
				if (!value.startsWith("sk-or-")) return "Key must start with 'sk-or-'";
				return null;
			},
		});

		if (!key) return;

		await this._secrets.set(key);
		void vscode.commands.executeCommand("setContext", "openrouter-insights:hasApiKey", true);

		await this._doRefresh();

		void vscode.window.showInformationMessage(
			"API key saved. OpenRouter Insights is now connected to your account.",
		);
	}
}

export class RemoveApiKeyCommand implements ICommand {
	readonly id = "openrouter-insights.removeApiKey";
	readonly argAdapter = adaptNoArgs;

	constructor(
		private readonly _secrets: SecretStorageService,
		private readonly _onCleared: () => Promise<void>,
	) {}

	async execute(): Promise<void> {
		const confirm = await vscode.window.showWarningMessage(
			"Disconnect OpenRouter Insights from your account? This removes the saved API key.",
			{ modal: true },
			"Remove",
		);

		if (confirm !== "Remove") return;

		await this._secrets.delete();
		await this._onCleared();

		void vscode.commands.executeCommand("setContext", "openrouter-insights:hasApiKey", false);
		void vscode.window.showInformationMessage(
			"API key removed. OpenRouter Insights is disconnected.",
		);
	}
}

export class RefreshUsageCommand implements ICommand {
	readonly id = "openrouter-insights.refreshUsage";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(refresh) Refresh Usage",
		description: "Update account balance and usage stats",
	};

	constructor(private readonly _refreshUseCase: UsageRefreshUseCase) {}

	async execute(): Promise<void> {
		await this._refreshUseCase.execute();
	}
}

export class LoadUsageDetailsCommand implements ICommand {
	readonly id = "openrouter-insights.loadUsageDetails";
	readonly argAdapter = adaptOptionalScalar;

	constructor(private readonly _refreshUseCase: UsageRefreshUseCase) {}

	async execute(_includeAnalytics?: boolean): Promise<void> {
		await this._refreshUseCase.loadDetails(_includeAnalytics);
	}
}

export class OpenUsageDashboardCommand implements ICommand {
	readonly id = "openrouter-insights.openUsageDashboard";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(dashboard) Open Usage Dashboard",
		description: "Show detailed usage and balance",
	};

	async execute(): Promise<void> {
		await vscode.commands.executeCommand("workbench.view.extension.openrouter-insights-usage");
	}
}

export class OpenExpandedDashboardCommand implements ICommand {
	readonly id = "openrouter-insights.openExpandedDashboard";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(layout) Open Expanded Dashboard",
		description: "Full-screen usage dashboard in an editor tab",
	};

	constructor(private readonly _openExpanded: () => vscode.WebviewPanel) {}

	async execute(): Promise<void> {
		this._openExpanded();
	}
}

export class SelectUsageKeyCommand implements ICommand {
	readonly id = "openrouter-insights.selectUsageKey";
	readonly argAdapter = adaptKeyHash;

	constructor(private readonly _doRefreshWithKey: (_keyHash: string) => Promise<void>) {}

	async execute(keyHash?: string): Promise<void> {
		if (!keyHash) return;
		await this._doRefreshWithKey(keyHash);
	}
}

// ── Key management commands (management key only) ──────────────

type RefreshFn = () => Promise<void>;

async function getManagementApiKey(secrets: SecretStorageService): Promise<string | undefined> {
	const key = await secrets.get();
	if (!key) {
		void vscode.window.showWarningMessage("Set an API key first to manage keys.");
		return undefined;
	}
	return key;
}

/**
 * Show a result notification. For "created" actions, includes a
 * modal dialog to show the one-time key value. Key labels are masked
 * so a full `sk-or-v1-…` string can never reach a notification.
 */
async function showResult(r: KeyManagementResult): Promise<void> {
	const safeLabel = maskKeyLabel(r.keyLabel);
	if (r.action === "created" && r.newKey) {
		const copy = await vscode.window.showInformationMessage(
			`API key "${safeLabel}" created. The key value is shown only once.`,
			{ modal: true },
			"Copy Key",
			"Close",
		);
		if (copy === "Copy Key") {
			await vscode.env.clipboard.writeText(r.newKey);
			void vscode.window.showInformationMessage("API key copied to clipboard.");
		}
	} else if (r.action === "toggled") {
		void vscode.window.showInformationMessage(`API key "${safeLabel}" toggled.`);
	} else if (r.action === "updated") {
		void vscode.window.showInformationMessage(`API key "${safeLabel}" updated.`);
	} else if (r.action === "deleted") {
		void vscode.window.showInformationMessage("API key deleted.");
	}
}

export class CreateApiKeyCommand implements ICommand {
	readonly id = "openrouter-insights.createApiKey";
	readonly argAdapter = adaptNoArgs;
	readonly quickAction = {
		label: "$(add) Create API Key",
		description: "Create a managed OpenRouter API key",
	};

	constructor(
		private readonly _secrets: SecretStorageService,
		private readonly _doRefresh: RefreshFn,
		private readonly _client?: HttpClient,
	) {}

	async execute(): Promise<void> {
		const apiKey = await getManagementApiKey(this._secrets);
		if (!apiKey) return;

		const name = await vscode.window.showInputBox({
			prompt: "Name for the new API key (e.g. 'Production', 'Staging')",
			placeHolder: "My App Key",
			validateInput: (v) => (v.trim() ? null : "Name is required"),
		});
		if (!name) return;

		const limitStr = await vscode.window.showInputBox({
			prompt: "Credit limit in USD (leave empty for unlimited, 0 blocks all spending)",
			placeHolder: "e.g. 100",
			validateInput: (v) => {
				if (!v) return null;
				const n = Number(v);
				return !Number.isNaN(n) && n >= 0 ? null : "Enter 0 or a positive number, or leave empty";
			},
		});
		let limit: number | undefined;
		if (limitStr !== undefined) {
			limit = limitStr === "" ? undefined : Number(limitStr);
		}

		const intervalPick = limit
			? await vscode.window.showQuickPick(
					[
						{ label: "Never", value: "" },
						{ label: "Daily", value: "daily" },
						{ label: "Weekly", value: "weekly" },
						{ label: "Monthly", value: "monthly" },
						{ label: "Yearly", value: "yearly" },
					],
					{ placeHolder: "Limit reset interval (only applies if limit is set)" },
				)
			: undefined;
		const limitReset = intervalPick?.value || undefined;

		try {
			const result = await createApiKey(
				apiKey,
				{
					name: name.trim(),
					limit,
					limit_reset: limitReset as "daily" | "weekly" | "monthly" | "yearly" | undefined,
				},
				this._client,
			);
			await showResult(result);
			await this._doRefresh();
		} catch (err) {
			void vscode.window.showErrorMessage(`Failed to create key: ${formatErrorBrief(err)}`);
			throw err;
		}
	}
}

export class RenameApiKeyCommand implements ICommand {
	readonly id = "openrouter-insights.renameApiKey";
	readonly argAdapter = adaptKeyHash;
	readonly quickAction = {
		label: "$(edit) Rename API Key",
		description: "Rename a managed OpenRouter API key",
	};

	constructor(
		private readonly _secrets: SecretStorageService,
		private readonly _cache: IUsageStore,
		private readonly _doRefresh: RefreshFn,
		private readonly _client?: HttpClient,
	) {}

	async execute(hash?: string): Promise<void> {
		const apiKey = await getManagementApiKey(this._secrets);
		if (!apiKey) return;

		const data = this._cache.get();
		const keys = data?.allKeys;
		if (!keys || keys.length === 0) {
			void vscode.window.showWarningMessage("No keys available. Refresh usage first.");
			return;
		}

		let targetHash = hash;
		let targetKey = targetHash ? keys.find((k) => k.hash === targetHash) : undefined;

		if (!targetHash || !targetKey) {
			const pick = await vscode.window.showQuickPick(
				keys.map((k) => ({
					label: k.name || k.label,
					description: `$${k.totalUsed.toFixed(2)} used${k.disabled ? " · disabled" : ""}`,
					hash: k.hash,
				})),
				{ placeHolder: "Select a key to rename" },
			);
			if (!pick) return;
			targetHash = pick.hash;
		}

		const newName = await vscode.window.showInputBox({
			prompt: "New name for the key",
			value: targetKey?.name || "",
			validateInput: (v) => (v.trim() ? null : "Name is required"),
		});
		if (!newName) return;

		try {
			const result = await updateApiKey(apiKey, targetHash, { name: newName.trim() }, this._client);
			await showResult(result);
			await this._doRefresh();
		} catch (err) {
			void vscode.window.showErrorMessage(`Failed to rename key: ${formatErrorBrief(err)}`);
			throw err;
		}
	}
}

export class ToggleApiKeyCommand implements ICommand {
	readonly id = "openrouter-insights.toggleApiKey";
	readonly argAdapter = adaptKeyHash;
	readonly quickAction = {
		label: "$(debug-alt) Enable or Disable API Key",
		description: "Change a managed API key's active state",
	};

	constructor(
		private readonly _secrets: SecretStorageService,
		private readonly _cache: IUsageStore,
		private readonly _doRefresh: RefreshFn,
		private readonly _client?: HttpClient,
	) {}

	async execute(hash?: string): Promise<void> {
		const apiKey = await getManagementApiKey(this._secrets);
		if (!apiKey) return;

		const data = this._cache.get();
		const keys = data?.allKeys;
		if (!keys || keys.length === 0) {
			void vscode.window.showWarningMessage("No keys available. Refresh usage first.");
			return;
		}

		let targetHash = hash;
		let targetKey = targetHash ? keys.find((k) => k.hash === targetHash) : undefined;

		if (!targetHash || !targetKey) {
			const pick = await vscode.window.showQuickPick(
				keys.map((k) => ({
					label: `${k.disabled ? "🔴" : "🟢"} ${k.name || k.label}`,
					description: k.disabled ? "disabled" : "enabled",
					hash: k.hash,
				})),
				{ placeHolder: "Select a key to enable/disable" },
			);
			if (!pick) return;
			targetHash = pick.hash;
			targetKey = keys.find((k) => k.hash === targetHash);
		}

		if (!targetKey) return;
		const newState = !targetKey.disabled;
		const actionLabel = newState ? "Disable" : "Enable";

		const confirm = await vscode.window.showWarningMessage(
			`${actionLabel} key "${targetKey.name || targetKey.label}"?`,
			{ modal: true },
			actionLabel,
		);
		if (confirm !== actionLabel) return;

		try {
			const result = await updateApiKey(apiKey, targetHash, { disabled: newState }, this._client);
			await showResult(result);
			await this._doRefresh();
		} catch (err) {
			void vscode.window.showErrorMessage(
				`Failed to ${actionLabel.toLowerCase()} key: ${formatErrorBrief(err)}`,
			);
			throw err;
		}
	}
}

export class SetKeyLimitCommand implements ICommand {
	readonly id = "openrouter-insights.setKeyLimit";
	readonly argAdapter = adaptKeyHash;
	readonly quickAction = {
		label: "$(lock) Set API Key Limit",
		description: "Set a managed API key's credit limit",
	};

	constructor(
		private readonly _secrets: SecretStorageService,
		private readonly _cache: IUsageStore,
		private readonly _doRefresh: RefreshFn,
		private readonly _client?: HttpClient,
	) {}

	private async _pickKey(hash?: string): Promise<string | undefined> {
		const data = this._cache.get();
		const keys = data?.allKeys;
		if (!keys || keys.length === 0) {
			void vscode.window.showWarningMessage("No keys available. Refresh usage first.");
			return undefined;
		}

		let targetHash = hash;
		const targetKey = targetHash ? keys.find((k) => k.hash === targetHash) : undefined;

		if (!targetHash || !targetKey) {
			const pick = await vscode.window.showQuickPick(
				keys.map((k) => ({
					label: `${k.name || k.label}`,
					description: `limit: ${k.limit !== null ? "$" + k.limit.toFixed(2) : "unlimited"}`,
					hash: k.hash,
				})),
				{ placeHolder: "Select a key to set a credit limit" },
			);
			if (!pick) return undefined;
			targetHash = pick.hash;
		}

		return targetHash;
	}

	async execute(hash?: string): Promise<void> {
		const apiKey = await getManagementApiKey(this._secrets);
		if (!apiKey) return;

		const targetHash = await this._pickKey(hash);
		if (!targetHash) return;

		const data = this._cache.get();
		const targetKey = data?.allKeys?.find((k) => k.hash === targetHash);
		if (!targetKey) return;

		const limitStr = await vscode.window.showInputBox({
			prompt: "Credit limit in USD (empty = no limit, 0 = block all spending)",
			placeHolder:
				targetKey.limit !== null ? `Current: $${targetKey.limit.toFixed(2)}` : "e.g. 100",
			value: targetKey.limit !== null ? String(targetKey.limit) : "",
			validateInput: (v) => {
				if (!v) return null;
				const n = Number(v);
				return !Number.isNaN(n) && n >= 0 ? null : "Enter 0 or a positive number";
			},
		});
		if (limitStr === undefined) return;

		const newLimit: number | undefined = limitStr === "" ? undefined : Number(limitStr);

		const intervalPick =
			newLimit !== undefined && newLimit > 0
				? await vscode.window.showQuickPick(
						[
							{ label: "Never", value: "" },
							{ label: "Daily", value: "daily" },
							{ label: "Weekly", value: "weekly" },
							{ label: "Monthly", value: "monthly" },
							{ label: "Yearly", value: "yearly" },
						],
						{ placeHolder: "Reset interval" },
					)
				: undefined;
		const limitReset = intervalPick?.value || undefined;

		try {
			const result = await updateApiKey(
				apiKey,
				targetHash,
				{
					limit: newLimit,
					limit_reset:
						newLimit !== undefined && newLimit > 0
							? (limitReset as "daily" | "weekly" | "monthly" | "yearly" | undefined)
							: undefined,
				},
				this._client,
			);
			await showResult(result);
			await this._doRefresh();
		} catch (err) {
			void vscode.window.showErrorMessage(`Failed to set limit: ${formatErrorBrief(err)}`);
			throw err;
		}
	}
}

export class DeleteApiKeyCommand implements ICommand {
	readonly id = "openrouter-insights.deleteApiKey";
	readonly argAdapter = adaptKeyHash;
	readonly quickAction = {
		label: "$(trash) Delete API Key",
		description: "Permanently delete a managed API key",
	};

	constructor(
		private readonly _secrets: SecretStorageService,
		private readonly _cache: IUsageStore,
		private readonly _doRefresh: RefreshFn,
		private readonly _client?: HttpClient,
	) {}

	async execute(hash?: string): Promise<void> {
		const apiKey = await getManagementApiKey(this._secrets);
		if (!apiKey) return;

		const data = this._cache.get();
		const keys = data?.allKeys;
		if (!keys || keys.length === 0) {
			void vscode.window.showWarningMessage("No keys available. Refresh usage first.");
			return;
		}

		let targetHash = hash;
		let targetKey = targetHash ? keys.find((k) => k.hash === targetHash) : undefined;

		if (!targetHash || !targetKey) {
			const pick = await vscode.window.showQuickPick(
				keys.map((k) => ({
					label: `${k.name || k.label}`,
					description: `$${k.totalUsed.toFixed(2)} used${k.disabled ? " · disabled" : ""}`,
					hash: k.hash,
				})),
				{ placeHolder: "Select a key to delete" },
			);
			if (!pick) return;
			targetHash = pick.hash;
			targetKey = keys.find((k) => k.hash === targetHash);
		}

		if (!targetKey) return;

		const keyLabel = targetKey.name || targetKey.label;
		const confirm = await vscode.window.showWarningMessage(
			`Permanently delete key "${keyLabel}"? This cannot be undone.`,
			{ modal: true },
			"Delete",
		);
		if (confirm !== "Delete") return;

		try {
			const result = await deleteApiKey(apiKey, targetHash, this._client);
			await showResult(result);
			await this._doRefresh();
		} catch (err) {
			void vscode.window.showErrorMessage(`Failed to delete key: ${formatErrorBrief(err)}`);
			throw err;
		}
	}
}
