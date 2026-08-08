import { describe, expect, it } from "vitest";
import { parseModelIdentifier, parseRecentModel } from "../../models/sqlModelParser";

describe("sql model parser", () => {
	it("extracts and validates a model field from panel JSON", () => {
		expect(parseModelIdentifier('{"model":"openai/gpt-4o"}')).toBe("openai/gpt-4o");
	});

	it("rejects malformed identifiers instead of publishing raw state", () => {
		expect(parseModelIdentifier("not-a-model")).toBeUndefined();
		expect(parseModelIdentifier('{"identifier":""}')).toBeUndefined();
	});

	it("rejects malformed recent-model entries", () => {
		expect(parseRecentModel('["anthropic/claude", "invalid"]')).toBe("anthropic/claude");
		expect(parseRecentModel('["invalid"]')).toBeUndefined();
	});
});
