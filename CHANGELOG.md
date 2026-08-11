# Changelog

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
