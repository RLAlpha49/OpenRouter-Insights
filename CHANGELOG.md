# Changelog

## [1.2.0](https://github.com/RLAlpha49/OpenRouter-Insights/compare/v1.1.0...v1.2.0) (2026-08-15)

### ✨ Features

* **features:** gate commands and views by feature state ([6ea0ef1](https://github.com/RLAlpha49/OpenRouter-Insights/commit/6ea0ef15530ff24c5b78bcd7e4f6f13ccd28bb09))
* **ui:** add catalog and favorites browsing ([c28629a](https://github.com/RLAlpha49/OpenRouter-Insights/commit/c28629a556069c620870e8b382046485d7e04507))
* **ui:** enhance model detail actions and pricing ([6e533e4](https://github.com/RLAlpha49/OpenRouter-Insights/commit/6e533e443e4e2e5da634be3a261b71a849d7cde7))
* **ui:** streamline command and model actions ([4db6ae4](https://github.com/RLAlpha49/OpenRouter-Insights/commit/4db6ae4b73084e2378443c19d615e46c7537c2dd))

### 🐛 Bug Fixes

* **api:** enforce endpoint contracts in transport ([99aac7b](https://github.com/RLAlpha49/OpenRouter-Insights/commit/99aac7b2bb9651a7262129884faa61e06c5fbc2c))
* **api:** preserve zero-priced cache components ([4934b75](https://github.com/RLAlpha49/OpenRouter-Insights/commit/4934b758e97d76c0984d457b7cf0c0108151a14d))
* **api:** refresh pricing on startup even with fresh cache ([22a777d](https://github.com/RLAlpha49/OpenRouter-Insights/commit/22a777d097044b7888beded45185b3192efbf21c))
* **commands:** handle synchronous argument adapter failures ([94c3460](https://github.com/RLAlpha49/OpenRouter-Insights/commit/94c34600ab8d6d4fe410fffbda492f5724d16e62))
* **commands:** recover synchronous execution failures ([109c368](https://github.com/RLAlpha49/OpenRouter-Insights/commit/109c3688687988ad6214bda5d5dd642bfcebaacc))
* **formatting:** format timestamps in local time zone ([088682a](https://github.com/RLAlpha49/OpenRouter-Insights/commit/088682a18dec19d5f0b446ab6bedf72317a0c28d))
* **notifications:** auto-dismiss information messages ([7b43226](https://github.com/RLAlpha49/OpenRouter-Insights/commit/7b43226dd57f399f4b1a28c7940132ab72a28e30))
* **privacy:** redact sensitive state database logs ([45abdb0](https://github.com/RLAlpha49/OpenRouter-Insights/commit/45abdb09cf8a6c3caa032f45e95ae841dbcbd286))
* **release:** align changelog dependency compatibility ([8caf69a](https://github.com/RLAlpha49/OpenRouter-Insights/commit/8caf69ae55e9fc08ef3c6ea1b9b3ff89f49fb827))
* **runtime:** harden refresh cancellation and diagnostics ([da2ae5e](https://github.com/RLAlpha49/OpenRouter-Insights/commit/da2ae5ebe3efe6d1874f9f39b680d53af138b4df))
* **state-db:** stabilize WAL snapshot reads ([0da2fc4](https://github.com/RLAlpha49/OpenRouter-Insights/commit/0da2fc45a8b31a61ae6bfc81af5c3008173a46a9))
* **status-bar:** preserve rendered content after refresh ([272eff5](https://github.com/RLAlpha49/OpenRouter-Insights/commit/272eff54cf95897d77d6257bf1de696d466a1762))
* **status-bar:** refresh status bar when pricing changes ([410b971](https://github.com/RLAlpha49/OpenRouter-Insights/commit/410b9713eacfa698fa5ea1b5b017d08ef489f198))
* **ui:** improve webview accessibility and theme compatibility ([57fdb57](https://github.com/RLAlpha49/OpenRouter-Insights/commit/57fdb57d43b0390b56828e55bc6e15ec70d438cf))

### ⚡ Performance

* **api:** bound pricing page cache ([8f98979](https://github.com/RLAlpha49/OpenRouter-Insights/commit/8f98979d021156945ec34c8d7f98a8eb83d8b61a))

### ♻️ Refactoring

* **config:** consolidate favorites under model browser ([1b658da](https://github.com/RLAlpha49/OpenRouter-Insights/commit/1b658da92a4243853c40b824b1e3dbe16cc479b8))

### 📚 Documentation

* clarify telemetry and authenticated requests ([1a9418a](https://github.com/RLAlpha49/OpenRouter-Insights/commit/1a9418adf5008e88d340f83119dd47d8f86173fc))
* **diagnostics:** document runtime diagnostics command ([d35daf6](https://github.com/RLAlpha49/OpenRouter-Insights/commit/d35daf6189699f4550bac4bd8ec761dbd7f06309))
* document usage dashboard analytics ([a237ff0](https://github.com/RLAlpha49/OpenRouter-Insights/commit/a237ff0bfbd0b824aac6348be58660e30713b524))
* **release:** document 1.1.0 release changes ([ee8ca4a](https://github.com/RLAlpha49/OpenRouter-Insights/commit/ee8ca4a7584497d35874413f926fc73a4c0298c1))

### 💎 Style

* **status-bar:** format price change test ([211ddb2](https://github.com/RLAlpha49/OpenRouter-Insights/commit/211ddb25a33b01a569f3827cf5837dd33f68e11c))
* **ui:** remove ambient webview glow ([ed2813e](https://github.com/RLAlpha49/OpenRouter-Insights/commit/ed2813ed5349f4537f5f4ec6189daa3c4bfc8ead))

### 📦 Build

* **vscode:** add format task ([d5765c5](https://github.com/RLAlpha49/OpenRouter-Insights/commit/d5765c5c94a79b7afae44c44788b28dad368f7ee))

### 🧪 Tests

* **sqlite-reader:** extend WAL and scan diagnostics coverage ([15ac0b9](https://github.com/RLAlpha49/OpenRouter-Insights/commit/15ac0b989e23f915be4e4257d6884707ab9366b5))
* **status-bar:** import vitest helpers ([6459116](https://github.com/RLAlpha49/OpenRouter-Insights/commit/6459116b449a0dffeaf7724c2e6bf333f0d2421d))

## [1.1.0](https://github.com/RLAlpha49/OpenRouter-Insights/compare/v1.0.0...v1.1.0) (2026-08-11)

### ✨ Features

* **api:** centralize OpenRouter endpoint contracts ([333b1b](https://github.com/RLAlpha49/OpenRouter-Insights/commit/333b1b08b19ca40f160eb6f538da10d6c194786a))
* **diagnostics:** add runtime diagnostics reporting ([330687](https://github.com/RLAlpha49/OpenRouter-Insights/commit/3306879737022be558e0500eaaa230fc102b6805))
* **infrastructure:** coalesce overlapping scheduled usage ticks ([59cab4](https://github.com/RLAlpha49/OpenRouter-Insights/commit/59cab4840fd67c2fac66d2b0b0883aac9e0349e7))
* **ui:** preserve dashboard state during partial updates ([20d57f](https://github.com/RLAlpha49/OpenRouter-Insights/commit/20d57f1c9e9eecb54934aa87b4cf026d16ef88f6))
* **ui:** standardize formatting and motion behavior ([4e4837](https://github.com/RLAlpha49/OpenRouter-Insights/commit/4e4837e1b8ee25a2039d456943004302ae397085))

### 🐛 Bug Fixes

* **api:** harden pricing cache and fetch validation ([b7ab52](https://github.com/RLAlpha49/OpenRouter-Insights/commit/b7ab5276232a706992367f623ab20dfe26384596))
* **api:** invalidate stale credential-derived usage data ([4f7484](https://github.com/RLAlpha49/OpenRouter-Insights/commit/4f7484491aadc6b167ceb874da1b8b7441a7a56c))
* **config:** restrict custom API base URLs ([e7c7a7](https://github.com/RLAlpha49/OpenRouter-Insights/commit/e7c7a77f662628c6240773c88903e178437c5175))
* **models:** handle WAL-incomplete reads without publishing stale values ([31c40e](https://github.com/RLAlpha49/OpenRouter-Insights/commit/31c40e6aa0bdb43ed433be963bb3b358c48b6b0b))
* **models:** harden WAL-aware state database reads ([f3a07c](https://github.com/RLAlpha49/OpenRouter-Insights/commit/f3a07c800d9666cc2f12f93bdcbff133d57a7ea2))
* **models:** propagate state DB errors instead of swallowing ([1e41ae](https://github.com/RLAlpha49/OpenRouter-Insights/commit/1e41ae4d248174818eb159ab7318c26dd1a8439a))

### ♻️ Refactoring

* **api:** split usage client responsibilities ([263fd3](https://github.com/RLAlpha49/OpenRouter-Insights/commit/263fd3399aaca925bc1b895af0686d08ab29ab4c))
* **infrastructure:** centralize activation and feature lifecycle ([5fcb3f](https://github.com/RLAlpha49/OpenRouter-Insights/commit/5fcb3f5f914c244f05ac6f97e3bbfe82ada37bf6))
* **models:** StateDbReader owns cache and diagnostic state ([5dd730](https://github.com/RLAlpha49/OpenRouter-Insights/commit/5dd730d5ce77f2f725f60ba834bebb9cff301b27))
* **ui:** remove unused analytics debug logging ([e7a39a](https://github.com/RLAlpha49/OpenRouter-Insights/commit/e7a39ac26199c715988dc7d114f99dd5911cb8b8))

### 📚 Documentation

* document composition root and host boundaries ([837523](https://github.com/RLAlpha49/OpenRouter-Insights/commit/837523e8856ed4dff89769b53d8c0c98c5d5c5c4))
* document data retention and deletion ([f5e5ce](https://github.com/RLAlpha49/OpenRouter-Insights/commit/f5e5cebcfedded821a93374ff472fd85902a2f4d))
* update architecture for refresh coordinator and SQLite reader ([7df31d](https://github.com/RLAlpha49/OpenRouter-Insights/commit/7df31d72527e107d2f27451bc6598c2ae49e8580))

### 💎 Style

* clean up changed source formatting ([e0d69e](https://github.com/RLAlpha49/OpenRouter-Insights/commit/e0d69ebb44df8d65d1b7dc876380479851655d8c))

### 📦 Build

* **release:** harden packaging and dependency validation ([46cda1](https://github.com/RLAlpha49/OpenRouter-Insights/commit/46cda1021afb178e4306c185da7fb20244cf4eb8))

### 🔧 CI/CD

* **dependabot:** configure grouped dependency updates ([38b113](https://github.com/RLAlpha49/OpenRouter-Insights/commit/38b113e1c99110f3d1c9c1d21a2282b30d46f7d1))
* enforce manifest documentation checks ([a74e29](https://github.com/RLAlpha49/OpenRouter-Insights/commit/a74e29e4d76a27bc34542a441ad51b67c607df96))

### 🧪 Tests

* cover usage safety and edge cases ([bf44d1](https://github.com/RLAlpha49/OpenRouter-Insights/commit/bf44d1159c119db2ddd8b1d51aadda5913768413))
* **ui:** cover dashboard interactions and policies ([07e7ea](https://github.com/RLAlpha49/OpenRouter-Insights/commit/07e7ea90217dc0d564fb31b1fd07722e70658bfa))

## 1.0.0 (2026-08-08)

* Add OpenRouter model pricing to the VS Code status bar.
* Detect the active Copilot model from local VS Code state, with file watching and polling fallback.
* Add a model browser with sorting, favorites, free-model filtering, and deprecated-model filtering.
* Add model details, side-by-side comparison, model overrides, pricing hovers, and OpenRouter links.
* Add pricing refresh, local caching, CSV export, and JSON export.
* Add account balance and usage tracking with status bar and dashboard views.
* Add configurable background refresh, low-balance warnings, budget limits, activity details, and optional analytics.
* Store the extension API key with VS Code `SecretStorage`.
* Add managed OpenRouter API key operations for users with a management key.
* Add privacy protections for API keys, bearer tokens, logs, and network requests.
