/**
 * StatusBarView — pure presentation layer.
 * Receives pre-formatted strings and renders the status bar item.
 * Contains zero business logic.
 *
 * Also handles loading-indicator state: showLoading() / clearLoading()
 * provide idempotent visual feedback during async operations.
 */

import * as vscode from "vscode";

export interface StatusBarViewModel {
	text: string;
	tooltip: vscode.MarkdownString;
	backgroundColor?: vscode.ThemeColor;
	show: boolean;
}

export class StatusBarView implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private enabled = true;
	private _savedText = "";
	private _savedTooltip: vscode.MarkdownString | undefined;
	private _savedBg: vscode.ThemeColor | undefined;
	private _loading = false;
	private static readonly LOADING_TEXT = "$(loading~spin) Refreshing…";

	constructor() {
		this.item = vscode.window.createStatusBarItem(
			"openrouter-insights.pricing",
			vscode.StatusBarAlignment.Right,
		);
		this.item.name = "OpenRouter Pricing";
		this.item.command = "openrouter-insights.browseModels";
		this.item.text = "Loading OpenRouter pricing…";
		this.item.tooltip = new vscode.MarkdownString("Loading OpenRouter pricing…");
		this.item.show();
	}

	/** Enable/disable the status bar item. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (enabled) {
			this.item.show();
		} else {
			this.item.hide();
		}
	}

	/** Change the command that runs when the status bar item is clicked. */
	setCommand(command: string): void {
		this.item.command = command;
	}

	/** Apply a fully-resolved view model to the status bar. */
	render(vm: StatusBarViewModel): void {
		if (!this.enabled) return;
		if (!vm.show) {
			this.item.hide();
			return;
		}
		this.item.text = vm.text;
		this.item.tooltip = vm.tooltip;
		this.item.backgroundColor = vm.backgroundColor;
		this.item.show();
	}

	/**
	 * Show a loading indicator on the status bar (idempotent).
	 * Saves current text so clearLoading() can restore it.
	 */
	showLoading(): void {
		if (this._loading) return;
		this._savedText = this.item.text;
		this._savedTooltip =
			this.item.tooltip instanceof vscode.MarkdownString ? this.item.tooltip : undefined;
		this._savedBg = this.item.backgroundColor;
		this._loading = true;
		this.item.text = StatusBarView.LOADING_TEXT;
		this.item.tooltip = new vscode.MarkdownString("Fetching latest pricing from OpenRouter…");
		this.item.backgroundColor = undefined;
		this.item.show();
	}

	/**
	 * Clear the loading indicator and restore the previous state.
	 * Safe to call even when not in loading state.
	 *
	 * Only restores the saved text when the loading indicator is still showing.
	 * A `render()` call between `showLoading()` and `clearLoading()` (for
	 * example the status-bar use case publishing fresh pricing) supersedes the
	 * loading state; restoring the previously saved text there would wipe the
	 * freshly rendered content and leave the item blank/invisible.
	 */
	clearLoading(): void {
		if (!this._loading) return;
		this._loading = false;
		if (this.item.text === StatusBarView.LOADING_TEXT) {
			this.item.text = this._savedText;
			if (this._savedTooltip) {
				this.item.tooltip = this._savedTooltip;
			}
			this.item.backgroundColor = this._savedBg;
		}
		if (this.enabled && this.item.text) {
			this.item.show();
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
