/**
 * ModelHoverProvider — VS Code hover provider that detects OpenRouter
 * model ID strings (e.g. "openai/gpt-4o") in source files and shows
 * pricing tooltips on hover.
 *
 * Useful for config files, JSON settings, and any code that references
 * model IDs — developers see cost, context length, and deprecation
 * status without leaving the editor.
 *
 * Registered for all language modes so it works in any file type.
 * Feature-gated via FeatureRegistry (hoverProvider feature ID).
 */

import * as vscode from "vscode";
import type { IPricingIndex } from "../../api/cache/pricingStore";
import { findModelVariant } from "../../api/clients/pricingService";
import { buildTooltipMd } from "../formatting/formatting";

/**
 * Word pattern that matches `/` — model IDs like "openai/gpt-4o"
 * are a single word unit for hover detection purposes.
 *
 * Covers common model ID characters: alphanumeric, `/`, `-`, `_`, `.`, `:`, `+`.
 * Stops at whitespace and delimiters like `,`, `;`, `"`, `'`, `(`, `)`, `[`, `]`.
 */
const MODEL_ID_WORD_PATTERN = /[a-zA-Z0-9/\-_.:+]+/;

/**
 * Regex to find all model-ID-shaped tokens in a document.
 * Uses lookbehind/ahead for delimiter boundaries and the same character
 * class as MODEL_ID_WORD_PATTERN. The `\b` before the provider prefix
 * handles the common `provider/model-name` shape.
 */
const MODEL_ID_SCAN_RE = /\b[a-zA-Z0-9][a-zA-Z0-9\-_.]*\/[a-zA-Z0-9/\-_.:]+/g;

/** Debounce interval (ms) for re-scanning decorations after document edits. */
const DECORATION_DEBOUNCE_MS = 300;

/**
 * Subtle dotted underline — the canonical VS Code idiom for
 * "this text carries extra information on hover."
 *
 * Uses a muted amber tone that is visible but not distracting.
 * High-contrast themes get a slightly brighter variant.
 */
const HOVER_HINT_DECORATION = vscode.window.createTextEditorDecorationType({
	textDecoration: "underline dotted rgba(180, 150, 80, 0.55)",
	dark: {
		textDecoration: "underline dotted rgba(200, 170, 90, 0.5)",
	},
	light: {
		textDecoration: "underline dotted rgba(170, 140, 60, 0.45)",
	},
});

/**
 * Create a VS Code hover provider + editor decorations that show pricing
 * for recognized OpenRouter model IDs.
 *
 * Returns a composite disposable covering:
 *   - HoverProvider (tooltip on hover)
 *   - TextEditorDecorationType (subtle underline on recognized IDs)
 *   - Editor/document change listeners (re-scan on edit/switch)
 *
 * @param pricingIndex  Source of pricing data (IPricingIndex from cache)
 * @param cacheAgeNote  Footer note appended to tooltip (e.g. " | Cached 5m ago")
 */
export function registerModelHoverProvider(
	pricingIndex: IPricingIndex,
	cacheAgeNote: () => string,
): vscode.Disposable {
	// ── Hover provider ──────────────────────────────────────
	const hoverRegistration = vscode.languages.registerHoverProvider(
		{ scheme: "file" },
		{
			provideHover(
				document: vscode.TextDocument,
				position: vscode.Position,
			): vscode.Hover | undefined {
				const wordRange = document.getWordRangeAtPosition(position, MODEL_ID_WORD_PATTERN);
				if (!wordRange) return undefined;

				const word = document.getText(wordRange);
				if (!word || word.length < 3) return undefined;
				if (!word.includes("/")) return undefined;

				const info = findModelVariant(pricingIndex.getValues(), pricingIndex.getLookup(), word);
				if (!info) return undefined;

				const note = cacheAgeNote();
				const markdown = buildTooltipMd(info, note ? `  \n*${note}*` : "");

				return new vscode.Hover(markdown, wordRange);
			},
		},
	);

	// ── Decorations ─────────────────────────────────────────
	const decorateEditors = new Map<vscode.TextEditor, vscode.Disposable>();
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Scan a document for model IDs, decorate every match found in
	 * the pricing index. Returns the combined decoration ranges.
	 */
	function scanAndDecorate(editor: vscode.TextEditor): void {
		if (editor.document.isClosed) return;

		const decorations: vscode.DecorationOptions[] = [];
		const text = editor.document.getText();

		for (const match of text.matchAll(MODEL_ID_SCAN_RE)) {
			const word = match[0];
			if (!findModelVariant(pricingIndex.getValues(), pricingIndex.getLookup(), word)) continue;

			const start = editor.document.positionAt(match.index);
			const end = editor.document.positionAt(match.index + word.length);
			decorations.push({ range: new vscode.Range(start, end) });
		}

		editor.setDecorations(HOVER_HINT_DECORATION, decorations);
	}

	/** Debounced wrapper — avoids thrashing during rapid typing. */
	function scheduleDecorate(editor: vscode.TextEditor): void {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => scanAndDecorate(editor), DECORATION_DEBOUNCE_MS);
	}

	// ── Editor lifecycle ────────────────────────────────────
	function attach(editor: vscode.TextEditor | undefined): void {
		if (editor?.document.uri.scheme !== "file") return;

		if (decorateEditors.has(editor)) return;

		const docListener = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document === editor.document) scheduleDecorate(editor);
		});

		decorateEditors.set(editor, docListener);
		scanAndDecorate(editor);
	}

	function detach(editor: vscode.TextEditor): void {
		const d = decorateEditors.get(editor);
		if (d) {
			editor.setDecorations(HOVER_HINT_DECORATION, []);
			d.dispose();
			decorateEditors.delete(editor);
		}
	}

	attach(vscode.window.activeTextEditor);

	const editorSwitchListener = vscode.window.onDidChangeActiveTextEditor((next) => {
		if (vscode.window.activeTextEditor) detach(vscode.window.activeTextEditor);
		attach(next);
	});

	return vscode.Disposable.from(hoverRegistration, HOVER_HINT_DECORATION, editorSwitchListener, {
		dispose: () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			for (const [editor, d] of decorateEditors) {
				editor.setDecorations(HOVER_HINT_DECORATION, []);
				d.dispose();
			}
			decorateEditors.clear();
		},
	});
}
