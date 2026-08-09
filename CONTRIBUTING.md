# Contributing to OpenRouter Insights

Thanks for contributing to OpenRouter Insights. This guide covers the local workflow, source layout, extension seams, tests, and releases.

## Setup

```bash
git clone https://github.com/RLAlpha49/OpenRouter-Insights.git
cd OpenRouter-Insights
npm install
```

**Requirements:** Node.js >= 22, VS Code >= 1.90

> **Node.js version:** The development and release toolchain targets Node.js 22. `package.json` declares `engines.node >= 22`, and the release workflow uses Node.js 22. Keep these aligned when upgrading dependencies.

**TypeScript compiler:** `package.json` maps two aliases for the compiler:

- `typescript` → `@typescript/typescript6` — the authoritative compiler used by `npm run typecheck` and the build.
- `@typescript/native` → `typescript@^7` — an experimental native-image alternative that is not wired into build or CI commands.

Use the `typescript` alias for local checks so local and CI results match.

## Development workflow

| Task                         | Command                    |
| ---------------------------- | -------------------------- |
| Build (production)           | `npm run build`            |
| Build (dev, with sourcemaps) | `npm run bundle`           |
| Watch & rebuild on change    | `npm run bundle:watch`     |
| Run tests                    | `npm run test`             |
| Run tests in watch mode      | `npm run test:watch`       |
| Run tests with coverage      | `npm run test:coverage`    |
| Lint                         | `npm run lint`             |
| Auto-fix lint issues         | `npm run lint:fix`         |
| Format code                  | `npm run format`           |
| Check formatting             | `npm run format:check`     |
| Type-check without emitting  | `npm run typecheck`        |
| Package VSIX                 | `npm run package:verified` |
| Check bundle size            | `npm run size`             |
| Check bundle and VSIX size   | `npm run size:package`     |
| Audit dependencies           | `npm run audit:deps`       |

### Running the extension

1. Press **F5** in VS Code (launch config at `.vscode/launch.json`).
2. This opens an **Extension Development Host** window with OpenRouter Insights loaded.

### VS Code Tasks

The following tasks are available in `.vscode/tasks.json`:

| Task Label       | Command             | Description                            |
| ---------------- | ------------------- | -------------------------------------- |
| `npm: build`     | `npm run build`     | Production build with minification     |
| `npm: typecheck` | `npm run typecheck` | TypeScript type-check without emitting |

### Launch Configurations

The following launch configurations are available in `.vscode/launch.json`:

| Configuration                         | Pre-Launch Task | Description                                                      |
| ------------------------------------- | --------------- | ---------------------------------------------------------------- |
| `Run Extension`                       | `npm: bundle`   | Launch Extension Development Host with the extension             |
| `Run Extension (no other extensions)` | `npm: bundle`   | Launch Extension Development Host with other extensions disabled |
| `Run Tests`                           | (none)          | Run Vitest test suite in integrated terminal                     |

### Project structure

See [`docs/architecture.md`](docs/architecture.md) for a detailed architecture
overview, component diagram, and data flow description.

