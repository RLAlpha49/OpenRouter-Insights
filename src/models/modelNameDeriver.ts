/**
 * ModelNameDeriver — converts raw OpenRouter model identifiers
 * into human-readable display names.
 */

/**
 * Derive a human-readable display name from an OpenRouter model identifier.
 *
 * Examples:
 *   "openai/gpt-4o"          → "Gpt 4o"
 *   "anthropic/claude-3-opus" → "Claude 3 Opus"
 *   "google/gemini-2.5-pro"  → "Gemini 2.5 Pro"
 */
export function deriveName(identifier: string): string {
	const parts = identifier.split("/");
	const last = parts.at(-1) ?? identifier;
	return last.replace(/[-:]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
