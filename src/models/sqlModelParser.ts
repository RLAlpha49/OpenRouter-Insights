/**
 * SqlModelParser — pure parsing helpers for Copilot model state values.
 *
 * No database dependencies — operates on raw string values extracted
 * from state.vscdb by sqliteReader.ts. Functions that previously
 * performed SQL queries (queryValue, queryRecentModel) are now handled
 * directly by readItemTableValue() in sqliteReader.ts.
 */

export type StateReaderLogger = (_msg: string) => void;

const MODEL_IDENTIFIER_PATTERN = /^[^/\s]+\/[^\s]+$/;

function validModelIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" && value.length <= 256 && MODEL_IDENTIFIER_PATTERN.test(value.trim())
	);
}

/**
 * Parse a model identifier from the raw value string.
 * The value is typically a JSON-encoded object with an 'identifier' field.
 * Falls back to treating the raw string as the ID if JSON parsing fails.
 */
export function parseModelIdentifier(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		if (validModelIdentifier(obj.identifier)) return obj.identifier.trim();
		if (validModelIdentifier(obj.id)) return obj.id.trim();
		if (validModelIdentifier(obj.model)) return obj.model.trim();
	} catch {
		// Not JSON — accept only a provider/model-shaped identifier.
	}
	return validModelIdentifier(raw) ? raw.trim() : undefined;
}

/**
 * Parse the most-recently-used model list from the raw value.
 * The value is a JSON array of model identifiers; returns the first entry.
 */
export function parseRecentModel(
	raw: string | undefined,
	logger?: StateReaderLogger,
): string | undefined {
	if (!raw) return undefined;
	try {
		const arr = JSON.parse(raw) as unknown[];
		if (Array.isArray(arr) && arr.length > 0 && validModelIdentifier(arr[0])) {
			return arr[0].trim();
		}
	} catch {
		logger?.("[SqlModelParser] recent model JSON parse failed");
	}
	return undefined;
}
