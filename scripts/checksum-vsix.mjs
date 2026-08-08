import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const artifact = `openrouter-insights-${packageJson.version}.vsix`;
const artifactPath = join(root, artifact);
if (!existsSync(artifactPath)) {
	throw new Error(`Expected verified VSIX artifact ${artifact}`);
}

const digest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
const checksumPath = join(root, `${artifact}.sha256`);
writeFileSync(checksumPath, `${digest}  ${artifact}\n`);
console.log(`Created VSIX checksum: ${artifact}.sha256`);
