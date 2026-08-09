import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(process.cwd(), "src/ui/assets/webview-theme.css"), "utf8");

describe("webview reduced-motion policy", () => {
	it("uses explicit transition properties", () => {
		expect(css).not.toMatch(/transition:\s*all/);
	});

	it("covers the interactive and decorative motion surfaces", () => {
		for (const selector of [
			".or-btn",
			".or-card",
			".or-key-card",
			".or-chart-bar",
			".or-spinner",
		]) {
			expect(css).toContain(selector);
		}
		expect(css).toContain("prefers-reduced-motion: reduce");
		expect(css).toContain("animation: none !important");
	});
});
