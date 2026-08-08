import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import prettier from "prettier";

const root = resolve("src/ui/assets");
const generated = resolve("src/ui/generated");
mkdirSync(generated, { recursive: true });

const assets = [
	{ source: "designSystemCssSource", file: "webview-theme.css" },
	{ source: "bridgeScriptSource", file: "webview-bridge.js" },
	{ source: "comparisonDocument", file: "model-comparison.html" },
	{ source: "detailDocument", file: "model-detail.html" },
	{ source: "dashboardDocument", file: "usage-dashboard.html" },
	{ source: "dashboardWideDocument", file: "usage-dashboard-wide.html" },
];

const modules = assets
	.map(({ source, file }) => {
		return `export const ${source} = ${JSON.stringify(readFileSync(resolve(root, file), "utf8"))};`;
	})
	.join("\n");

const generatedFile = resolve(generated, "webviewAssets.generated.ts");
const config = await prettier.resolveConfig(generatedFile);
const formatted = await prettier.format(`${modules}\n`, {
	...config,
	filepath: generatedFile,
});

writeFileSync(generatedFile, formatted);
