import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsagePollingService } from "../../infrastructure/usagePollingService";

function makeConfig(intervalSeconds = 1) {
	return {
		usageBackgroundPollingEnabled: true,
		usageAutoRefreshInterval: intervalSeconds,
	};
}

describe("UsagePollingService", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs a refresh on every interval tick", async () => {
		const onTick = vi.fn().mockResolvedValue(undefined);
		const service = new UsagePollingService(onTick, makeConfig());

		try {
			await vi.advanceTimersByTimeAsync(3_000);
			expect(onTick).toHaveBeenCalledTimes(3);
		} finally {
			service.dispose();
		}
	});

	it("coalesces overlapping ticks into a single in-flight refresh", async () => {
		let release: () => void = () => {};
		const onTick = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const service = new UsagePollingService(onTick, makeConfig());

		try {
			await vi.advanceTimersByTimeAsync(2_100);
			expect(onTick).toHaveBeenCalledTimes(1);

			release();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(onTick).toHaveBeenCalledTimes(2);
		} finally {
			service.dispose();
		}
	});

	it("reschedules when the configured interval changes", async () => {
		const config = makeConfig(1);
		const onTick = vi.fn().mockResolvedValue(undefined);
		const service = new UsagePollingService(onTick, config);

		try {
			await vi.advanceTimersByTimeAsync(2_000);
			expect(onTick).toHaveBeenCalledTimes(2);

			config.usageAutoRefreshInterval = 2;
			service.schedule();

			await vi.advanceTimersByTimeAsync(2_000);
			expect(onTick).toHaveBeenCalledTimes(3);
		} finally {
			service.dispose();
		}
	});

	it("stops ticking after dispose", async () => {
		const onTick = vi.fn().mockResolvedValue(undefined);
		const service = new UsagePollingService(onTick, makeConfig());

		await vi.advanceTimersByTimeAsync(1_000);
		service.dispose();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(onTick).toHaveBeenCalledTimes(1);
	});
});