```text
src/
  extension.ts              Extension activate/deactivate entry point
  types.ts                  Core domain types (ModelPricingInfo, etc.)
  types-usage.ts            Usage & credits domain types
  __tests__/                Test files (mirror src/ structure)
    __mocks__/vscode.ts     VS Code API mock for tests
  api/                      External API integration
    pricingService.ts       Fetch & parse OpenRouter /models endpoint
    pricingCache.ts         GlobalState-backed pricing cache
    pricingStore.ts         Store interfaces
    usageService.ts         Fetch usage/credits/key-management
    usageStore.ts           Usage data cache
    secretStorageService.ts VS Code SecretStorage wrapper
    httpClient.ts           HttpClient interface
    httpPipeline.ts         Composable HTTP middleware pipeline
    fetchHelpers.ts         Shared retry/error-classification helpers
    analyticsService.ts     Analytics query endpoint integration
  infrastructure/           Composition root & wiring
    services.ts             ServiceContainer — IoC container
    config.ts               ConfigService — typed, validated settings
    commandRegistrar.ts     Auto-registers commands with VS Code
    commands.ts             ICommand implementations (pricing/model)
    usageCommands.ts        ICommand implementations (usage/key)
    eventBus.ts             In-process event bus
    featureRegistry.ts      Feature-flag gating
    logger.ts               Output-channel logger
    configurationObserver.ts Config change observer
    modelPollingService.ts  Timer + coalesced model-check loop
    usagePollingService.ts  Usage refresh timer
    refreshScheduler.ts     Auto-refresh interval scheduler
    stateDbWatcher.ts       File-watcher for Copilot state DB
  models/                   Domain model & SQLite layer
    domain.ts               Blend-rate, deprecation logic
    modelResolver.ts        Pulls model info from Copilot
    modelNameDeriver.ts     Display names from model IDs
    sqliteReader.ts         Zero-dependency SQLite page reader
    sqlModelParser.ts       Parses Copilot model-config
    stateDbLocator.ts       Finds Copilot's state.vscdb
    stateDbReader.ts        Reads model-config rows from state DB
  ui/                       UI layer (webviews, status bar, formatting)
    statusBarView.ts        Pricing status bar item
    statusBarTemplate.ts    User-configurable template engine
    usageStatusBarView.ts   Usage/credits status bar item
    usageDashboard.ts       Activity-bar dashboard webview + expanded panel
    modelPickerEnhancer.ts  QuickPick model browser/comparison
    modelHoverProvider.ts   Hover provider for model IDs
    modelDetailView.ts      Single-model detail webview
    comparisonViewService.ts Side-by-side comparison webview
    costIconFactory.ts      Cost-tier icon mapping
    currencyService.ts      Currency conversion (static rates)
    exportService.ts        CSV / JSON export
    formatting.ts           Number formatting, truncation
    escapeHtml.ts           XSS-safe HTML escaping
    webviewTheme.ts         Shared design system CSS
  use-cases/                Application use cases (orchestration)
    refreshUseCase.ts       Full pricing refresh
    statusBarUpdateUseCase.ts Resolve model → render status bar
    usageRefreshUseCase.ts  Usage/credits refresh
```

### How to add a new command

The command wiring has three runtime steps. Keep them in sync or the command can compile without being registered:

1. **Manifest** — Add the command definition to `package.json` under
   `contributes.commands` (id, title, icon, category).
2. **Implementation** — Create a class implementing `ICommand` in
   `src/infrastructure/commands.ts` (pricing/model commands) or
   `src/infrastructure/usageCommands.ts` (usage commands). Give it an
   `argAdapter` so the registration boundary preserves its argument contract:
   - `adaptNoArgs` — no positional arguments.
   - `adaptModelId` — one optional model ID string.
   - `adaptKeyHash` — one optional key-hash string.
   - `adaptOptionalScalar` — one optional string/boolean argument.
3. **Registration** — Wire it in the composition root `src/infrastructure/services.ts`
   with `addCmd(new YourCommand(...))`. `commandRegistrar.ts` calls the command's
   `argAdapter` on the raw VS Code `unknown[]` before invoking the typed
   `execute(...)`, so argument mismatches fail at registration rather than inside
   the handler.
4. **Discovery metadata** — Set `quickAction` metadata for Quick Actions visibility. `CommandRegistrar` handles the VS Code boundary and argument adapter.

### How to add a new config setting

1. Add the property definition to `package.json` under
   `contributes.configuration.properties`.
2. Add a getter in `src/infrastructure/config.ts` — add it to the `ReadonlyConfig`
   interface and implement it on `ConfigService` with validation.
3. Use the module-level convenience function or `ConfigService.instance` from consumers.

### How to add a new feature flag

