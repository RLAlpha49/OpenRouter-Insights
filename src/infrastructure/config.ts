import * as vscode from "vscode";
import { blendWeightsFromPercentages, type BlendWeights } from "../models/domain";

const CONFIG_SECTION = "openrouterInsights";

/** Minimal logger interface to avoid circular imports. */
interface ConfigLogger {
	warn(..._args: unknown[]): void;
}

// ── Module-level logger (set during activation) ────────────────
let _log: ConfigLogger = { warn: () => {} };

/** Inject a logger for ConfigService validation warnings. */
export function initConfigLogger(logger: ConfigLogger): void {
	_log = logger;
}

// ── Readonly Configuration Interface ───────────────────────────

/**
 * Read-only snapshot of extension configuration. All consumers should
 * depend on this interface (not ConfigService) for testability.
 * ConfigService implements it; fake implementations can be injected in tests.
 */
export interface ReadonlyConfig {
	readonly features: Readonly<Record<FeatureId, boolean>>;
	readonly autoRefreshInterval: number;
	readonly showInStatusBar: boolean;
	readonly statusBarMaxWidth: number;
	readonly selectedModelId: string;
	readonly blendWeights: BlendWeights;
	readonly providerFilter: ProviderFilter;
	readonly modelPollInterval: number;
	readonly statusBarClickAction: StatusBarClickAction;
	readonly showFreeModelsOnly: boolean;
	readonly modelBrowserSort: ModelBrowserSort;
	readonly logLevel: LogLevel;
	readonly favoriteModels: string[];
	readonly showDeprecatedModels: boolean;
	readonly apiBaseUrl: string;
	readonly apiOrigin: string;
	readonly statusBarTemplate: string;
	readonly currency: string;
	readonly currencyRate: number;
	readonly cacheTtlHours: number;
	readonly usageAutoRefreshInterval: number;
	readonly usageBackgroundPollingEnabled: boolean;
	readonly usageAnalyticsEnabled: boolean;
	readonly usageAnalyticsLookbackDays: number;
	readonly usageLowBalanceThreshold: number;
	readonly usageStatusBarEnabled: boolean;
	readonly usageShowDashboard: boolean;
	readonly usageStatusBarClickAction: UsageStatusBarClickAction;
}

export type ProviderFilter = "openrouterOnly" | "allProviders";

export type StatusBarClickAction = "browseModels" | "refreshPricing" | "showLogs" | "quickActions";

export type UsageStatusBarClickAction = "fullDashboard" | "sidebarDashboard" | "quickActions";

export type ModelBrowserSort =
	"blendedRate" | "promptPrice" | "completionPrice" | "contextLength" | "name";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const FEATURE_IDS = [
	"statusBar",
	"modelBrowser",
	"comparison",
	"export",
	"hoverProvider",
	"usage",
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

export function getAutoRefreshInterval(): number {
	return ConfigService.instance.autoRefreshInterval;
}

export function getShowInStatusBar(): boolean {
	return ConfigService.instance.showInStatusBar;
}

export function getStatusBarMaxWidth(): number {
	return ConfigService.instance.statusBarMaxWidth;
}

export function getSelectedModelId(): string {
	return ConfigService.instance.selectedModelId;
}

export function getBlendWeights(): BlendWeights {
	return ConfigService.instance.blendWeights;
}

export async function setSelectedModelId(id: string): Promise<void> {
	await ConfigService.instance.setSelectedModelId(id);
}

function percentage(value: number): number {
	if (!Number.isFinite(value) || value < 0 || value > 100) {
		_log.warn("ConfigService: blend weights must be between 0 and 100; using 0");
		return 0;
	}
	return value;
}

export function getProviderFilter(): ProviderFilter {
	return ConfigService.instance.providerFilter;
}

export function getModelPollInterval(): number {
	return ConfigService.instance.modelPollInterval;
}

export function getShowFreeModelsOnly(): boolean {
	return ConfigService.instance.showFreeModelsOnly;
}

export function getModelBrowserSort(): ModelBrowserSort {
	return ConfigService.instance.modelBrowserSort;
}

export function getLogLevel(): LogLevel {
	return ConfigService.instance.logLevel;
}

export function getFavoriteModels(): string[] {
	return ConfigService.instance.favoriteModels;
}

export function getShowDeprecatedModels(): boolean {
	return ConfigService.instance.showDeprecatedModels;
}

export function getApiBaseUrl(): string {
	return ConfigService.instance.apiBaseUrl;
}

/** Validate the public models URL against the provider trust boundary. */
export function isAllowedPublicApiBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.username || url.password || url.search || url.hash) return false;
		if (url.protocol === "https:" && url.hostname === "openrouter.ai" && !url.port) return true;
		return (
			url.protocol === "http:" &&
			(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
		);
	} catch {
		return false;
	}
}

