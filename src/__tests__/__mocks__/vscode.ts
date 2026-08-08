/**
 * Minimal vscode stub for unit tests. Exports just enough of the VS Code
 * API surface to keep the test imports happy.
 */

export class ThemeColor {
	constructor(_color: string) {}
}

export class ThemeIcon {
	constructor(readonly id: string) {}
}

export enum StatusBarAlignment {
	Right = 2,
	Left = 1,
}

export const window = {
	state: { focused: true },
	activeTextEditor: undefined as unknown,
	_quickPicks: [] as unknown[],
	_activeEditorListeners: [] as unknown[],
	createTextEditorDecorationType: (_options: unknown) => ({ dispose: () => {} }),
	showSaveDialog: async () => undefined as Uri | undefined,
	showQuickPick: async <T = unknown>(_items: readonly T[]) => undefined as T | undefined,
	showInputBox: async () => undefined as string | undefined,
	withProgress: async <T>(_options: unknown, task: () => Promise<T>) => task(),
	createQuickPick: <T = unknown>() => {
		const acceptListeners: Array<() => void> = [];
		const hideListeners: Array<() => void> = [];
		let buttonListener: ((event: unknown) => void) | undefined;
		const quickPick = {
			title: "",
			placeholder: "",
			matchOnDescription: false,
			matchOnDetail: false,
			items: [] as T[],
			selectedItems: [] as T[],
			canSelectMany: false,
			onDidAccept: (listener: () => void) => {
				acceptListeners.push(listener);
				return { dispose: () => {} };
			},
			onDidHide: (listener: () => void) => {
				hideListeners.push(listener);
				return { dispose: () => {} };
			},
			onDidTriggerItemButton: (listener: (event: unknown) => void) => {
				buttonListener = listener;
				return { dispose: () => {} };
			},
			show: () => {},
			dispose: () => {},
			triggerAccept: () => acceptListeners.forEach((listener) => listener()),
			triggerHide: () => hideListeners.forEach((listener) => listener()),
			triggerButton: (event: unknown) => buttonListener?.(event),
		};
		(window as typeof window)._quickPicks.push(quickPick);
		return quickPick;
	},
	onDidChangeActiveTextEditor: (listener: unknown) => {
		window._activeEditorListeners.push(listener);
		return { dispose: () => {} };
	},
	showInformationMessage: () => undefined,
	showWarningMessage: () => undefined,
	showErrorMessage: () => undefined,
	createOutputChannel: () => ({
		appendLine: () => {},
		show: () => {},
		dispose: () => {},
	}),
	createStatusBarItem: (_id?: string, _alignment?: StatusBarAlignment, _priority?: number) => ({
		name: "",
		text: "",
		tooltip: "",
		command: "",
		backgroundColor: undefined as ThemeColor | undefined,
		show: () => {},
		hide: () => {},
		dispose: () => {},
	}),
	registerWebviewViewProvider: (_viewId: string, _provider: unknown) => ({ dispose: () => {} }),
	createWebviewPanel: () => ({
		webview: {
			options: {},
			html: "",
			postMessage: async () => true,
			onDidReceiveMessage: () => ({ dispose: () => {} }),
		},
		onDidDispose: () => ({ dispose: () => {} }),
		dispose: () => {},
	}),
};

export const workspace = {
	_textDocumentListeners: [] as unknown[],
	_watchers: [] as unknown[],
	_configValues: {} as Record<string, unknown>,
	getConfiguration: (_section?: string) => ({
		get: <T>(key: string, fallback: T): T => {
			// ConfigService uses features.<name>.enabled within the section.
			const mockVal = (workspace as any)._configValues[key];
			if (mockVal !== undefined) return mockVal as T;
			return fallback;
		},
		update: async () => {},
	}),
	_createConfigListeners: [] as Array<
		(event: { affectsConfiguration: (key: string) => boolean }) => void
	>,
	onDidChangeConfiguration: (
		listener?: (event: { affectsConfiguration: (key: string) => boolean }) => void,
	) => {
		if (listener) workspace._createConfigListeners.push(listener);
		return { dispose: () => {} };
	},
	createFileSystemWatcher: (_pattern: unknown) => {
		const watcher = {
			onDidChange: (_listener?: unknown) => ({ dispose: () => {} }),
			onDidCreate: (_listener?: unknown) => ({ dispose: () => {} }),
			onDidDelete: (_listener?: unknown) => ({ dispose: () => {} }),
			dispose: () => {},
		};
		workspace._watchers.push(watcher);
		return watcher;
	},
	onDidChangeTextDocument: (listener: unknown) => {
		workspace._textDocumentListeners.push(listener);
		return { dispose: () => {} };
	},
};

export const commands = {
	executeCommand: (..._args: unknown[]) => undefined,
	registerCommand: (_command: string, _callback: (...args: unknown[]) => unknown) => ({
		dispose: () => {},
	}),
};

export class EventEmitter {
	private listeners: Array<(..._args: unknown[]) => void> = [];
	event = (listener: (..._args: unknown[]) => void) => {
		this.listeners.push(listener);
		return {
			dispose: () => {
				this.listeners = [];
			},
		};
	};
	fire(...args: unknown[]) {
		this.listeners.forEach((l) => l(...args));
	}
	dispose() {
		this.listeners = [];
	}
}

export class Disposable {
	static from(...disposables: Array<{ dispose: () => void }>) {
		return { dispose: () => disposables.forEach((disposable) => disposable.dispose()) };
	}
	constructor(private readonly callback?: () => void) {}
	dispose() {
		this.callback?.();
	}
}

export class Uri {
	static file(fsPath: string) {
		return { fsPath, toString: () => fsPath } as unknown as Uri;
	}

	static parse(s: string) {
		return { fsPath: s, toString: () => s } as unknown as Uri;
	}
}

export class MarkdownString {
	constructor(value = "", _supportThemeIcons?: boolean) {
		this.value = value;
	}
	value: string;
	isTrusted = false;
	supportHtml = false;
	supportThemeIcons = false;
	appendMarkdown(value: string) {
		this.value += value;
		return this;
	}
	appendCodeblock(value: string) {
		this.value += value;
		return this;
	}
	appendText(value: string) {
		this.value += value;
		return this;
	}
}

export class RelativePattern {
	constructor(_base: string, _pattern: string) {}
}

export enum ConfigurationTarget {
	Global = 1,
	Workspace = 2,
	WorkspaceFolder = 3,
}

export const env = {
	appName: "Code",
	language: "en",
	clipboard: { writeText: async (_value: string) => {} },
	openExternal: async (_uri: Uri) => true,
};

export const languages = {
	_hoverProviders: [] as unknown[],
	registerHoverProvider: (_selector: unknown, provider: unknown) => {
		languages._hoverProviders.push(provider);
		return { dispose: () => {} };
	},
};

export class Position {
	constructor(
		readonly line: number,
		readonly character: number,
	) {}
}

export class Range {
	constructor(
		readonly start: Position,
		readonly end: Position,
	) {}
}

export class Hover {
	constructor(
		readonly contents: unknown,
		readonly range?: Range,
	) {}
}

export const ProgressLocation = { Notification: 15 };

export enum ViewColumn {
	Active = -1,
}

export class CancellationTokenSource {
	token = {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose: () => {} }),
	};
	cancel() {}
	dispose() {}
}
