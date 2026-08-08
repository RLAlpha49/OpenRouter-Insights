/**
 * esbuild bundle config — bundles the extension into a single file for
 * faster activation and smaller vsix.
 * are externalized; all src/ files are inlined.
 *
 * Usage: node esbuild.config.mjs
 */

import * as esbuild from "esbuild";
import { rmSync } from "node:fs";

const isWatch = process.argv.includes("--watch");
const isProd = process.argv.includes("--production") || process.env.CI === "true";

// Clean previous output so no stale files linger
rmSync("out", { recursive: true, force: true });
console.log("[esbuild] Cleaned out/ directory");

/** @type {esbuild.BuildOptions} */
const config = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "out/extension.js",
	platform: "node",
	target: "node20",
	format: "cjs",
	external: [
		"vscode", // Provided by extension host
	],
	sourcemap: !isProd,
	minify: isProd,
	keepNames: !isProd, // Preserve names only in dev for readable stack traces
	treeShaking: true,
	logLevel: "info",
};

if (isWatch) {
	const ctx = await esbuild.context(config);
	await ctx.watch();
	console.log("[esbuild] Watching for changes...");
} else {
	await esbuild.build(config);
	console.log("[esbuild] Build complete: out/extension.js");
}
