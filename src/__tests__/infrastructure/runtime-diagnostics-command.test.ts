import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as vscode from "vscode";
import { ShowRuntimeDiagnosticsCommand } from "../../infrastructure/commands";
import { RuntimeDiagnostics } from "../../infrastructure/runtimeDiagnostics";

describe("ShowRuntimeDiagnosticsCommand", () => {
	const diagnostics = new RuntimeDiagnostics();
	let command: ShowRuntimeDiagnosticsCommand;

	beforeEach(() => {
		vi.clearAllMocks();
		diagnostics.recordRequest("models.list");
		command = new ShowRuntimeDiagnosticsCommand(diagnostics);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exposes the support command id and a no-arg adapter", () => {
		expect(command.id).toBe("openrouter-insights.showRuntimeDiagnostics");
		expect(command.argAdapter?.(["stray"])).toEqual([]);
	});

	it("copies a redacted report to the clipboard when chosen", async () => {
		const pick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({
			label: "copy",
			action: "copy",
		} as never);
		const writeText = vi.spyOn(vscode.env.clipboard, "writeText").mockResolvedValue(undefined);
		const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);

		await command.execute();

		expect(pick).toHaveBeenCalledOnce();
		expect(writeText).toHaveBeenCalledOnce();
		const report = writeText.mock.calls[0][0] as string;
		expect(report).toContain("Runtime Diagnostics");
		expect(report).toContain("models.list");
		expect(info).toHaveBeenCalledOnce();
	});

	it("falls back to the output channel when no action is chosen", async () => {
		vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
		const writeText = vi.spyOn(vscode.env.clipboard, "writeText").mockResolvedValue(undefined);

		await command.execute();

		expect(writeText).not.toHaveBeenCalled();
	});
});
