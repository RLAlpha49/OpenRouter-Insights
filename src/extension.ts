import * as vscode from "vscode";
import { createServices } from "./infrastructure/services";
import { ConfigService, initConfigLogger } from "./infrastructure/config";
import { initLogger, log } from "./infrastructure/logger";
import { ExtensionRuntime } from "./infrastructure/extensionRuntime";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	initLogger(context);
	log.info("===== OpenRouter Insights activating =====");

	initConfigLogger(log);

	dumpConfig(log);

	let runtime: ExtensionRuntime | undefined;
	let services: ReturnType<typeof createServices> | undefined;
	try {
		services = createServices(context);
		log.info(
			"Cache age:",
			services.cache.age(),
			"| models loaded:",
			services.cache.getLookup().size,
		);
		runtime = new ExtensionRuntime(context, services);
		context.subscriptions.push(runtime);
		await runtime.start();
	} catch (error) {
		runtime?.dispose();
		if (!runtime) services?.dispose();
		log.error("Extension activation failed:", error);
		throw error;
	}

	log.info("===== OpenRouter Insights activated =====");
}

export function deactivate(): void {
	log.info("===== OpenRouter Insights deactivated =====");
}

// ── Startup config dump ───────────────────────────────────────

/**
 * Log all resolved configuration values at debug level on activation.
 * Invaluable for remote debugging — users can share the log output
 * instead of screenshots of their settings UI.
 */
function dumpConfig(logger: { debug(..._args: unknown[]): void }): void {
	const cfg = ConfigService.instance;
	logger.debug("── Resolved configuration ──");
	logger.debug("  statusBar.show:", cfg.showInStatusBar);
	logger.debug("  statusBar.maxWidth:", cfg.statusBarMaxWidth);
	logger.debug("  statusBar.clickAction:", cfg.statusBarClickAction);
	logger.debug("  statusBar.template:", JSON.stringify(cfg.statusBarTemplate));
	logger.debug("  general.autoRefreshInterval:", cfg.autoRefreshInterval, "s");
	logger.debug("  general.modelPollInterval:", cfg.modelPollInterval, "s");
	logger.debug("  general.selectedModelId:", cfg.selectedModelId || "(auto-detect)");
	logger.debug("  general.providerScope:", cfg.providerFilter);
	logger.debug("  general.currency:", cfg.currency);
	logger.debug("  general.currencyRate:", cfg.currencyRate || "(built-in)");
	logger.debug("  general.cacheTtlHours:", cfg.cacheTtlHours);
	logger.debug("  general.apiBaseUrl:", cfg.apiBaseUrl);
	logger.debug("  modelBrowser.showFreeOnly:", cfg.showFreeModelsOnly);
	logger.debug("  modelBrowser.showDeprecated:", cfg.showDeprecatedModels);
	logger.debug("  modelBrowser.sort:", cfg.modelBrowserSort);
	logger.debug("  modelBrowser.favorites:", cfg.favoriteModels.length, "models");
	logger.debug("  usage.autoRefreshInterval:", cfg.usageAutoRefreshInterval, "s");
	logger.debug("  usage.showStatusBar:", cfg.usageStatusBarEnabled);
	logger.debug("  usage.showDashboard:", cfg.usageShowDashboard);
	logger.debug("  usage.statusBarClickAction:", cfg.usageStatusBarClickAction);
	logger.debug("  usage.lowBalanceThreshold:", cfg.usageLowBalanceThreshold);
	logger.debug("── End configuration ──");
}
