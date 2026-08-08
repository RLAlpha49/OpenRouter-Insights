/**
 * Unit tests for EventBus — typed event emission and subscription.
 *
 * Covers: subscribe, emit, multiple subscribers, disposal, and
 * ensuring only subscribed events fire.
 */

import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../infrastructure/eventBus";
import type { CachedPricingData } from "../../types";

describe("EventBus", () => {
	it("delivers events to a single subscriber", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		bus.on("pricingRefreshed", handler);
		const data = { fetchedAt: 123, models: new Map() } as unknown as CachedPricingData;
		bus.emit("pricingRefreshed", data);

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(data);
	});

	it("delivers events to multiple subscribers", () => {
		const bus = new EventBus();
		const handler1 = vi.fn();
		const handler2 = vi.fn();

		bus.on("pricingRefreshed", handler1);
		bus.on("pricingRefreshed", handler2);

		const data = { fetchedAt: 456, models: new Map() } as unknown as CachedPricingData;
		bus.emit("pricingRefreshed", data);

		expect(handler1).toHaveBeenCalledWith(data);
		expect(handler2).toHaveBeenCalledWith(data);
	});

	it("does not deliver to unsubscribed events", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		bus.on("pricingRefreshed", handler);
		bus.emit("refreshStarted", undefined);

		expect(handler).not.toHaveBeenCalled();
	});

	it("delivers void payloads for configChanged", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		bus.on("configChanged", handler);
		bus.emit("configChanged", undefined);

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(undefined);
	});

	it("emitting with no subscribers does not throw", () => {
		const bus = new EventBus();
		expect(() => bus.emit("pricingRefreshed", {} as CachedPricingData)).not.toThrow();
		expect(() => bus.emit("refreshStarted", undefined)).not.toThrow();
	});

	it("returns a disposable from on() that unsubscribes", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		const sub = bus.on("pricingRefreshed", handler);
		sub.dispose();

		bus.emit("pricingRefreshed", {
			fetchedAt: 789,
			models: new Map(),
		} as unknown as CachedPricingData);
		expect(handler).not.toHaveBeenCalled();
	});

	it("dispose clears all subscriptions and emitters", () => {
		const bus = new EventBus();
		const handler1 = vi.fn();
		const handler2 = vi.fn();

		bus.on("pricingRefreshed", handler1);
		bus.on("modelChanged", handler2);
		bus.dispose();

		bus.emit("pricingRefreshed", {
			fetchedAt: 1,
			models: new Map(),
		} as unknown as CachedPricingData);
		bus.emit("modelChanged", { modelId: "test", displayName: "Test" });

		expect(handler1).not.toHaveBeenCalled();
		expect(handler2).not.toHaveBeenCalled();
	});

	it("supports all event types", () => {
		const bus = new EventBus();
		const events: { fired: Record<string, unknown> } = { fired: {} };

		bus.on("pricingRefreshed", (d) => {
			events.fired.pricing = d;
		});
		bus.on("modelChanged", (d) => {
			events.fired.model = d;
		});
		bus.on("configChanged", () => {
			events.fired.config = true;
		});
		bus.on("refreshStarted", () => {
			events.fired.started = true;
		});
		bus.on("refreshFailed", (d) => {
			events.fired.failed = d;
		});

		bus.emit("pricingRefreshed", {
			fetchedAt: 1,
			models: new Map(),
		} as unknown as CachedPricingData);
		bus.emit("modelChanged", { modelId: "a", displayName: "A" });
		bus.emit("configChanged", undefined);
		bus.emit("refreshStarted", undefined);
		bus.emit("refreshFailed", { error: "timeout" });

		expect(events.fired.pricing).toBeDefined();
		expect(events.fired.model).toEqual({ modelId: "a", displayName: "A" });
		expect(events.fired.config).toBe(true);
		expect(events.fired.started).toBe(true);
		expect(events.fired.failed).toEqual({ error: "timeout" });
	});

	it("multiple emits deliver every payload", () => {
		const bus = new EventBus();
		const received: string[] = [];

		bus.on("pricingRefreshed", (d) => {
			received.push(d.fetchedAt);
		});

		bus.emit("pricingRefreshed", {
			fetchedAt: "100",
			models: new Map(),
		} as unknown as CachedPricingData);
		bus.emit("pricingRefreshed", {
			fetchedAt: "200",
			models: new Map(),
		} as unknown as CachedPricingData);
		bus.emit("pricingRefreshed", {
			fetchedAt: "300",
			models: new Map(),
		} as unknown as CachedPricingData);

		expect(received).toEqual(["100", "200", "300"]);
	});
});
