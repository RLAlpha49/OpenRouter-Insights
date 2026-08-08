import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
	{ ignores: ["out/**", "node_modules/**", "**/*.js"] },
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: "module",
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: { "@stylistic": stylistic, "@typescript-eslint": tseslint.plugin },
		rules: {
			"no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
			"no-console": "warn",
			"@stylistic/semi": ["error", "always"],
			"@stylistic/quotes": ["error", "double", { avoidEscape: true }],
			"@stylistic/comma-dangle": ["error", "always-multiline"],
			"@stylistic/indent": ["error", "tab", { SwitchCase: 1 }],
			"@stylistic/no-trailing-spaces": "error",
			"@stylistic/eol-last": ["error", "always"],
			"@stylistic/arrow-parens": ["error", "always"],
			"@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true, ignoreIIFE: true }],
			"max-params": ["warn", { max: 8 }],
		},
	},
	prettier,
	// VS Code mock — enum members exist for API type compatibility, not direct test usage.
	{
		files: ["src/__tests__/__mocks__/vscode.ts"],
		rules: { "no-unused-vars": "off" },
	},
];
