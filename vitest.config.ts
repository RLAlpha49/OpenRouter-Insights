import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reporter: ["html", "text", "text-summary"],
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: ["**/*.generated.ts", "**/__mocks__/**", "**/*.d.ts", "**/*.test.ts"],
			thresholds: [
				{
					statements: 80,
					branches: 75,
					functions: 80,
					lines: 80,
				},
			],
		},
		include: ["src/__tests__/**/*.test.ts"],
		globals: true,
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "src/__tests__/__mocks__/vscode.ts"),
		},
		extensions: [".ts", ".tsx", ".js", ".json"],
	},
});
