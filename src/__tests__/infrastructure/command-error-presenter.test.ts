import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as vscode from "vscode";
import { classifyCommandError, presentCommandError } from "../../infrastructure/commandRegistrar";
import { RuntimeDiagnostics } from "../../infrastructure/runtimeDiagnostics";

describe("command error classification", () => {
	it("treats cancellation as silent", () => {
		expect(classifyCommandError({ cancelled: true })).toBe("cancelled");
		expect(classifyCommandError(new DOMException("operation was aborted", "AbortError"))).toBe(
			"cancelled",
		);
		expect(classifyCommandError(new Error("operation was aborted"))).toBe("generic");
	});

	it("maps structured OpenRouter error classes to recovery categories", () => {
		expect(classifyCommandError({ errorClass: "auth" })).toBe("auth");
		expect(classifyCommandError({ errorClass: "permission" })).toBe("permission");
		expect(classifyCommandError({ errorClass: "rate-limit" })).toBe("rate-limit");
		expect(classifyCommandError({ errorClass: "not-found" })).toBe("not-found");
		expect(classifyCommandError(new Error("boom"))).toBe("generic");
	});
});

describe("presentCommandError", () => {
	const diagnostics = new RuntimeDiagnostics();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not notify the user for cancellation but still records the diagnostic", async () => {
		const showError = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
		await presentCommandError("openrouter-insights.browseModels", { cancelled: true }, diagnostics);

		expect(showError).not.toHaveBeenCalled();
		expect(diagnostics.snapshot().failures.command).toBe(1);
	});

	it("shows a recovery action for auth failures and executes it when chosen", async () => {
		const showError = vi
			.spyOn(vscode.window, "showErrorMessage")
			.mockResolvedValue("Set API Key" as never);
		const exec = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

		await presentCommandError(
			"openrouter-insights.refreshUsage",
			{ errorClass: "auth", message: "unauthorized" },
			diagnostics,
		);

		expect(showError).toHaveBeenCalledOnce();
		expect(exec).toHaveBeenCalledWith("openrouter-insights.setApiKey");
	});

	it("shows a generic message for unexpected errors without a recovery action", async () => {
		const showError = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
		vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

		await presentCommandError(
			"openrouter-insights.browseModels",
			new Error("weird internal failure"),
			diagnostics,
		);

		expect(showError).toHaveBeenCalledOnce();
		expect(showError.mock.calls[0][0]).toContain("Command failed");
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
	});
});