export function getStatusBarTemplate(): string {
	return ConfigService.instance.statusBarTemplate;
}

export function getCurrency(): string {
	return ConfigService.instance.currency;
}

export function getCurrencyRate(): number {
	return ConfigService.instance.currencyRate;
}

/**
 * ConfigService — typed, cached, validated configuration access.
 *
 * Watches for configuration changes, invalidates the property cache,
 * and emits typed events so consumers can react to specific key changes
 * without subscribing to the raw VS Code configuration event themselves.
 *
 * Emits:
 *   onRefreshIntervalChanged — when general.autoRefreshInterval changes
 *   onDisplaySettingsChanged — when any statusBar or modelBrowser setting changes
 *   onPollIntervalChanged     — when general.modelPollInterval changes
 *   onAnyConfigChanged        — when any openrouterInsights setting changes
 *
 * Singleton via ConfigService.instance — created once during activation.
 */
export class ConfigService implements vscode.Disposable, ReadonlyConfig {
	private static _instance: ConfigService | undefined;

	static get instance(): ConfigService {
		ConfigService._instance ??= new ConfigService();
		return ConfigService._instance;
	}

	// ── typed event emitters ───────────────────────────────────
	private readonly _onRefreshIntervalChanged = new vscode.EventEmitter<void>();
	private readonly _onDisplaySettingsChanged = new vscode.EventEmitter<void>();
	private readonly _onPollIntervalChanged = new vscode.EventEmitter<void>();
	private readonly _onUsageDataSettingsChanged = new vscode.EventEmitter<void>();
	private readonly _onBlendWeightsChanged = new vscode.EventEmitter<void>();
	private readonly _onAnyConfigChanged = new vscode.EventEmitter<void>();
	private readonly _onFeatureChanged = new vscode.EventEmitter<FeatureId>();

	/** Fires when general.autoRefreshInterval changes. */
	readonly onRefreshIntervalChanged = this._onRefreshIntervalChanged.event;
	/** Fires when any statusBar.* or modelBrowser.* setting changes. */
	readonly onDisplaySettingsChanged = this._onDisplaySettingsChanged.event;
	/** Fires when general.modelPollInterval changes. */
	readonly onPollIntervalChanged = this._onPollIntervalChanged.event;
	/** Fires when usage polling or analytics collection settings change. */
	readonly onUsageDataSettingsChanged = this._onUsageDataSettingsChanged.event;
	/** Fires when any blend-weight setting changes. */
	readonly onBlendWeightsChanged = this._onBlendWeightsChanged.event;
	/** Fires when any openrouterInsights.* setting changes. */
	readonly onAnyConfigChanged = this._onAnyConfigChanged.event;
	/** Fires when a feature enablement setting changes. */
	readonly onFeatureChanged = this._onFeatureChanged.event;

	private readonly _disposables: vscode.Disposable[] = [];

