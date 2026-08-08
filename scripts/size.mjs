/**
 * Bundle size tracker — reports sizes of bundled extension, vsix, and
 * individual files so we can catch bloat early.
 *
 * Usage: node scripts/size.mjs
 */

import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..");
const OUT_DIR = join(ROOT, "out");
const VSIX_GLOB = /\.vsix$/i;

/** Max thresholds that cause a CI failure. */
const THRESHOLDS = {
	vsix: 1 * 1024 * 1024, // 1 MB
	bundle: 5 * 1024 * 1024, // 5 MB
};

/**
 * Format bytes into human-readable string.
 */
function fmtBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Collect file sizes recursively (non-recursive for out/).
 */
function collectSizes(dir) {
	const result = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				result.push(...collectSizes(full));
			} else {
				result.push({ path: relative(ROOT, full), size: statSync(full).size });
			}
		}
	} catch {
		// Directory may not exist yet (e.g., out/ before build)
	}
	return result;
}

// ── Main ──────────────────────────────────────────────────

let errors = 0;

// 1. Bundled output sizes
console.log("=== Bundled output (out/) ===");
const outFiles = collectSizes(OUT_DIR);
if (outFiles.length === 0) {
	console.log("  (empty — run `npm run bundle` first)");
} else {
	outFiles.sort((a, b) => b.size - a.size);
	let totalBundle = 0;
	for (const f of outFiles) {
		console.log(`  ${fmtBytes(f.size).padStart(8)}  ${f.path}`);
		totalBundle += f.size;
	}
	console.log(`  ${"".padStart(8)}  ─────────`);
	console.log(`  ${fmtBytes(totalBundle).padStart(8)}  total`);
	if (totalBundle > THRESHOLDS.bundle) {
		console.error(`  ❌ Bundle exceeds ${fmtBytes(THRESHOLDS.bundle)} threshold!`);
		errors++;
	} else {
		console.log(`  ✅ Bundle under ${fmtBytes(THRESHOLDS.bundle)} threshold`);
	}
}

// 2. VSIX size
console.log("\n=== VSIX packages ===");
let foundVsix = false;
for (const entry of readdirSync(ROOT)) {
	if (VSIX_GLOB.test(entry)) {
		const full = join(ROOT, entry);
		const size = statSync(full).size;
		console.log(`  ${fmtBytes(size).padStart(8)}  ${entry}`);
		foundVsix = true;
		if (size > THRESHOLDS.vsix) {
			console.error(`  ❌ VSIX exceeds ${fmtBytes(THRESHOLDS.vsix)} threshold!`);
			errors++;
		} else {
			console.log(`  ✅ VSIX under ${fmtBytes(THRESHOLDS.vsix)} threshold`);
		}
	}
}
if (!foundVsix) {
	console.log("  (none — run `npm run package` first)");
}

// 3. Summary
const summary =
	errors === 0 ? "✅ All size checks passed" : "❌ " + errors + " size check(s) failed";
console.log("\n" + summary);
process.exit(errors > 0 ? 1 : 0);
