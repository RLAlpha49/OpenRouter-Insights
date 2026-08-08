/**
 * semantic-release configuration — fully automated releases with:
 *   - Conventional commit changelog generation
 *   - GitHub Releases
 *   - VSIX packaging for manual VS Code Marketplace upload
 *
 * Requires:
 *   - GITHUB_TOKEN (auto-provided by Actions)
 */

/** @type {import('semantic-release').GlobalConfig} */
export default {
	branches: ["main", "master"],
	plugins: [
		[
			"@semantic-release/commit-analyzer",
			{
				preset: "conventionalcommits",
				releaseRules: [
					{ type: "security", release: "patch" },
					{ type: "build", scope: "deps", release: "patch" },
				],
			},
		],
		// Generate release notes from commits
		[
			"@semantic-release/release-notes-generator",
			{
				preset: "conventionalcommits",
				presetConfig: {
					types: [
						{ type: "feat", section: "✨ Features" },
						{ type: "fix", section: "🐛 Bug Fixes" },
						{ type: "perf", section: "⚡ Performance" },
						{ type: "refactor", section: "♻️ Refactoring" },
						{ type: "docs", section: "📚 Documentation" },
						{ type: "style", section: "💎 Style" },
						{ type: "build", section: "📦 Build" },
						{ type: "ci", section: "🔧 CI/CD" },
						{ type: "test", section: "🧪 Tests" },
						{ type: "chore", section: "🧹 Chores", hidden: true },
					],
				},
			},
		],
		// Update package.json without publishing this VS Code extension to npm.
		["@semantic-release/npm", { npmPublish: false }],
		// Update CHANGELOG.md
		[
			"@semantic-release/changelog",
			{
				changelogFile: "CHANGELOG.md",
				changelogTitle: "# Changelog",
			},
		],
		[
			"@semantic-release/exec",
			{
				prepareCmd: "npm run package:verified",
			},
		],
		[
			"@semantic-release/github",
			{
				assets: [
					{ path: "openrouter-insights-*.vsix", label: "VSIX Extension Package" },
					{ path: "openrouter-insights-*.vsix.sha256", label: "VSIX SHA-256 checksum" },
				],
			},
		],
		[
			"@semantic-release/git",
			{
				assets: ["CHANGELOG.md", "package.json", "package-lock.json"],
				message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
	],
};