	private constructor() {
		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (!e.affectsConfiguration(CONFIG_SECTION)) return;
				this._cache.clear();

				this._onAnyConfigChanged.fire();

				for (const feature of FEATURE_IDS) {
					if (e.affectsConfiguration(`${CONFIG_SECTION}.features.${feature}.enabled`)) {
						this._onFeatureChanged.fire(feature);
					}
				}

				if (e.affectsConfiguration(`${CONFIG_SECTION}.general.autoRefreshInterval`)) {
					this._onRefreshIntervalChanged.fire();
				}
				if (e.affectsConfiguration(`${CONFIG_SECTION}.general.modelPollInterval`)) {
					this._onPollIntervalChanged.fire();
				}
				if (
					e.affectsConfiguration(`${CONFIG_SECTION}.usage.backgroundPolling.enabled`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.usage.analytics.enabled`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.usage.analytics.lookbackDays`)
				) {
					this._onUsageDataSettingsChanged.fire();
				}
				if (e.affectsConfiguration(`${CONFIG_SECTION}.general.blendWeights`)) {
					this._onBlendWeightsChanged.fire();
				}
				if (
					e.affectsConfiguration(`${CONFIG_SECTION}.statusBar`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.modelBrowser`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.general`)
				) {
					this._onDisplaySettingsChanged.fire();
				}
			}),
		);
	}

	dispose(): void {
		for (const d of this._disposables) d.dispose();
		this._disposables.length = 0;
		this._onRefreshIntervalChanged.dispose();
		this._onDisplaySettingsChanged.dispose();
		this._onPollIntervalChanged.dispose();
		this._onUsageDataSettingsChanged.dispose();
		this._onBlendWeightsChanged.dispose();
		this._onAnyConfigChanged.dispose();
		this._onFeatureChanged.dispose();
		ConfigService._instance = undefined;
	}

	// ── property cache ──────────────────────────────────────────
	private readonly _cache = new Map<string, unknown>();

	private _get<T>(key: string, fallback: T, validate?: (_v: T) => T): T {
		if (this._cache.has(key)) return this._cache.get(key) as T;
		const config = getConfig();
		let value: T = config.get<T>(key, fallback);
		if (validate && value !== undefined) {
			try {
				value = validate(value);
			} catch {
				_log.warn(
					`ConfigService: "${key}" validation threw, using fallback ${JSON.stringify(fallback)}`,
				);
				value = fallback;
			}
		}
		this._cache.set(key, value);
		return value;
	}

	// ── validated getters ───────────────────────────────────────

	get features(): Readonly<Record<FeatureId, boolean>> {
		return Object.fromEntries(
			FEATURE_IDS.map((feature) => [feature, this.isFeatureEnabled(feature)]),
		) as Readonly<Record<FeatureId, boolean>>;
	}

	isFeatureEnabled(feature: FeatureId): boolean {
		return this._get<boolean>(`features.${feature}.enabled`, true, (value) => {
			if (typeof value !== "boolean") {
				_log.warn(
					`ConfigService: features.${feature}.enabled must be boolean, falling back to true`,
				);
				return true;
			}
			return value;
		});
	}

	get autoRefreshInterval(): number {
		return this._get<number>("general.autoRefreshInterval", 3600, (v) => {
			if (!Number.isFinite(v) || v < 0) {
				_log.warn("ConfigService: general.autoRefreshInterval must be >= 0, clamping to 3600");
				return 3600;
			}
			if (v > 0 && v < 300) {
				_log.warn(
					"ConfigService: general.autoRefreshInterval below minimum (300s), clamping to 300",
				);
				return 300;
			}
			if (v > 86400) {
				_log.warn(
					"ConfigService: general.autoRefreshInterval above maximum (86400s), clamping to 86400",
				);
				return 86400;
			}
			return v;
		});
	}

	get showInStatusBar(): boolean {
		return this._get<boolean>("statusBar.show", true);
	}

	get statusBarMaxWidth(): number {
		return this._get<number>("statusBar.maxWidth", 0, (v) => {
			if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
				_log.warn("ConfigService: statusBar.maxWidth must be >= 0, clamping to 0 (no cap)");
				return 0;
			}
			return Math.min(v, 100);
		});
	}

	get selectedModelId(): string {
		return this._get<string>("general.selectedModelId", "");
	}

	get blendWeights(): BlendWeights {
		const blendWeights = this._get<{
			prompt: number;
			completion: number;
			cacheRead: number;
			cacheWrite: number;
		}>("general.blendWeights", { prompt: 10, completion: 5, cacheRead: 80, cacheWrite: 5 }, (v) => {
			if (!v || typeof v !== "object") {
				_log.warn("ConfigService: blendWeights must be an object, using defaults");
				return { prompt: 10, completion: 5, cacheRead: 80, cacheWrite: 5 };
			}
			const prompt = percentage(v.prompt ?? 10);
			const completion = percentage(v.completion ?? 5);
			const cacheRead = percentage(v.cacheRead ?? 80);
			const cacheWrite = percentage(v.cacheWrite ?? 5);
			if (Math.abs(prompt + completion + cacheRead + cacheWrite - 100) > 0.001) {
				_log.warn("ConfigService: blend weights must total 100%; using defaults");
				return { prompt: 10, completion: 5, cacheRead: 80, cacheWrite: 5 };
			}
			return { prompt, completion, cacheRead, cacheWrite };
		});
		return blendWeightsFromPercentages(
			blendWeights.prompt,
			blendWeights.completion,
			blendWeights.cacheRead,
			blendWeights.cacheWrite,
		);
	}

	async setSelectedModelId(id: string): Promise<void> {
		await getConfig().update("general.selectedModelId", id, vscode.ConfigurationTarget.Global);
		this._cache.set("general.selectedModelId", id);
	}

	async setShowInStatusBar(show: boolean): Promise<void> {
		await getConfig().update("statusBar.show", show, vscode.ConfigurationTarget.Global);
		this._cache.set("statusBar.show", show);
	}

	async setFavoriteModels(models: string[]): Promise<void> {
		const normalized = [...new Set(models.filter((id) => typeof id === "string"))];
		await getConfig().update(
			"modelBrowser.favorites",
			normalized,
			vscode.ConfigurationTarget.Global,
		);
		this._cache.set("modelBrowser.favorites", normalized);
	}

	get providerFilter(): ProviderFilter {
		return this._get<ProviderFilter>("general.providerScope", "openrouterOnly", (v) => {
			if (v !== "openrouterOnly" && v !== "allProviders") {
				_log.warn(
					`ConfigService: invalid general.providerScope "${v}", falling back to "openrouterOnly"`,
				);
				return "openrouterOnly";
			}
			return v;
		});
	}

	get modelPollInterval(): number {
		return this._get<number>("general.modelPollInterval", 30, (v) => {
			if (!Number.isFinite(v) || v < 0) {
				_log.warn("ConfigService: general.modelPollInterval must be >= 0, clamping to 30");
				return 30;
			}
			if (v > 300) {
				_log.warn("ConfigService: general.modelPollInterval above maximum (300s), clamping to 300");
				return 300;
			}
			return v;
		});
	}

	get statusBarClickAction(): StatusBarClickAction {
		const validActions = new Set<StatusBarClickAction>([
			"browseModels",
			"refreshPricing",
			"showLogs",
			"quickActions",
		]);
		return this._get<StatusBarClickAction>("statusBar.clickAction", "browseModels", (v) => {
			if (!validActions.has(v)) {
				_log.warn(
					`ConfigService: invalid statusBar.clickAction "${v}", falling back to "browseModels"`,
				);
				return "browseModels";
			}
			return v;
		});
	}

	get showFreeModelsOnly(): boolean {
		return this._get<boolean>("modelBrowser.showFreeOnly", false);
	}

	get modelBrowserSort(): ModelBrowserSort {
		const validSorts = new Set<ModelBrowserSort>([
			"blendedRate",
			"promptPrice",
			"completionPrice",
			"contextLength",
			"name",
		]);
		return this._get<ModelBrowserSort>("modelBrowser.sort", "blendedRate", (v) => {
			if (!validSorts.has(v)) {
				_log.warn(`ConfigService: invalid modelBrowser.sort "${v}", falling back to "blendedRate"`);
				return "blendedRate";
			}
			return v;
		});
	}

	get logLevel(): LogLevel {
		const validLevels = new Set<LogLevel>(["debug", "info", "warn", "error"]);
		return this._get<LogLevel>("general.logLevel", "info", (v) => {
			if (!validLevels.has(v)) {
				_log.warn(`ConfigService: invalid general.logLevel "${v}", falling back to "info"`);
				return "info";
			}
			return v;
		});
	}

	get favoriteModels(): string[] {
		return this._get<string[]>("modelBrowser.favorites", [], (v) => {
			if (!Array.isArray(v)) {
				_log.warn("ConfigService: modelBrowser.favorites is not an array, falling back to []");
				return [];
			}
			return v.filter((id) => typeof id === "string");
		});
	}

	get showDeprecatedModels(): boolean {
		return this._get<boolean>("modelBrowser.showDeprecated", true);
	}

	get apiBaseUrl(): string {
		const _default = "https://openrouter.ai/api/v1/models";
		return this._get<string>("general.apiBaseUrl", _default, (v) => {
			if (typeof v !== "string" || v.length === 0) {
				_log.warn("ConfigService: general.apiBaseUrl must be a non-empty string, using default");
				return _default;
			}
			// Prevent protocol smuggling — only allow https:// (and http:// for local dev)
			let url: URL;
			try {
				url = new URL(v);
			} catch {
				_log.warn(`ConfigService: general.apiBaseUrl "${v}" is not a valid URL, using default`);
				return _default;
			}
			if (!isAllowedPublicApiBaseUrl(v)) {
				_log.warn(
					`ConfigService: general.apiBaseUrl host or URL policy rejected "${url.origin}", using default`,
				);
				return _default;
			}
			// Strip trailing slash for consistent URL construction
			return v.endsWith("/") ? v.slice(0, -1) : v;
		});
	}

	/**
	 * Derive the API v1 base origin from apiBaseUrl.
	 * The apiBaseUrl points to /api/v1/models — this extracts the
	 * origin + /api/v1 prefix so usage endpoints can use it.
	 */
	get apiOrigin(): string {
		return "https://openrouter.ai/api/v1";
	}

	get statusBarTemplate(): string {
		return this._get<string>("statusBar.template", "${modelName} ${priceText}${deprecation}");
	}

	get currency(): string {
		const validCurrencies = new Set([
			"USD",
			"EUR",
			"GBP",
			"JPY",
			"KRW",
			"CNY",
			"INR",
			"CAD",
			"AUD",
			"BRL",
		]);
		return this._get<string>("general.currency", "USD", (v) => {
			if (!validCurrencies.has(v)) {
				_log.warn(`ConfigService: invalid general.currency "${v}", falling back to "USD"`);
				return "USD";
			}
			return v;
		});
	}

	get currencyRate(): number {
		return this._get<number>("general.currencyRate", 0, (v) => {
			if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
			return v;
		});
	}

	get cacheTtlHours(): number {
		return this._get<number>("general.cacheTtlHours", 24, (v) => {
			if (!Number.isFinite(v) || v < 1) {
				_log.warn("ConfigService: cacheTtlHours must be >= 1, clamping to 24");
				return 24;
			}
			if (v > 720) {
				_log.warn("ConfigService: cacheTtlHours above maximum (720), clamping to 720");
				return 720;
			}
			return v;
		});
	}

	get usageStatusBarClickAction(): UsageStatusBarClickAction {
		const validActions = new Set<UsageStatusBarClickAction>([
			"fullDashboard",
			"sidebarDashboard",
			"quickActions",
		]);
		return this._get<UsageStatusBarClickAction>(
			"usage.statusBarClickAction",
			"fullDashboard",
			(v) => {
				if (!validActions.has(v)) {
					_log.warn(
						`ConfigService: invalid usage.statusBarClickAction "${v}", falling back to "fullDashboard"`,
					);
					return "fullDashboard";
				}
				return v;
			},
		);
	}

	// ── Usage feature getters ─────────────────────────────────

	get usageAutoRefreshInterval(): number {
		return this._get<number>("usage.autoRefreshInterval", 300, (v) => {
			if (!Number.isFinite(v) || v < 0) {
				_log.warn("ConfigService: usage.autoRefreshInterval must be >= 0, clamping to 300");
				return 300;
			}
			if (v > 0 && v < 60) {
				_log.warn("ConfigService: usage.autoRefreshInterval below minimum (60s), clamping to 60");
				return 60;
			}
			if (v > 86400) {
				_log.warn(
					"ConfigService: usage.autoRefreshInterval above maximum (86400s), clamping to 86400",
				);
				return 86400;
			}
			return v;
		});
	}

	get usageBackgroundPollingEnabled(): boolean {
		return this._get<boolean>("usage.backgroundPolling.enabled", true);
	}

	get usageAnalyticsEnabled(): boolean {
		return this._get<boolean>("usage.analytics.enabled", true);
	}

	get usageAnalyticsLookbackDays(): number {
		return this._get<number>("usage.analytics.lookbackDays", 30, (v) => {
			if (!Number.isFinite(v) || v < 1) {
				_log.warn("ConfigService: usage.analytics.lookbackDays must be >= 1, using 30");
				return 30;
			}
			if (v > 90) {
				_log.warn("ConfigService: usage.analytics.lookbackDays above maximum (90), clamping to 90");
				return 90;
			}
			return Math.floor(v);
		});
	}

	get usageLowBalanceThreshold(): number {
		return this._get<number>("usage.lowBalanceThreshold", 10, (v) => {
			if (!Number.isFinite(v) || v < 0) {
				_log.warn("ConfigService: usage.lowBalanceThreshold must be >= 0, clamping to 10");
				return 10;
			}
			return v;
		});
	}

	get usageStatusBarEnabled(): boolean {
		return this._get<boolean>("usage.showStatusBar", true);
	}

	get usageShowDashboard(): boolean {
		return this._get<boolean>("usage.showDashboard", true);
	}
}
