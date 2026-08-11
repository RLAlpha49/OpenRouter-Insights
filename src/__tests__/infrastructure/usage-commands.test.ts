import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
	CreateApiKeyCommand,
	DeleteApiKeyCommand,
	LoadUsageDetailsCommand,
	OpenExpandedDashboardCommand,
	OpenUsageDashboardCommand,
	RefreshUsageCommand,
	RemoveApiKeyCommand,
	SelectUsageKeyCommand,
	SetApiKeyCommand,
	SetKeyLimitCommand,
	ToggleApiKeyCommand,
	RenameApiKeyCommand,
} from "../../infrastructure/usageCommands";

function secrets(key = "sk-or-management") {
	return {
		get: vi.fn(async () => key),
		set: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
	};
}

function usageStore() {
	return {
		get: () => ({
			allKeys: [
				{
					hash: "hash-1",
					name: "Production",
					label: "prod",
					disabled: false,
					totalUsed: 1,
					limit: 10,
					limitRemaining: 9,
					limitReset: null,
					dailyUsage: 0,
					weeklyUsage: 0,
					monthlyUsage: 1,
					usagePercent: 10,
				},
			],
		}),
	};
}

describe("usage commands", () => {
	it("cancels key-management commands when inputs are missing", async () => {
		const missing = secrets("");
		const refresh = vi.fn(async () => {});
		const empty = { get: () => ({ allKeys: [] }) };
		(vscode.window as any).showInputBox = vi.fn(async () => undefined);
		(vscode.window as any).showWarningMessage = vi.fn(async () => "Keep");
		await new SetApiKeyCommand(missing as any, refresh).execute();
		await new RemoveApiKeyCommand(missing as any, refresh).execute();
		await new CreateApiKeyCommand(missing as any, refresh).execute();
		await new RenameApiKeyCommand(missing as any, empty as any, refresh).execute();
		await new ToggleApiKeyCommand(missing as any, empty as any, refresh).execute();
		await new SetKeyLimitCommand(missing as any, empty as any, refresh).execute();
		await new DeleteApiKeyCommand(missing as any, empty as any, refresh).execute();
		await new SelectUsageKeyCommand(refresh).execute();
		expect(refresh).not.toHaveBeenCalled();
	});

	it("validates key inputs and cancels picker-based commands", async () => {
		const secret = secrets();
		const refresh = vi.fn(async () => {});
		const inputOptions: any[] = [];
		(vscode.window as any).showInputBox = vi.fn(async (options: any) => {
			inputOptions.push(options);
			return undefined;
		});
		await new SetApiKeyCommand(secret as any, refresh).execute();
		const setValidator = inputOptions[0].validateInput;
		expect(setValidator(" ")).toContain("cannot be empty");
		expect(setValidator("wrong")).toContain("must start");
		expect(setValidator("sk-or-ok")).toBeNull();
		const cache = usageStore();
		(vscode.window as any).showQuickPick = vi.fn(async () => undefined);
		await new RenameApiKeyCommand(secret as any, cache as any, refresh).execute();
		await new ToggleApiKeyCommand(secret as any, cache as any, refresh).execute();
		await new SetKeyLimitCommand(secret as any, cache as any, refresh).execute();
		await new DeleteApiKeyCommand(secret as any, cache as any, refresh).execute();
		expect(refresh).not.toHaveBeenCalled();
	});

	it("sets and removes an API key through the injected flows", async () => {
		const secret = secrets();
		const refresh = vi.fn(async () => {});
		(vscode.window as any).showInputBox = vi.fn(async () => "sk-or-v1-new");
		await new SetApiKeyCommand(secret as any, refresh).execute();
		expect(secret.set).toHaveBeenCalledWith("sk-or-v1-new");
		expect(refresh).toHaveBeenCalledOnce();
		(vscode.window as any).showWarningMessage = vi.fn(async () => "Remove");
		const cleared = vi.fn(async () => {});
		await new RemoveApiKeyCommand(secret as any, cleared).execute();
		expect(secret.delete).toHaveBeenCalledOnce();
		expect(cleared).toHaveBeenCalledOnce();
	});

	it("delegates usage refresh, details, expanded dashboard, and key selection", async () => {
		const useCase = {
			execute: vi.fn(async () => {}),
			loadDetails: vi.fn(async () => {}),
			executeWithKey: vi.fn(async () => {}),
		} as any;
		await new RefreshUsageCommand(useCase).execute();
		await new LoadUsageDetailsCommand(useCase).execute(true);
		await new SelectUsageKeyCommand(useCase.executeWithKey).execute("hash-1");
		const openExpanded = vi.fn(() => ({}) as any);
		await new OpenExpandedDashboardCommand(openExpanded).execute();
		await new OpenUsageDashboardCommand().execute();
		expect(useCase.execute).toHaveBeenCalledOnce();
		expect(useCase.loadDetails).toHaveBeenCalledWith(true);
		expect(useCase.executeWithKey).toHaveBeenCalledWith("hash-1");
		expect(openExpanded).toHaveBeenCalledOnce();
	});

	it("updates managed keys through API-backed flows", async () => {
		const secret = secrets();
		const refresh = vi.fn(async () => {});
		const client = {
			fetch: vi.fn(
				async (url: string, init?: RequestInit) =>
					new Response(
						JSON.stringify({
							data:
								init?.method === "DELETE"
									? { success: true }
									: url.includes("/keys/")
										? {
												hash: "hash-1",
												name: "Production",
												label: "prod",
												disabled: false,
												limit: 10,
												limit_remaining: 9,
												limit_reset: null,
											}
										: {
												key: "sk-or-new",
												hash: "hash-1",
												name: "Production",
												label: "prod",
												disabled: false,
												limit: 10,
												limit_remaining: 9,
												limit_reset: null,
											},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		} as any;
		(vscode.window as any).showInputBox = vi
			.fn()
			.mockResolvedValueOnce("New key")
			.mockResolvedValueOnce("10")
			.mockResolvedValueOnce("Renamed")
			.mockResolvedValueOnce("5");
		(vscode.window as any).showQuickPick = vi.fn(async () => ({ value: "daily", hash: "hash-1" }));
		(vscode.window as any).showInformationMessage = vi.fn(async () => "Close");
		(vscode.window as any).showWarningMessage = vi.fn(async () => "Disable");
		const cache = usageStore();
		await new CreateApiKeyCommand(secret as any, refresh, client).execute();
		await new RenameApiKeyCommand(secret as any, cache as any, refresh, client).execute("hash-1");
		await new ToggleApiKeyCommand(secret as any, cache as any, refresh, client).execute("hash-1");
		await new SetKeyLimitCommand(secret as any, cache as any, refresh, client).execute("hash-1");
		(vscode.window as any).showWarningMessage = vi.fn(async () => "Delete");
		await new DeleteApiKeyCommand(secret as any, cache as any, refresh, client).execute("hash-1");
		expect(client.fetch).toHaveBeenCalled();
		expect(refresh).toHaveBeenCalled();
	});

	it("copies keys and handles disabled or missing key states", async () => {
		const secret = secrets();
		const refresh = vi.fn(async () => {});
		const cache = usageStore();
		(vscode.window as any).showInputBox = vi
			.fn()
			.mockResolvedValueOnce("Created")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce(undefined);
		(vscode.window as any).showQuickPick = vi.fn(async () => undefined);
		(vscode.window as any).showInformationMessage = vi.fn(async () => "Copy Key");
		(vscode.window as any).showWarningMessage = vi.fn(async () => "Enable");
		(vscode.env.clipboard.writeText as any) = vi.fn(async () => {});
		const client = {
			fetch: vi.fn(
				async (url: string, init?: RequestInit) =>
					new Response(
						JSON.stringify({
							data:
								init?.method === "DELETE"
									? { success: true }
									: url.includes("/keys/")
										? {
												hash: "hash-1",
												name: "Production",
												label: "prod",
												disabled: true,
												limit: null,
												limit_remaining: null,
												limit_reset: null,
											}
										: {
												key: "sk-or-created",
												hash: "hash-1",
												name: "Created",
												label: "created",
												disabled: false,
												limit: null,
												limit_remaining: null,
												limit_reset: null,
											},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		} as any;
		await new CreateApiKeyCommand(secret as any, refresh, client).execute();
		await new ToggleApiKeyCommand(secret as any, cache as any, refresh, client).execute("unknown");
		await new SetKeyLimitCommand(secret as any, cache as any, refresh, client).execute("hash-1");
		expect(vscode.env.clipboard.writeText as any).toHaveBeenCalledWith("sk-or-created");
	});

	it("rethrows management command failures after notifying the user", async () => {
		const secret = secrets();
		const refresh = vi.fn(async () => {});
		const cache = usageStore();
		// Server error — the transport retries transient failures with real
		// exponential backoff before rethrowing, so this test needs a longer
		// timeout than the suite default.
		const client = { fetch: vi.fn(async () => new Response("bad", { status: 500 })) } as any;
		(vscode.window as any).showInputBox = vi.fn(async () => "Renamed");
		(vscode.window as any).showWarningMessage = vi.fn(async () => "Disable");
		(vscode.window as any).showErrorMessage = vi.fn();
		await expect(
			new RenameApiKeyCommand(secret as any, cache as any, refresh, client).execute("hash-1"),
		).rejects.toThrow();
		await expect(
			new ToggleApiKeyCommand(secret as any, cache as any, refresh, client).execute("hash-1"),
		).rejects.toThrow();
		expect(vscode.window.showErrorMessage as any).toHaveBeenCalled();
	}, 15000);

	it("cancels limit and toggle commands on confirmation", async () => {
		const secret = secrets();
		const refresh = vi.fn(async () => {});
		const cache = usageStore();
		(vscode.window as any).showInputBox = vi.fn(async () => undefined);
		(vscode.window as any).showWarningMessage = vi.fn(async () => "Keep");
		await new SetKeyLimitCommand(secret as any, cache as any, refresh).execute("hash-1");
		await new ToggleApiKeyCommand(secret as any, cache as any, refresh).execute("hash-1");
		expect(refresh).not.toHaveBeenCalled();
	});

	it("handles unlimited key creation without asking for a reset interval", async () => {
		const secret = secrets();
		const refresh = vi.fn(async () => {});
		const client = {
			fetch: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								key: "sk-or-new",
								hash: "hash-new",
								name: "Unlimited",
								label: "unlimited",
								disabled: false,
								limit: null,
								limit_remaining: null,
								limit_reset: null,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		} as any;
		(vscode.window as any).showInputBox = vi
			.fn()
			.mockResolvedValueOnce("Unlimited")
			.mockResolvedValueOnce("");
		(vscode.window as any).showInformationMessage = vi.fn(async () => "Close");
		const quickPick = vi.fn(async () => undefined);
		(vscode.window as any).showQuickPick = quickPick;

		await new CreateApiKeyCommand(secret as any, refresh, client).execute();

		expect(quickPick).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("passes explicit analytics selection to the details command", async () => {
		const useCase = { loadDetails: vi.fn(async () => {}) } as any;
		await new LoadUsageDetailsCommand(useCase).execute(false);
		expect(useCase.loadDetails).toHaveBeenCalledWith(false);
	});

	it("ignores missing usage-key selection", async () => {
		const refresh = vi.fn(async () => {});
		await new SelectUsageKeyCommand(refresh).execute();
		expect(refresh).not.toHaveBeenCalled();
	});
});