1. Add the setting to `package.json` under `contributes.configuration.properties`.
2. Add the feature identifier and prefix mapping to `src/infrastructure/featureRegistry.ts`.
3. Check `svc.features.isEnabled("yourFeature")` at non-command call sites. Commands are gated by their command ID and feature mapping.

### Testing conventions

Tests mirror the source areas under `src/__tests__/`: API, infrastructure, models, use-cases,
and UI. For example, usage integration tests are in
`src/__tests__/api/usage-service.integration.test.ts`, lifecycle tests are in
`src/__tests__/infrastructure/extension-lifecycle.test.ts`, and state database tests are in
`src/__tests__/models/state-db-reader.test.ts`. Use `npm test -- <path>` for a focused run.
Use fake `HttpClient` implementations and the VS Code API mock at
`src/__tests__/__mocks__/vscode.ts` where needed. Coverage reports with `npm run test:coverage`.

### Code style

- **Tabs** for indentation, **double quotes** for strings.
- All new code must pass `npm run lint` and `npm run typecheck`.
- Use `log.debug()`, `log.info()`, `log.warn()`, `log.error()` for logging.
- Follow existing patterns: constructor injection, interface-based contracts,
  command pattern for VS Code commands.

## Release process

Releases run automatically from pushes to `main` or `master` through the protected
`release` GitHub Environment via [semantic-release](https://semantic-release.org/).

1. A merge to `main` or `master` starts the release workflow.
2. Conventional commit messages determine the version bump:
   - `feat:` → minor
   - `fix:`, `docs:`, `refactor:` → patch
   - `BREAKING CHANGE:` in body → major
3. Changelog is auto-generated, GitHub Release created, and VSIX published.
4. Run `npm run release:dry` locally to preview the next release.

`npm run release:dry` is a **best-effort local preview** only — it has no access to
release credentials or CI metadata, so it cannot exercise the real publishing path.
The **authoritative** release behavior (version bump, Marketplace publish, GitHub
Release assets, and VSIX checksum verification) is produced by the tagged
`Release` workflow on push to `main`/`master` or manual dispatch, which runs in the
credentialed `release` GitHub Environment. Always treat the workflow run as the source
of truth for GitHub, npm, and VSIX publishing.

The release workflow reports lint, typecheck, tests, formatting, and dependency-audit results
as separate steps. Packaging, checksumming, and the size gate are owned by `semantic-release`,
which runs `npm run package:verified` through its `prepareCmd`. That command uses the locked
`@vscode/vsce` dependency, produces `openrouter-insights-<version>.vsix` plus its SHA-256
checksum, and measures those exact files. The workflow requires `VSCE_PAT` through the
protected `release` environment before publishing. GitHub Actions are updated by Dependabot and
reviewed before workflow changes are merged.

### Artifact and size gates

Size checks always name the artifact they measure, so a check can neither pass on a stale
workspace file nor silently skip a missing one:

| Command                    | Measures                                                | Fails when                            |
| -------------------------- | ------------------------------------------------------- | ------------------------------------- |
| `npm run size`             | `out/` only                                              | `out/` is missing, empty, or over 5 MB |
| `npm run size:package`     | `out/` and `openrouter-insights-<version>.vsix`          | Either artifact is missing or over budget |
| `npm run package:verified` | Packages, checksums, then runs the bundle + VSIX gate    | Any packaging or size step fails       |

CI runs `npm run size` after `npm run bundle`, so it measures the bundle that job just built.
The VSIX budget is enforced on the packaging path, which is the only path that produces a VSIX.

To package a VSIX locally, use `npm run package:verified` for the checksum-producing path or
`npm run package:debug` for the direct `vsce package` path declared in `package.json`.

## Getting help

- Browse [`docs/architecture.md`](docs/architecture.md) for design decisions and data flow.
- Check the [OpenRouter API docs](https://openrouter.ai/docs) for API reference.
- Open an issue on GitHub for bugs or feature requests.
