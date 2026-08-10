/**
 * Manifest-to-documentation drift check.
 *
 * Verifies that every contributed command title and configuration property in
 * `package.json` is represented in `README.md`. This keeps the user-facing
 * command and settings reference honest as the manifest grows, so a newly
 * added command or setting triggers a reviewable failure instead of silently
 * drifting out of the primary documentation surface.
 *
 * Run:
 *   node scripts/check-manifest-docs.mjs
 *
 * The check is read-only. Entries that are intentionally undocumented can be
 * added to the exemption sets below with a short reason comment.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");

/**
 * Commands that are intentionally not listed in README.md (e.g. internal or
 * duplicate-titled commands). Keep this list empty unless there is a reason.
 */
const exemptCommands = new Set([]);

/**
 * Configuration properties intentionally absent from README.md (e.g. private
 * or auto-generated). Keep this list empty unless there is a reason.
 */
const exemptSettings = new Set([]);

const commandTitles = (pkg.contributes?.commands ?? []).map((c) => c.title);
const settingKeys = Object.keys(pkg.contributes?.configuration?.properties ?? {});

const missingCommands = commandTitles.filter(
	(title) => !exemptCommands.has(title) && !readme.includes(title),
);
const missingSettings = settingKeys.filter(
	(key) => !exemptSettings.has(key) && !readme.includes(key),
);

let failed = false;

console.log("=== Manifest → README drift check ===");
console.log(`  commands documented in README: ${commandTitles.length - missingCommands.length}/${commandTitles.length}`);
console.log(`  settings documented in README: ${settingKeys.length - missingSettings.length}/${settingKeys.length}`);

if (missingCommands.length > 0) {
	failed = true;
	console.error("  ❌ Command titles missing from README.md:");
	for (const title of missingCommands) {
		console.error(`     - ${title}`);
	}
}

if (missingSettings.length > 0) {
	failed = true;
	console.error("  ❌ Configuration properties missing from README.md:");
	for (const key of missingSettings) {
		console.error(`     - ${key}`);
	}
}

if (!failed) {
	console.log("  ✅ All contributed commands and settings are documented in README.md");
	process.exit(0);
}

console.error(
	"\n  Document the missing entries in README.md or add them to the exemption sets in scripts/check-manifest-docs.mjs.",
);
process.exit(1);
