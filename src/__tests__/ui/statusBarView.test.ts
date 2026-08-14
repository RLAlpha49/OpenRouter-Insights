/**
 * Regression tests for StatusBarView — specifically the loading-indicator
 * restore logic that previously wiped freshly rendered pricing and left the
 * status bar blank/invisible after a refresh.
 */

import * as vscode from "vscode";
import { StatusBarView } from "../../ui/status/statusBarView";

const LOADING_TEXT = "$(loading~spin) Refreshing…";

function makeItem(): vscode.StatusBarItem {
	return {
		name: "",
		text: "",
		tooltip: "",
		command: "",
		backgroundColor: undefined,
		show: () => {},
		hide: () => {},
		dispose: () => {},
	} as unknown as vscode.StatusBarItem;
}

describe("StatusBarView loading indicator", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("shows initial loading text in the constructor", () => {
		let item: vscode.StatusBarItem | undefined;
		vi.spyOn(vscode.window, "createStatusBarItem").mockImplementation(() => {
			item = makeItem();
			return item;
		});
		new StatusBarView();
		expect(item!.text).toBe("Loading OpenRouter pricing…");
	});

	it("preserves freshly rendered content across showLoading/clearLoading", () => {
		let item: vscode.StatusBarItem | undefined;
		vi.spyOn(vscode.window, "createStatusBarItem").mockImplementation(() => {
			item = makeItem();
			return item;
		});
		const view = new StatusBarView();

		view.showLoading();
		expect(item!.text).toBe(LOADING_TEXT);

		// The status-bar use case publishes fresh pricing while loading is active.
		view.render({
			text: "GPT-4 $0.01/$0.03",
			tooltip: new vscode.MarkdownString("priced"),
			show: true,
		});
		expect(item!.text).toBe("GPT-4 $0.01/$0.03");

		// clearLoading must NOT clobber the freshly rendered content.
		view.clearLoading();
		expect(item!.text).toBe("GPT-4 $0.01/$0.03");
	});

	it("restores the previously saved text when nothing superseded loading", () => {
		let item: vscode.StatusBarItem | undefined;
		vi.spyOn(vscode.window, "createStatusBarItem").mockImplementation(() => {
			item = makeItem();
			return item;
		});
		const view = new StatusBarView();
		view.render({
			text: "GPT-4 $0.01/$0.03",
			tooltip: new vscode.MarkdownString("priced"),
			show: true,
		});

		view.showLoading();
		expect(item!.text).toBe(LOADING_TEXT);

		// No render between show/clear — the saved content must be restored.
		view.clearLoading();
		expect(item!.text).toBe("GPT-4 $0.01/$0.03");
	});
});
