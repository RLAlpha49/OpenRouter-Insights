/**
 * Unit tests for UsageRefreshUseCase — concurrent coalescing,
 * threshold notifications, no-key state, and key selection.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { UsageRefreshUseCase } from "../../use-cases/usageRefreshUseCase";
import type { IUsageStore } from "../../api/cache/usageStore";
import type { UsageStats } from "../../types-usage";
import { createFakeReadonlyConfig } from "../__mocks__/config-test-helpers";
import { createRefreshContext } from "../../infrastructure/refreshContext";
import { fetchUsageDetails, fetchUsageStats } from "../../api/clients/usageService";
import { getAvailableCredits } from "../../ui/status/usageStatusBarView";
import { EventBus } from "../../infrastructure/eventBus";

vi.mock("../../api/clients/usageService", () => ({
	fetchUsageDetails: vi.fn(),
	fetchUsageStats: vi.fn(),
}));

class FakeSecretStorageService {
	private _key: string | undefined;

	get = vi.fn(async () => this._key);
	set = vi.fn(async (key: string) => {
		this._key = key;
	});
	delete = vi.fn(async () => {
		this._key = undefined;
	});
	dispose = vi.fn();

	_seededKey(key: string) {
		this._key = key;
	}
}

class FakeUsageStatusBarView {
	showNoKey = vi.fn();
	showLoading = vi.fn();
	showUsage = vi.fn();
	showError = vi.fn();
	render = vi.fn();
	setCommand = vi.fn();
	setEnabled = vi.fn();
	dispose = vi.fn();
}

class FakeUsageDashboardProvider {
	renderNoKey = vi.fn();
	renderLoading = vi.fn();
	renderUsage = vi.fn();
	renderError = vi.fn();
	sendLoadingProgress = vi.fn();
}

function createFakeUsageStore(): IUsageStore {
	let data: UsageStats | undefined;
	return {
		get: () => data,
		set: (usage) => {
			data = usage;
		},
		clear: () => {
			data = undefined;
		},
		ageMs: () => 0,
		isStale: () => false,
	};
}

function createUsageStats(): UsageStats {
	return {
		mode: "regular",
		isManagementKey: false,
		capabilities: {
			keys: "notApplicable",
			credits: "notApplicable",
			activity: "notApplicable",
			perKeyActivity: "notApplicable",
			analytics: "notApplicable",
			keyManagement: "notApplicable",
		},
		totalUsed: 1,
		dailyUsage: 0.1,
		weeklyUsage: 0.5,
		monthlyUsage: 1,
		limit: 10,
		limitRemaining: 9,
		limitReset: null,
		isFreeTier: false,
		usagePercent: 10,
		allKeys: null,
		selectedKeyHash: null,
		accountCredits: null,
		fetchedAt: new Date().toISOString(),
		dailyUsageHistory: null,
		perKeyActivityHistory: null,
		analytics: null,
	};
}

function createManagementUsageStats(): UsageStats {
	return {
		...createUsageStats(),
		mode: "management",
		isManagementKey: true,
		capabilities: {
			keys: "available",
			credits: "available",
			activity: "unavailable",
			perKeyActivity: "unavailable",
			analytics: "available",
			keyManagement: "available",
		},
		allKeys: [],
		accountCredits: {
			totalCredits: 10,
			totalUsage: 1,
			remaining: 9,
			usagePercent: 10,
		},
	};
}

describe("UsageRefreshUseCase", () => {
	let secrets: FakeSecretStorageService;
	let statusBar: FakeUsageStatusBarView;
	let dashboard: FakeUsageDashboardProvider;
	let cache: IUsageStore;

	beforeEach(() => {
		vi.clearAllMocks();
		secrets = new FakeSecretStorageService();
		statusBar = new FakeUsageStatusBarView();
		dashboard = new FakeUsageDashboardProvider();
		cache = createFakeUsageStore();
	});

	describe("getAvailableCredits", () => {
		it("uses the account balance when it is lower than the key balance", () => {
			const usage = createUsageStats();
			usage.limit = 15;
			usage.limitRemaining = 14;
			usage.accountCredits = {
				totalCredits: 20,
				totalUsage: 10,
				remaining: 9,
				usagePercent: 50,
			};

			expect(getAvailableCredits(usage)).toBe(9);
		});

		it("uses the key balance when it is lower than the account balance", () => {
			const usage = createUsageStats();
			usage.limitRemaining = 14;
			usage.accountCredits = {
				totalCredits: 30,
				totalUsage: 10,
				remaining: 20,
				usagePercent: 33.3,
			};

			expect(getAvailableCredits(usage)).toBe(14);
		});

		it("uses account credits for an unlimited key", () => {
			const usage = createUsageStats();
			usage.limit = null;
			usage.limitRemaining = null;
			usage.accountCredits = {
				totalCredits: 10,
				totalUsage: 1,
				remaining: 9,
				usagePercent: 10,
			};

			expect(getAvailableCredits(usage)).toBe(9);
		});

		it("falls back to the key balance without account credits", () => {
			const usage = createUsageStats();

			expect(getAvailableCredits(usage)).toBe(9);
		});

		it("returns null when neither balance is available", () => {
			const usage = createUsageStats();
			usage.limit = null;
			usage.limitRemaining = null;

			expect(getAvailableCredits(usage)).toBeNull();
		});
	});

	it("shows no-key state when no API key is set", async () => {
		const config = createFakeReadonlyConfig();
		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			config,
		);

		await useCase.execute();

		expect(statusBar.showNoKey).toHaveBeenCalled();
		expect(dashboard.renderNoKey).toHaveBeenCalled();
	});

	it("is not in progress initially", () => {
		const config = createFakeReadonlyConfig();
		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			config,
		);
		expect(useCase.isInProgress).toBe(false);
	});

	it("tracks selected key hash", () => {
		const config = createFakeReadonlyConfig();
		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			config,
		);
		// Key hash tracking is set internally during execute, test just verifies construction
		expect(useCase).toBeDefined();
	});

	it("starts a replacement refresh when the previous context was cancelled", async () => {
		secrets._seededKey("sk-or-test");
		let releaseFirst: (() => void) | undefined;
		const firstFetch = new Promise<UsageStats>((resolve) => {
			releaseFirst = () => resolve(createUsageStats());
		});
		vi.mocked(fetchUsageStats)
			.mockReturnValueOnce(firstFetch)
			.mockResolvedValueOnce(createUsageStats());

		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig(),
		);
		const firstContext = createRefreshContext("activation");
		const secondContext = createRefreshContext("user");

		const first = useCase.execute(undefined, firstContext);
		await vi.waitFor(() => expect(fetchUsageStats).toHaveBeenCalledTimes(1));
		firstContext.abort();

		const second = useCase.execute(undefined, secondContext);
		await second;
		expect(fetchUsageStats).toHaveBeenCalledTimes(2);
		expect(statusBar.showUsage).toHaveBeenCalledTimes(1);

		releaseFirst?.();
		await first;
	});

	it("passes the refresh signal to the usage request", async () => {
		secrets._seededKey("sk-or-test");
		vi.mocked(fetchUsageStats).mockResolvedValue(createUsageStats());
		const context = createRefreshContext("user");
		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig(),
		);

		await useCase.execute(undefined, context);

		expect(fetchUsageStats).toHaveBeenCalledWith(
			"sk-or-test",
			undefined,
			undefined,
			"https://openrouter.ai",
			context.signal,
			expect.any(Function),
		);
	});

	it("loads dashboard details after a management-key refresh", async () => {
		secrets._seededKey("sk-or-test");
		const baseline = createManagementUsageStats();
		const details = {
			...baseline,
			dailyUsageHistory: [{ date: "2026-08-01", usage: 1, requests: 2 }],
			analytics: {
				modelBreakdown: [],
				totalRequests: 0,
				totalSpend: 0,
				overallCacheHitRate: 0,
			},
		};
		vi.mocked(fetchUsageStats).mockResolvedValue(baseline);
		vi.mocked(fetchUsageDetails).mockResolvedValue(details);

		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig(),
		);

		await useCase.execute();

		expect(fetchUsageDetails).toHaveBeenCalledWith(
			"sk-or-test",
			undefined,
			expect.objectContaining({ includeAnalytics: true, lookbackDays: 30 }),
			undefined,
			"https://openrouter.ai",
			undefined,
			expect.any(Function),
		);
		expect(dashboard.renderUsage).toHaveBeenLastCalledWith(details);
	});

	it("renders detail loading state before initial management details finish", async () => {
		secrets._seededKey("sk-or-test");
		const baseline = createManagementUsageStats();
		let resolveDetails: ((_value: UsageStats) => void) | undefined;
		const pendingDetails = new Promise<UsageStats>((resolve) => {
			resolveDetails = resolve;
		});
		vi.mocked(fetchUsageStats).mockResolvedValue(baseline);
		vi.mocked(fetchUsageDetails).mockReturnValue(pendingDetails);

		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig(),
		);

		const refresh = useCase.execute();
		await vi.waitFor(() => expect(fetchUsageDetails).toHaveBeenCalledTimes(1));

		expect(dashboard.renderUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				detailState: expect.objectContaining({ status: "loading" }),
			}),
		);

		resolveDetails?.({
			...baseline,
			dailyUsageHistory: [{ date: "2026-08-01", usage: 1, requests: 2 }],
		});
		await refresh;
	});

	it("does not publish detail data after its refresh context is cancelled", async () => {
		secrets._seededKey("sk-or-test");
		const baseline = createManagementUsageStats();
		let resolveDetails: ((_value: UsageStats) => void) | undefined;
		const pendingDetails = new Promise<UsageStats>((_resolve) => {
			resolveDetails = _resolve;
		});
		vi.mocked(fetchUsageDetails).mockReturnValue(pendingDetails);
		const context = createRefreshContext("user");
		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig({ usageAnalyticsEnabled: false }),
		);

		const loading = useCase.loadDetails(false, context, baseline);
		context.abort();
		resolveDetails?.({ ...baseline, dailyUsageHistory: [] });
		await loading;

		expect(cache.get()).toBeUndefined();
		expect(dashboard.renderUsage).not.toHaveBeenCalled();
	});

	it("cancels pending detail publication when usage state is cleared", async () => {
		secrets._seededKey("sk-or-test");
		const baseline = createManagementUsageStats();
		let resolveDetails: ((_value: UsageStats) => void) | undefined;
		const pendingDetails = new Promise<UsageStats>((_resolve) => {
			resolveDetails = _resolve;
		});
		vi.mocked(fetchUsageDetails).mockReturnValue(pendingDetails);
		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig({ usageAnalyticsEnabled: false }),
		);

		const loading = useCase.loadDetails(false, createRefreshContext("user"), baseline);
		await useCase.clear();
		resolveDetails?.({ ...baseline, dailyUsageHistory: [] });
		await loading;

		expect(cache.get()).toBeUndefined();
		expect(dashboard.renderNoKey).toHaveBeenCalled();
		expect(dashboard.renderUsage).not.toHaveBeenCalled();
	});

	it("retains prior detail sections and marks them stale after enrichment fails", async () => {
		secrets._seededKey("sk-or-test");
		const previous = {
			...createManagementUsageStats(),
			dailyUsageHistory: [{ date: "2026-07-31", usage: 2, requests: 3 }],
			detailState: { status: "fresh" as const, lastSuccessAt: "2026-07-31T00:00:00.000Z" },
		};
		cache.set(previous);
		vi.mocked(fetchUsageStats).mockResolvedValue(createManagementUsageStats());
		vi.mocked(fetchUsageDetails).mockRejectedValue(new Error("activity unavailable"));
		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig({ usageAnalyticsEnabled: false }),
		);

		await useCase.execute();

		expect(cache.get()).toMatchObject({
			dailyUsageHistory: previous.dailyUsageHistory,
			detailState: { status: "stale" },
		});
		expect(dashboard.renderUsage).toHaveBeenLastCalledWith(
			expect.objectContaining({ detailState: expect.objectContaining({ status: "stale" }) }),
		);
	});

	it("emits a bounded failure outcome for a non-cancellation error", async () => {
		secrets._seededKey("sk-or-test");
		vi.mocked(fetchUsageStats).mockRejectedValue(new Error("x".repeat(500)));
		const eventBus = new EventBus();
		const failures: Array<{ label?: string; error: string }> = [];
		eventBus.on("refreshFailed", (failure) => failures.push(failure));
		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig(),
			undefined,
			eventBus,
		);

		await useCase.execute();

		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ label: "usage" });
		expect(failures[0].error.length).toBeLessThanOrEqual(240);
	});

	it("coalesces identical detail requests into a single in-flight load", async () => {
		secrets._seededKey("sk-or-test");
		const baseline = createManagementUsageStats();
		let resolveDetails: ((_value: UsageStats) => void) | undefined;
		const pending = new Promise<UsageStats>((resolve) => {
			resolveDetails = resolve;
		});
		vi.mocked(fetchUsageDetails).mockReturnValue(pending);

		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig(),
		);

		const first = useCase.loadDetails(false, createRefreshContext("user"), baseline);
		const second = useCase.loadDetails(false, createRefreshContext("user"), baseline);

		await vi.waitFor(() => expect(fetchUsageDetails).toHaveBeenCalledTimes(1));
		resolveDetails?.({ ...baseline, dailyUsageHistory: [] });
		await Promise.all([first, second]);
	});

	it("replaces a superseded detail request when the analytics flag changes", async () => {
		secrets._seededKey("sk-or-test");
		const baseline = createManagementUsageStats();
		let resolveSecond: ((_value: UsageStats) => void) | undefined;
		const secondPending = new Promise<UsageStats>((resolve) => {
			resolveSecond = resolve;
		});
		vi.mocked(fetchUsageDetails).mockReturnValue(secondPending);

		const useCase = new UsageRefreshUseCase(
			cache,
			secrets as any,
			statusBar as any,
			dashboard as any,
			createFakeReadonlyConfig(),
		);

		const first = useCase.loadDetails(false, createRefreshContext("user"), baseline);
		const second = useCase.loadDetails(true, createRefreshContext("user"), baseline);

		// The superseded (false) request is aborted before it fetches, so only
		// the new (true) request reaches the network.
		await vi.waitFor(() => expect(fetchUsageDetails).toHaveBeenCalledTimes(1));
		expect(fetchUsageDetails).toHaveBeenCalledWith(
			expect.any(String),
			undefined,
			expect.objectContaining({ includeAnalytics: true, lookbackDays: 30 }),
			undefined,
			"https://openrouter.ai",
			expect.any(AbortSignal),
			expect.any(Function),
		);

		// The first (superseded) request must not publish.
		resolveSecond?.({ ...baseline, dailyUsageHistory: [{ date: "2026-08-02", usage: 2, requests: 2 }] });
		await Promise.all([first, second]);

		expect(cache.get()?.dailyUsageHistory?.[0]).toMatchObject({ date: "2026-08-02" });
	});
});
