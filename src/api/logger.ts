/** Narrow logging port used by API modules. */
export interface ApiLogger {
	debug(..._args: unknown[]): void;
	info(..._args: unknown[]): void;
	warn(..._args: unknown[]): void;
	error(..._args: unknown[]): void;
}

/** Default for direct API calls that are not composed by the extension host. */
export const noopApiLogger: ApiLogger = {
	debug: (..._args: unknown[]) => {},
	info: (..._args: unknown[]) => {},
	warn: (..._args: unknown[]) => {},
	error: (..._args: unknown[]) => {},
};
