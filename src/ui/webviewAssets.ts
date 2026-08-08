import {
	bridgeScriptSource,
	comparisonDocument,
	dashboardDocument,
	dashboardWideDocument,
	designSystemCssSource,
	detailDocument,
} from "./generated/webviewAssets.generated";
import { randomBytes } from "node:crypto";

/** Shared palette retained as TypeScript data for dynamic inline colors. */
export const PALETTE = {
	amber: "#f0c674",
	amberDim: "#c9a44c",
	amberGlow: "rgba(240, 198, 116, 0.15)",
	teal: "#56d4dd",
	tealDim: "#3a9ba3",
	tealGlow: "rgba(86, 212, 221, 0.12)",
	red: "#f85149",
	green: "#3fb950",
	orange: "#d29922",
	muted: "#9ba3b0",
	mutedDim: "#7a8290",
	bg: "#0d1117",
	surface: "#161b22",
	surfaceRaised: "#1c2128",
	border: "rgba(240, 246, 252, 0.08)",
	borderStrong: "rgba(240, 246, 252, 0.14)",
	text: "#e6edf3",
	textDim: "#adbac7",
} as const;

export function designSystemCss(): string {
	return `<style>\n${designSystemCssSource}\n</style>`;
}

export function bridgeScript(nonce: string): string {
	return `<script nonce="${nonce}">\n${bridgeScriptSource}\n</script>`;
}

function replaceTemplate(source: string, values: Record<string, string>): string {
	return Object.entries(values).reduce(
		(result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
		source,
	);
}

export function buildDashboardDocument(body: string, wide = false, nonce = createNonce()): string {
	return replaceTemplate(wide ? dashboardWideDocument : dashboardDocument, {
		BODY: body,
		DESIGN_SYSTEM_CSS: designSystemCss(),
		BRIDGE_SCRIPT: bridgeScript(nonce),
		NONCE: nonce,
	});
}

function createNonce(): string {
	return randomBytes(16).toString("base64url");
}

export function buildDetailDocument(title: string, body: string): string {
	return replaceTemplate(detailDocument, {
		TITLE: title,
		BODY: body,
		DESIGN_SYSTEM_CSS: designSystemCss(),
	});
}

export function buildComparisonDocument(body: string): string {
	return replaceTemplate(comparisonDocument, {
		BODY: body,
		DESIGN_SYSTEM_CSS: designSystemCss(),
	});
}

/** Escape a string for safe use in an HTML data-* attribute value. */
export function attr(s: string): string {
	return s
		.replaceAll("&", "\u0026")
		.replaceAll('"', "\u0022")
		.replaceAll("<", "\u003C")
		.replaceAll(">", "\u003E");
}

/** Escape a string for safe HTML text content. */
export function text(s: string): string {
	return s.replaceAll("&", "\u0026").replaceAll("<", "\u003C").replaceAll(">", "\u003E");
}
