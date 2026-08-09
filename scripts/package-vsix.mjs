import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const artifact = `openrouter-insights-${packageJson.version}.vsix`;
const artifactPath = join(root, artifact);

// Package to a temporary path so a failed packaging run never leaves a
// misleading partially generated artifact in place of a prior good one.
const tempPath = join(root, `.${artifact}.tmp`);

rmSync(tempPath, { force: true });
const result = spawnSync(
	process.execPath,
	[join(root, "node_modules", "@vscode", "vsce", "vsce"), "package", "--out", tempPath],
	{
		cwd: root,
		stdio: "inherit",
	},
);
if (result.status !== 0) {
	rmSync(tempPath, { force: true });
	process.exit(result.status ?? 1);
}
if (!existsSync(tempPath)) {
	throw new Error(`VSIX packaging did not create ${tempPath}`);
}

// Only replace the final artifact after packaging succeeded.
rmSync(artifactPath, { force: true });
renameSync(tempPath, artifactPath);

// Drop artifacts left over from other versions. The release asset globs in
// release.config.mjs and the size gate then have exactly one candidate: the
// artifact this run just produced.
const artifactPattern = /^openrouter-insights-.+\.vsix(\.sha256)?$/i;
for (const entry of readdirSync(root)) {
	if (!artifactPattern.test(entry) || entry === artifact || entry === `${artifact}.sha256`) {
		continue;
	}

	rmSync(join(root, entry), { force: true });
	console.log(`Removed stale VSIX artifact: ${entry}`);
}

console.log(`Created verified VSIX artifact: ${artifact}`);
