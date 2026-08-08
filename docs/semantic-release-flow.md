# Semantic Release Flow

## Workflow

1. GitHub Actions starts on a push to `main` or `master`, or from `workflow_dispatch`.
2. The workflow checks out the full repository history with `fetch-depth: 0`.
3. Dependencies are installed with `npm ci`.
4. The workflow checks `VSCE_PAT`, then runs linting, type checking, tests, coverage, formatting, VSIX packaging, size checks, and the dependency audit.
5. The workflow runs `npm run release`, which invokes semantic-release.
6. Semantic-release verifies the repository, release branch, credentials, and configured plugins.
7. `@semantic-release/commit-analyzer` reads Conventional Commits and selects the next version:
   - `fix:` normally creates a patch release.
   - `feat:` normally creates a minor release.
   - A breaking-change marker creates a major release.
   - This repository also treats `refactor`, `style`, and `README` documentation changes as patch releases.
8. `@semantic-release/release-notes-generator` creates release notes grouped into the configured sections.
9. `@semantic-release/npm` updates `package.json` to the next version. It uses `npmPublish: false`, so this extension is not published to npm.
10. `@semantic-release/changelog` updates `CHANGELOG.md`.
11. `@semantic-release/exec` runs `npm run package:verified`, which creates the versioned VSIX and its SHA-256 checksum.
12. `@semantic-release/git` commits the generated `package.json`, `package-lock.json`, and `CHANGELOG.md` changes.
13. Semantic-release creates and pushes the version tag, such as `v1.1.0`.
14. `@semantic-release/exec` runs `node scripts/publish-vsix.mjs`, which publishes the VSIX to the VS Code Marketplace using `VSCE_PAT`.
15. `@semantic-release/github` creates the GitHub Release and attaches the VSIX and checksum assets.

If the commit history does not contain a release-worthy change, semantic-release stops after commit analysis. It does not update files, create a tag, or publish an artifact.

## Local dry-run vs. authoritative release

`npm run release:dry` (`semantic-release --dry-run --no-ci`) is a **best-effort local preview only**. It runs without release credentials or CI metadata, so it cannot exercise the real Marketplace publishing or GitHub Release asset flow, and it never bumps the version or writes artifacts.

The **authoritative** release behavior is produced exclusively by the tagged `Release` workflow (push to `main`/`master` or `workflow_dispatch`), which runs in the credentialed `release` GitHub Environment with `VSCE_PAT`. That workflow owns the version bump, VSIX packaging via `npm run package:verified`, checksum verification in `scripts/publish-vsix.mjs`, Marketplace publishing, and GitHub Release creation. Always treat the workflow run as the source of truth; use the local dry-run only to sanity-check the next version and release notes.

## Release Plugins

The plugin order in `release.config.mjs` is intentional. Plugins run in series for each lifecycle step, and the changelog plugin must run before the git plugin so the generated changelog is included in the release commit.

The configured plugins are:

- `@semantic-release/commit-analyzer`
- `@semantic-release/release-notes-generator`
- `@semantic-release/npm` with `npmPublish: false`
- `@semantic-release/changelog`
- `@semantic-release/exec`
- `@semantic-release/github`
- `@semantic-release/git`

## Release Commit Loop Prevention

The release commit uses `[skip ci]` and the workflow also ignores commits containing `[skip ci]` or `chore(release)`. These safeguards prevent the generated release commit from starting another release.

## Important Failure Behavior

Semantic-release creates and pushes the Git tag before its publish plugins run. A later Marketplace or GitHub publishing failure can therefore leave the tag in the repository even though publishing did not finish. The release workflow should be rerun only after checking the failed step and the existing tag.

## Official Documentation

- [Semantic Release](https://semantic-release.org/)
- [Configuration](https://semantic-release.org/usage/configuration)
- [Semantic Release npm plugin](https://github.com/semantic-release/npm/blob/master/README.md)
