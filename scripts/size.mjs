/**
 * Artifact size gate.
 *
 * Every check targets an explicitly named artifact so a run can never pass by
 * inspecting a stale workspace file, and can never silently skip a check
 * because the artifact it should measure was not produced.
 *
 * Usage:
 *   node scripts/size.mjs --bundle                 Measure out/ (required)
 *   node scripts/size.mjs --vsix                   Measure the versioned VSIX (required)
 *   node scripts/size.mjs --bundle --vsix          Measure both (required)
 *   node scripts/size.mjs --bundle=dist            Measure an explicit bundle directory
 *   node scripts/size.mjs --vsix=path/to/pkg.vsix  Measure an explicit VSIX path
 *
 * At least one target must be requested. A requested target that is missing or
 * empty fails the run.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..");
const DEFAULT_BUNDLE_DIR = "out";

/** Max thresholds that cause a CI failure. */
const THRESHOLDS = {
	vsix: 1 * 1024 * 1024, // 1 MB
	bundle: 5 * 1024 * 1024, // 5 MB
};

/**
 * Parse `--bundle`, `--bundle=<dir>`, `--vsix`, and `--vsix=<path>`.
 *
 * @param {string[]} argv
 * @returns {{ bundle: string | null, vsix: string | null, unknown: string[] }}
 */
function parseArgs(argv) {
	let bundle = null;
	let vsix = null;
	const unknown = [];

	for (const arg of argv) {
		const [flag, value] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, ""];
		if (flag === "--bundle") {
			bundle = value || DEFAULT_BUNDLE_DIR;
		} else if (flag === "--vsix") {
			vsix = value || resolveVersionedVsix();
		} else {
			unknown.push(arg);
		}
	}

	return { bundle, vsix, unknown };
}

/**
 * The VSIX name is derived the same way `scripts/package-vsix.mjs` and
 * `scripts/checksum-vsix.mjs` derive it, so the size gate measures the exact
 * artifact the packaging path just produced.
 *
 * @returns {string}
 */
function resolveVersionedVsix() {
	const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	return `openrouter-insights-${packageJson.version}.vsix`;
}

/**
 * @param {string} target
 * @returns {string}
 */
function toAbsolute(target) {
	return isAbsolute(target) ? target : resolve(ROOT, target);
}

/**
 * Format bytes into human-readable string.
 *
 * @param {number} bytes
 * @returns {string}
 */
function fmtBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Collect file sizes recursively.
 *
 * @param {string} dir
 * @returns {{ path: string, size: number }[]}
 */
function collectSizes(dir) {
	const result = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			result.push(...collectSizes(full));
		} else {
			result.push({ path: relative(ROOT, full), size: statSync(full).size });
		}
	}
	return result;
}

/**
 * @param {string} bundleDir
 * @returns {number} Number of failures.
 */
function checkBundle(bundleDir) {
	const absolute = toAbsolute(bundleDir);
	console.log(`=== Bundled output (${relative(ROOT, absolute).replaceAll("\\", "/") || bundleDir}) ===`);

	if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
		console.error(`  ❌ Bundle directory not found — run \`npm run bundle\` before the size gate`);
		return 1;
	}

	const files = collectSizes(absolute);
	if (files.length === 0) {
		console.error(`  ❌ Bundle directory is empty — run \`npm run bundle\` before the size gate`);
		return 1;
	}

	files.sort((a, b) => b.size - a.size);
	let total = 0;
	for (const file of files) {
		console.log(`  ${fmtBytes(file.size).padStart(8)}  ${file.path}`);
		total += file.size;
	}
	console.log(`  ${"".padStart(8)}  ─────────`);
	console.log(`  ${fmtBytes(total).padStart(8)}  total`);

	if (total > THRESHOLDS.bundle) {
		console.error(`  ❌ Bundle exceeds ${fmtBytes(THRESHOLDS.bundle)} threshold!`);
		return 1;
	}

	console.log(`  ✅ Bundle under ${fmtBytes(THRESHOLDS.bundle)} threshold`);
	return 0;
}

/**
 * @param {string} vsixPath
 * @param {boolean} leadingBlankLine
 * @returns {number} Number of failures.
 */
function checkVsix(vsixPath, leadingBlankLine) {
	const absolute = toAbsolute(vsixPath);
	const display = relative(ROOT, absolute).replaceAll("\\", "/") || vsixPath;
	console.log(`${leadingBlankLine ? "\n" : ""}=== VSIX package (${display}) ===`);

	if (!existsSync(absolute) || !statSync(absolute).isFile()) {
		console.error(`  ❌ VSIX not found — run \`npm run package:verified\` before the size gate`);
		return 1;
	}

	const size = statSync(absolute).size;
	console.log(`  ${fmtBytes(size).padStart(8)}  ${display}`);
	if (size > THRESHOLDS.vsix) {
		console.error(`  ❌ VSIX exceeds ${fmtBytes(THRESHOLDS.vsix)} threshold!`);
		return 1;
	}

	console.log(`  ✅ VSIX under ${fmtBytes(THRESHOLDS.vsix)} threshold`);
	return 0;
}

// ── Main ──────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

if (args.unknown.length > 0) {
	console.error(`Unknown argument(s): ${args.unknown.join(", ")}`);
	console.error("Usage: node scripts/size.mjs [--bundle[=dir]] [--vsix[=path]]");
	process.exit(1);
}

if (!args.bundle && !args.vsix) {
	console.error("No size target requested.");
	console.error("Usage: node scripts/size.mjs [--bundle[=dir]] [--vsix[=path]]");
	process.exit(1);
}

let errors = 0;
if (args.bundle) {
	errors += checkBundle(args.bundle);
}
if (args.vsix) {
	errors += checkVsix(args.vsix, Boolean(args.bundle));
}

console.log("\n" + (errors === 0 ? "✅ All size checks passed" : `❌ ${errors} size check(s) failed`));
process.exit(errors > 0 ? 1 : 0);
