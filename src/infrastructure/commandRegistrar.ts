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
			const typedArgs = adapter(args);
			return (cmd.execute as (..._args: unknown[]) => Promise<void>)(...typedArgs).catch(
				(error: unknown) => {
					svc.diagnostics?.recordFailure("command", error);
					log.errorFields(
						{ boundary: "command", commandId: cmd.id },
						`Command ${cmd.id} failed:`,
						formatErrorBrief(error),
					);
				},
			);
		});
		registrations.push(disposable);
	}
	log.info("registerCommands: registered", svc.commands.size, " commands");
	return vscode.Disposable.from(...registrations);
}
