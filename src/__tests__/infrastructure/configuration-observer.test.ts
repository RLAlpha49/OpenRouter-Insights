/**
 * Unit tests for ConfigurationObserver — bridging ConfigService events
 * to handler callbacks, with optional EventBus integration.
 *
 * Covers: handler dispatch on config changes, EventBus emission,
 * subscription cleanup via disposable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	observeConfiguration,
	type ConfigChangeHandlers,
} from "../../infrastructure/configurationObserver";
import { ConfigService } from "../../infrastructure/config";
import type { EventBus } from "../../infrastructure/eventBus";
import * as vscodeMock from "vscode";

describe("observeConfiguration", () => {
	let cs: ConfigService;
	let handlers: ConfigChangeHandlers;
	let eventBus: EventBus;

	beforeEach(() => {
		cs = ConfigService.instance;
		handlers = {
			onRefreshIntervalChanged: vi.fn(),
			onDisplaySettingsChanged: vi.fn(),
			onPollIntervalChanged: vi.fn(),
			onUsageDataSettingsChanged: vi.fn(),
			onBlendWeightsChanged: vi.fn(),
		};
		eventBus = {
			on: vi.fn(() => ({ dispose: vi.fn() })),
			emit: vi.fn(),
			dispose: vi.fn(),
		} as unknown as EventBus;
	});

	it("forwards configuration changes to handlers and the event bus", () => {
		const disposable = observeConfiguration(handlers, eventBus);
		for (const listener of (vscodeMock.workspace as any)._createConfigListeners) {
			listener({ affectsConfiguration: () => true });
		}
		expect(handlers.onRefreshIntervalChanged).toHaveBeenCalledOnce();
		expect(handlers.onDisplaySettingsChanged).toHaveBeenCalledOnce();
		expect(handlers.onPollIntervalChanged).toHaveBeenCalledOnce();
		expect(handlers.onBlendWeightsChanged).toHaveBeenCalledOnce();
		expect(eventBus.emit).toHaveBeenCalled();
		disposable.dispose();
	});

	it("exposes usage data setting changes separately", () => {
		expect(typeof cs.onUsageDataSettingsChanged).toBe("function");
		const disposable = observeConfiguration(handlers, eventBus);
		for (const listener of (vscodeMock.workspace as any)._createConfigListeners) {
			listener({
				affectsConfiguration: (key: string) =>
					key === "openrouterInsights" || key === "openrouterInsights.usage.analytics.enabled",
			});
		}
		expect(handlers.onUsageDataSettingsChanged).toHaveBeenCalledTimes(1);
		disposable.dispose();
	});

	it("handlers object is not mutated", () => {
		const snapshot = { ...handlers };
		const disposable = observeConfiguration(handlers, eventBus);
		expect(handlers).toEqual(snapshot);
		disposable.dispose();
	});
});
