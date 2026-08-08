import * as vscode from "vscode";
import { getLogLevel, type LogLevel } from "./config";
import { redact } from "../api/redaction";

/**
 * Logger — injectable, testable logging with OutputChannel.
 *
 * The module-level `log` facade is backed by a singleton Logger instance
 * for convenience (pre-existing call sites don't need to change), but
 * new code can depend on Logger via Services/DI for testability.
 *
 * Use `Logger.for(context)` to create a contextual logger that prefixes
 * all messages with the given context string.
 */

/** Numeric severity for log level comparison (higher = more severe). */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

function withFields(args: unknown[], fields?: LogFields): unknown[] {
	return fields ? [...args, fields] : args;
}

// ── Singleton backing the `log` facade ─────────────────────────
let _defaultLogger: Logger | undefined;

function getDefaultLogger(): Logger {
	_defaultLogger ??= new Logger("OpenRouter Insights");
	return _defaultLogger;
}

// ── Logger class ───────────────────────────────────────────────

export class Logger {
	constructor(
		private readonly _context: string,
		private _channel?: vscode.OutputChannel,
	) {}

	/** Attach an OutputChannel after construction (for DI). */
	setChannel(channel: vscode.OutputChannel): void {
		this._channel = channel;
	}

	/** Create a contextual sub-logger that prefixes messages with the given tag. */
	for(subContext: string): Logger {
		return new Logger(`${this._context}›${subContext}`, this._channel);
	}

	/** Return the underlying OutputChannel (or undefined if not set). */
	get channel(): vscode.OutputChannel | undefined {
		return this._channel;
	}

	private _shouldLog(level: LogLevel): boolean {
		return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[getLogLevel()];
	}

	private _fmt(level: string, args: unknown[]): void {
		if (!this._channel) return;
		const ts = new Date().toLocaleTimeString();
		const body = args
			.map((a) => {
				if (typeof a === "string") return redact(a);
				try {
					return redact(JSON.stringify(a));
				} catch {
					return String(a);
				}
			})
			.join(" ");
		this._channel.appendLine(`[${level} ${ts}] [${this._context}] ${body}`);
	}

	info(...args: unknown[]): void {
		if (this._shouldLog("info")) this._fmt("INFO ", args);
	}
	infoFields(fields: LogFields, ...args: unknown[]): void {
		this.info(...withFields(args, fields));
	}
	warn(...args: unknown[]): void {
		if (this._shouldLog("warn")) this._fmt("WARN ", args);
	}
	error(...args: unknown[]): void {
		if (this._shouldLog("error")) this._fmt("ERROR", args);
	}
	errorFields(fields: LogFields, ...args: unknown[]): void {
		this.error(...withFields(args, fields));
	}
	debug(...args: unknown[]): void {
		if (this._shouldLog("debug")) this._fmt("DEBUG", args);
	}

	dispose(): void {
		// OutputChannel lifecycle is managed by initLogger / context.subscriptions
		this._channel = undefined;
	}
}

// ── Module-level log facade ────────────────────────────────────

export const log = {
	info: (...args: unknown[]) => getDefaultLogger().info(...args),
	infoFields: (fields: LogFields, ...args: unknown[]) =>
		getDefaultLogger().infoFields(fields, ...args),
	warn: (...args: unknown[]) => getDefaultLogger().warn(...args),
	error: (...args: unknown[]) => getDefaultLogger().error(...args),
	errorFields: (fields: LogFields, ...args: unknown[]) =>
		getDefaultLogger().errorFields(fields, ...args),
	debug: (...args: unknown[]) => getDefaultLogger().debug(...args),
};

// ── Initialisation ─────────────────────────────────────────────

/**
 * Initialise the singleton logger with the extension's OutputChannel.
 * Called once during activation. The returned channel is pushed to
 * context.subscriptions automatically by the caller.
 */
export function initLogger(context: vscode.ExtensionContext): vscode.OutputChannel {
	const channel = vscode.window.createOutputChannel("OpenRouter Insights");
	context.subscriptions.push(channel);

	_defaultLogger = new Logger("OR-Insights", channel);
	return channel;
}

/** Show the output channel in the panel. */
export function show(): void {
	getDefaultLogger().channel?.show();
}

/**
 * Format an error for logging — preserves stack traces for Error objects.
 * Use this in catch blocks instead of String(err) to keep debuggable traces.
 * Applied redaction strips bearer tokens / API keys from messages and stacks.
 */
export function formatError(err: unknown, includeStack = true): string {
	if (err instanceof Error) {
		const msg = err.message || String(err);
		if (includeStack && err.stack) {
			return redact(msg + "\n" + err.stack);
		}
		return redact(msg);
	}
	return redact(String(err));
}

/**
 * Extract a safe, single-line error message suitable for user-facing
 * notifications (no stack traces leaked to the UI). Redacted.
 */
export function formatErrorBrief(err: unknown): string {
	if (err instanceof Error) return redact(err.message || String(err));
	return redact(String(err));
}
