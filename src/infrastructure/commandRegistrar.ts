/**
 * CommandRegistrar — registers all extension commands with VS Code.
 *
 * Delegates to the command pattern (commands.ts / ServiceContainer.commands).
 * The old monolith is replaced by individual ICommand implementations
 * wired together in the composition root (services.ts).
 */

import * as vscode from "vscode";
import type { CommandServices } from "./services";
import { formatErrorBrief, log } from "./logger";
import type { RuntimeDiagnostics } from "./runtimeDiagnostics";
import { isCancellationError } from "../api/transport/fetchHelpers";

/**
 * Classify a command failure into a user-facing recovery category.
 * Cancellation is treated as silent (no notification). Permanent contract or
 * credential failures surface a concise message; everything else is generic.
 */
type CommandErrorKind =
	"cancelled" | "auth" | "permission" | "rate-limit" | "not-found" | "generic";

interface CommandErrorAction {
	label: string;
	command: string;
	args?: unknown[];
}

const COMMAND_RECOVERY: Partial<
	Record<CommandErrorKind, { message: string; action?: CommandErrorAction }>
> = {
	auth: {
		message: "OpenRouter Insights: Your API key is missing or invalid. Set it to continue.",
		action: { label: "Set API Key", command: "openrouter-insights.setApiKey" },
	},
	permission: {
		message: "OpenRouter Insights: This action needs additional key permissions.",
		action: { label: "Set API Key", command: "openrouter-insights.setApiKey" },
	},
	"rate-limit": {
		message: "OpenRouter Insights: Rate limited by OpenRouter. Try again shortly.",
	},
	"not-found": {
		message: "OpenRouter Insights: Required data was not found. Try refreshing first.",
		action: { label: "Refresh", command: "openrouter-insights.refreshPricing" },
	},
};

export function classifyCommandError(error: unknown): CommandErrorKind {
	if (isCancellationError(error)) return "cancelled";
	const err = error as { errorClass?: string; status?: number; apiMessage?: string } | null;
	if (err?.errorClass === "auth") return "auth";
	if (err?.errorClass === "permission") return "permission";
	if (err?.errorClass === "rate-limit" || err?.status === 429) return "rate-limit";
	if (err?.errorClass === "not-found" || err?.status === 404) return "not-found";
	return "generic";
}

/**
 * Present a command failure to the user: record the diagnostic once, log the
 * structured error, and show a concise recovery message with an optional action.
 */
export async function presentCommandError(
	commandId: string,
	error: unknown,
	diagnostics?: RuntimeDiagnostics,
): Promise<void> {
	diagnostics?.recordFailure("command", error);
	log.errorFields(
		{ boundary: "command", commandId },
		`Command ${commandId} failed:`,
		formatErrorBrief(error),
	);

	const kind = classifyCommandError(error);
	if (kind === "cancelled") return;

	const recovery = COMMAND_RECOVERY[kind];
	const message =
		recovery?.message ?? `OpenRouter Insights: Command failed — ${formatErrorBrief(error)}`;
	const detail = error instanceof Error ? formatErrorBrief(error) : String(error);

	if (recovery?.action) {
		const chosen = await vscode.window.showErrorMessage(
			message,
			{ detail, modal: false },
			recovery.action.label,
		);
		if (chosen === recovery.action.label) {
			await vscode.commands.executeCommand(
				recovery.action.command,
				...(recovery.action.args ?? []),
			);
		}
	} else {
		void vscode.window.showErrorMessage(message, { detail });
	}
}

/**
 * Register all extension commands from the command map in the ServiceContainer.
 * Each command is registered individually with VS Code's command system.
 */
export function registerCommands(
	_context: vscode.ExtensionContext,
	svc: CommandServices,
): vscode.Disposable {
	const registrations: vscode.Disposable[] = [];
	for (const cmd of svc.commands.values()) {
		log.debug("registerCommands:", cmd.id);
		const disposable = vscode.commands.registerCommand(cmd.id, (...args: unknown[]) => {
			if (!svc.features.shouldRegisterCommand(cmd.id)) {
				log.debug("registerCommands: ignored disabled command", cmd.id);
				return undefined;
			}
			const adapter = cmd.argAdapter ?? ((raw: readonly unknown[]) => [...raw]);
			let typedArgs: readonly unknown[];
			try {
				typedArgs = adapter(args);
			} catch (error) {
				return presentCommandError(cmd.id, error, svc.diagnostics);
			}
			return (cmd.execute as (..._args: unknown[]) => Promise<void>)(...typedArgs).catch(
				(error: unknown) => presentCommandError(cmd.id, error, svc.diagnostics),
			);
		});
		registrations.push(disposable);
	}
	log.info("registerCommands: registered", svc.commands.size, " commands");
	return vscode.Disposable.from(...registrations);
}
