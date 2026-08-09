import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { UsageDashboardProvider } from "../../ui/webviews/usageDashboard";

function usage() {
	return {
		mode: "management",
		isManagementKey: true,
		capabilities: {
			keys: "available",
			credits: "available",
			activity: "available",
			perKeyActivity: "available",
			analytics: "available",
			keyManagement: "available",
		},
		totalUsed: 1,
		dailyUsage: 0,
		weeklyUsage: 0,
		monthlyUsage: 1,
		limit: 10,
		limitRemaining: 9,
		limitReset: null,
		isFreeTier: false,
		usagePercent: 10,
		allKeys: [],
		selectedKeyHash: "hash-1",
		accountCredits: null,
		fetchedAt: new Date().toISOString(),
		dailyUsageHistory: null,
		analytics: null,
	} as any;
}

describe("UsageDashboardProvider", () => {
	it("shows a loading state when the sidebar resolves before usage data exists", () => {
		const provider = new UsageDashboardProvider();
		const executeCommand = vi.fn(async () => undefined);
		(vscode.commands as any).executeCommand = executeCommand;
		const view = {
			webview: {
				options: {},
				html: "",
				postMessage: vi.fn(async () => true),
				onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
			},
			onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
		};

		provider.resolveWebviewView(view as any, {} as any, {} as any);

		expect(view.webview.html).toContain('class="or-spinner"');
		expect(view.webview.html).toContain("Loading usage data…");
		expect(executeCommand).toHaveBeenCalledWith("openrouter-insights.refreshUsage");
	});

	it("requests usage when the sidebar resolves without an existing render", () => {
		const provider = new UsageDashboardProvider();
		const executeCommand = vi.fn(async () => undefined);
		(vscode.commands as any).executeCommand = executeCommand;
		const view = {
			webview: {
				options: {},
				html: "",
				postMessage: vi.fn(async () => true),
				onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
			},
			onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
		};

		provider.resolveWebviewView(view as any, {} as any, {} as any);

		expect(executeCommand).toHaveBeenCalledWith("openrouter-insights.refreshUsage");
	});

	it("replays the latest render when the webview becomes ready after a refresh", () => {
		const provider = new UsageDashboardProvider();
		let receiveMessage: ((_message: unknown) => void) | undefined;
		let webviewReady = false;
		const posted: unknown[] = [];
		const webview = {
			options: {},
			html: "",
			postMessage: vi.fn(async (message: unknown) => {
				// Messages posted while the document is loading can be lost. The
				// provider must replay the latest body after the ready handshake.
				if (webviewReady) posted.push(message);
				return true;
			}),
			onDidReceiveMessage: (listener: (_message: unknown) => void) => {
				receiveMessage = listener;
				return { dispose: vi.fn() };
			},
			onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
		};
		(vscode.commands as any).executeCommand = vi.fn(async () => undefined);

		provider.resolveWebviewView(
			{
				webview,
				onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
			} as any,
			{} as any,
			{} as any,
		);
		provider.renderUsage(usage());

		expect(posted).toHaveLength(0);
		webviewReady = true;
		receiveMessage?.({ cmd: "dashboardReady" });

		expect(posted).toEqual([expect.objectContaining({ cmd: "updateHtml" })]);
	});

	it("queues state, handles messages, and opens expanded panels", async () => {
		const provider = new UsageDashboardProvider();
		provider.renderNoKey();
		provider.renderLoading();
		provider.renderNoData();
		provider.renderError("bad");
		provider.renderUsage(usage());
		const posted: unknown[] = [];
		const webview = {
			options: {},
			html: "",
			postMessage: vi.fn(async (message: unknown) => {
				posted.push(message);
				return true;
			}),
			onDidReceiveMessage: (_listener: unknown) => ({ dispose: () => {} }),
			onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
		};
		provider.resolveWebviewView(
			{
				webview,
				onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
			} as any,
			{} as any,
			{} as any,
		);
		provider.switchKey("hash-2");
		await provider.handleMessageForTest(
			{ cmd: "openrouter-insights.refreshUsage", requestId: "r1" },
			webview as any,
		);
		await provider.handleMessageForTest({ cmd: "invalid" as any }, webview as any);
		await provider.handleMessageForTest(
			{ cmd: "openrouter-insights.selectUsageKey", hash: "hash-2" },
			webview as any,
		);
		const panel = provider.openExpandedPanel();
		expect(panel.webview.html).toContain("OpenRouter");
		expect(posted.length).toBeGreaterThan(0);
	});

	it("renders no-key expanded state and handles command failure", async () => {
		const provider = new UsageDashboardProvider();
		provider.renderNoKey();
		const panel = provider.openExpandedPanel();
		(vscode.commands as any).executeCommand = vi.fn(async () => {
			throw new Error("failed");
		});
		const source = { postMessage: vi.fn(async () => true) };
		await provider.handleMessageForTest(
			{ cmd: "openrouter-insights.refreshUsage", requestId: "r2" },
			source as any,
		);
		expect(panel.webview.html).toContain("Connect your OpenRouter account");
		expect(source.postMessage).toHaveBeenCalled();
	});

	it("keeps selection while loading missing usage details", async () => {
		const provider = new UsageDashboardProvider();
		const initial = usage();
		initial.dailyUsageHistory = undefined;
		provider.renderUsage(initial);
		const viewMessages: unknown[] = [];
		const view = {
			webview: {
				options: {},
				html: "",
				postMessage: vi.fn(async (message: unknown) => {
					viewMessages.push(message);
					return true;
				}),
				onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
				onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
			},
			onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
		};
		(vscode.commands as any).executeCommand = vi.fn(async () => undefined);
		provider.resolveWebviewView(view as any, {} as any, {} as any);
		provider.renderLoading();
		provider.renderUsage({ ...initial, selectedKeyHash: null, allKeys: [] } as any);
		provider.switchKey("hash-2");
		const panel = provider.openExpandedPanel();
		provider.renderNoKey();
		provider.renderLoading();
		(panel as any).onDidDispose?.();
		await Promise.resolve();
		expect(viewMessages).toEqual(
			expect.arrayContaining([expect.objectContaining({ cmd: "updateHtml" })]),
		);
		expect((vscode.commands as any).executeCommand).toHaveBeenCalledWith(
			"openrouter-insights.loadUsageDetails",
		);
	});

	it("reports already-selected keys and command failures through the protocol", async () => {
		const provider = new UsageDashboardProvider();
		provider.renderUsage(usage());
		const source = { postMessage: vi.fn(async () => true) };
		(vscode.commands as any).executeCommand = vi.fn(async () => {
			throw new Error("command failed");
		});
		await provider.handleMessageForTest(
			{ cmd: "openrouter-insights.selectUsageKey", hash: "hash-1" },
			source as any,
		);
		await provider.handleMessageForTest(
			{ cmd: "openrouter-insights.selectUsageKey", hash: "hash-2" },
			source as any,
		);
		expect(source.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ liveText: "Key already selected." }),
		);
		expect(source.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ ok: false, liveText: "command failed" }),
		);
	});

	it("does not switch a key before usage data exists and preserves a prior selection", () => {
		const provider = new UsageDashboardProvider();
		provider.switchKey("missing");
		provider.renderUsage({ ...usage(), selectedKeyHash: "hash-1" });
		provider.renderUsage({ ...usage(), selectedKeyHash: null, allKeys: [] } as any);
		expect(provider.getLastUsage()?.selectedKeyHash).toBe("hash-1");
	});

	it("clears a disposed sidebar view before a replacement resolves", () => {
		const provider = new UsageDashboardProvider();
		let fireDispose: (() => void) | undefined;
		const view = {
			webview: {
				options: {},
				html: "",
				postMessage: vi.fn(async () => true),
				onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
				onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
			},
			onDidDispose: (listener: () => void) => {
				fireDispose = listener;
				return { dispose: vi.fn() };
			},
		};
		provider.resolveWebviewView(view as any, {} as any, {} as any);
		fireDispose?.();
		provider.renderNoKey();
		const replacement = { ...view, webview: { ...view.webview, html: "" } };
		provider.resolveWebviewView(replacement as any, {} as any, {} as any);
		expect(replacement.webview.html).toContain("Connect your OpenRouter account");
	});

	it("skips render when usage data hasn't changed", () => {
		const provider = new UsageDashboardProvider();
		const viewMessages: unknown[] = [];
		const view = {
			webview: {
				options: {},
				html: "",
				postMessage: vi.fn(async (message: unknown) => {
					viewMessages.push(message);
					return true;
				}),
				onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
				onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
			},
			onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
		};
		provider.resolveWebviewView(view as any, {} as any, {} as any);

		const initialUsage = usage();
		provider.renderUsage(initialUsage);

		// Clear messages to track only the second render
		viewMessages.length = 0;

		// Render with identical data - should be skipped
		provider.renderUsage(initialUsage);

		// No dashboard update message should be sent
		const updateMessages = viewMessages.filter(
			(m) =>
				m &&
				typeof m === "object" &&
				"cmd" in m &&
				(m.cmd === "updateHtml" || m.cmd === "updateRegion"),
		);
		expect(updateMessages).toHaveLength(0);
	});

	it("renders when usage data changes", () => {
		const provider = new UsageDashboardProvider();
		const viewMessages: unknown[] = [];
		const view = {
			webview: {
				options: {},
				html: "",
				postMessage: vi.fn(async (message: unknown) => {
					viewMessages.push(message);
					return true;
				}),
				onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
				onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
			},
			onDidDispose: (_listener: () => void) => ({ dispose: vi.fn() }),
		};
		provider.resolveWebviewView(view as any, {} as any, {} as any);

		const initialUsage = usage();
		provider.renderUsage(initialUsage);

		// Clear messages to track only the second render
		viewMessages.length = 0;

		// Render with different data - should send update
		const changedUsage = { ...initialUsage, totalUsed: 2 };
		provider.renderUsage(changedUsage);

		const updateMessages = viewMessages.filter(
			(m) =>
				m &&
				typeof m === "object" &&
				"cmd" in m &&
				(m.cmd === "updateHtml" || m.cmd === "updateRegion"),
		);
		expect(updateMessages).toHaveLength(1);
	});
});
