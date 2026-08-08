/**
 * Escape HTML special characters. Covers & < > " ' to prevent XSS
 * when inserting API data (model names, descriptions) into webview HTML.
 */
export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
