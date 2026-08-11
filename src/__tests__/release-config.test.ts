import { describe, expect, it } from "vitest";

// @ts-expect-error The JavaScript release configuration has no declaration file.
import releaseConfig from "../../release.config.mjs";

describe("semantic-release changelog configuration", () => {
	it("includes commits in generated release notes", async () => {
		const notesPlugin = releaseConfig.plugins?.find(
			(plugin: unknown) =>
				Array.isArray(plugin) && plugin[0] === "@semantic-release/release-notes-generator",
		);
		const pluginConfig = Array.isArray(notesPlugin) ? notesPlugin[1] : {};
		// @ts-expect-error The plugin does not publish TypeScript declarations.
		const { generateNotes } = await import("@semantic-release/release-notes-generator");
		const notes = await generateNotes(pluginConfig, {
			commits: [{ message: "feat: add a generated changelog entry", hash: "abc1234" }],
			lastRelease: { version: "1.0.0", gitTag: "v1.0.0" },
			nextRelease: { version: "1.1.0", gitTag: "v1.1.0" },
			options: { repositoryUrl: "https://github.com/RLAlpha49/OpenRouter-Insights" },
			cwd: process.cwd(),
		});

		expect(notes).toContain("add a generated changelog entry");
		expect(notes).toContain("### ✨ Features");
	});
});
