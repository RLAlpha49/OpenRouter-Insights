import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const bridgeSource = readFileSync(
	path.resolve(process.cwd(), "src/ui/assets/webview-bridge.js"),
	"utf8",
);

describe("webview bridge interaction updates", () => {
	it("supports state capture and keyed region updates", () => {
		expect(bridgeSource).toContain("captureInteractionState");
		expect(bridgeSource).toContain("restoreInteractionState");
		expect(bridgeSource).toContain('message?.cmd === "updateRegion"');
		expect(bridgeSource).toContain("data-region");
	});

	it("validates region messages before changing the DOM", () => {
		expect(bridgeSource).toContain("/^[a-z][a-z0-9-]*$/");
		expect(bridgeSource).toContain('typeof message.html !== "string"');
	});
});
