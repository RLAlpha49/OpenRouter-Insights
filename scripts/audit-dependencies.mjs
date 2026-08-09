/**
 * Dependency vulnerability gate.
 *
 * Runs two audits with two documented severity policies instead of a single
 * `npm audit --omit=dev` call, so the build and release toolchain is covered
 * by the gate and not only the shipped runtime graph.
 *
 *   production   `npm audit --omit=dev`   fails at moderate and above.
 *                The extension ships this graph to users, so it is held to the
 *                strictest policy. It currently contains no runtime packages,
 *                and it must stay clean.
 *
 *   development  `npm audit` (full graph)  fails at critical and above.
 *                TypeScript, esbuild, Vitest, ESLint, semantic-release, and the
 *                VSIX tooling execute in CI and produce the released artifact,
 *                so they are audited. Their advisories are mostly denial of
 *                service issues inside vendored CLI trees with no forward fix,
 *                so high and below are reported for triage rather than being
 *                treated as release blockers.
 *
 * Usage:
 *   node scripts/audit-dependencies.mjs                     Run both scopes
 *   node scripts/audit-dependencies.mjs --scope=production  Run one scope
 *   node scripts/audit-dependencies.mjs --scope=development
 */

import { spawnSync } from "node:child_process";

const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];

/**
 * The executable policy. Keep this table and the dependency policy section of
 * `CONTRIBUTING.md` in sync.
 */
const SCOPES = {
	production: {
		label: "Production (runtime) dependencies",
		npmArgs: ["--omit=dev"],
		failAt: "moderate",
	},
	development: {
		label: "Full graph including development and build dependencies",
		npmArgs: [],
		failAt: "critical",
	},
};

/**
 * @param {string[]} argv
 * @returns {{ scopes: string[] }}
 */
function parseArgs(argv) {
	const requested = [];

	for (const arg of argv) {
		if (arg.startsWith("--scope=")) {
			const value = arg.slice("--scope=".length);
			if (!Object.hasOwn(SCOPES, value)) {
				throw new Error(`Unknown scope "${value}". Expected one of: ${Object.keys(SCOPES).join(", ")}`);
			}
			requested.push(value);
			continue;
		}

		throw new Error(`Unknown argument "${arg}". Usage: node scripts/audit-dependencies.mjs [--scope=production|development]`);
	}

	return { scopes: requested.length > 0 ? requested : Object.keys(SCOPES) };
}

/**
 * Run `npm audit --json`. npm exits non-zero when it finds vulnerabilities at
 * or above its own default level, so the exit code is ignored here and the
 * policy decision is made from the parsed report.
 *
 * @param {string[]} extraArgs
 * @returns {unknown}
 */
function runNpmAudit(extraArgs) {
	const args = ["audit", "--json", ...extraArgs];
	const npmExecPath = process.env.npm_execpath;
	const result = npmExecPath?.endsWith(".js")
		? spawnSync(process.execPath, [npmExecPath, ...args], { encoding: "utf8" })
		: spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
				encoding: "utf8",
				shell: process.platform === "win32",
			});

	if (result.error) {
		throw new Error(`Failed to run npm audit: ${result.error.message}`);
	}

	const stdout = result.stdout?.trim() ?? "";
	if (!stdout) {
		throw new Error(`npm audit produced no output.\n${result.stderr ?? ""}`);
	}

	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error(`npm audit did not return JSON.\n${stdout.slice(0, 2000)}`);
	}
}

/**
 * Flatten an npm audit v2 report into one record per advisory.
 *
 * @param {any} report
 * @returns {{ package: string, severity: string, title: string, url: string, paths: string[] }[]}
 */
function collectAdvisories(report) {
	const vulnerabilities = report?.vulnerabilities;
	if (!vulnerabilities || typeof vulnerabilities !== "object") {
		throw new Error("npm audit report is missing the vulnerabilities map.");
	}

	const byKey = new Map();
	for (const [name, entry] of Object.entries(vulnerabilities)) {
		for (const via of entry?.via ?? []) {
			// String entries point at another vulnerable package that is already
			// reported under its own key, so only advisory objects are collected.
			if (typeof via !== "object" || via === null) {
				continue;
			}

			const key = `${via.name ?? name}|${via.source ?? via.url ?? via.title}`;
			if (byKey.has(key)) {
				continue;
			}

			byKey.set(key, {
				package: via.name ?? name,
				severity: SEVERITY_ORDER.includes(via.severity) ? via.severity : "info",
				title: via.title ?? "unknown advisory",
				url: via.url ?? "",
				paths: Array.isArray(entry.nodes) ? entry.nodes : [],
			});
		}
	}

	return [...byKey.values()].sort(
		(left, right) =>
			SEVERITY_ORDER.indexOf(right.severity) - SEVERITY_ORDER.indexOf(left.severity) ||
			left.package.localeCompare(right.package),
	);
}

/**
 * @param {string} scopeName
 * @returns {number} Number of blocking advisories.
 */
function auditScope(scopeName) {
	const scope = SCOPES[scopeName];
	const threshold = SEVERITY_ORDER.indexOf(scope.failAt);
	const report = runNpmAudit(scope.npmArgs);
	const advisories = collectAdvisories(report);
	const blocking = advisories.filter((advisory) => SEVERITY_ORDER.indexOf(advisory.severity) >= threshold);
	const reported = advisories.filter((advisory) => SEVERITY_ORDER.indexOf(advisory.severity) < threshold);
	const counts = report?.metadata?.vulnerabilities ?? {};

	console.log(`=== ${scopeName} — ${scope.label} ===`);
	console.log(`  policy: fail at ${scope.failAt} and above (npm audit ${scope.npmArgs.join(" ") || "<full graph>"})`);
	console.log(
		`  vulnerable packages: critical ${counts.critical ?? 0}, high ${counts.high ?? 0}, moderate ${counts.moderate ?? 0}, low ${counts.low ?? 0}, info ${counts.info ?? 0}`,
	);
	console.log(`  advisories: ${advisories.length}`);

	for (const advisory of blocking) {
		console.error(`  ❌ ${advisory.severity.padEnd(8)} ${advisory.package} — ${advisory.title}`);
		if (advisory.url) {
			console.error(`     ${advisory.url}`);
		}
		if (advisory.paths.length > 0) {
			console.error(`     path: ${advisory.paths.slice(0, 3).join(", ")}`);
		}
	}

	for (const advisory of reported) {
		console.log(`  ⚠️  ${advisory.severity.padEnd(8)} ${advisory.package} — ${advisory.title} (below the ${scopeName} threshold)`);
	}

	if (blocking.length === 0) {
		console.log(`  ✅ No advisories at or above ${scope.failAt}`);
	}

	console.log("");
	return blocking.length;
}

// ── Main ──────────────────────────────────────────────────

let options;
try {
	options = parseArgs(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

let blockingTotal = 0;
for (const scopeName of options.scopes) {
	try {
		blockingTotal += auditScope(scopeName);
	} catch (error) {
		console.error(`❌ ${scopeName} audit could not complete: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

if (blockingTotal > 0) {
	console.error(`❌ Dependency audit failed: ${blockingTotal} advisory(ies) at or above the configured threshold.`);
	console.error("   Update the affected packages, or record the decision in the dependency policy section of CONTRIBUTING.md.");
	process.exit(1);
}

console.log("✅ Dependency audit passed for: " + options.scopes.join(", "));
