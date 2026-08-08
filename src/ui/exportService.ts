/**
 * ExportService — writes pricing data to CSV or JSON format.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import type { ModelPricingInfo } from "../types";
import { log, formatError, formatErrorBrief } from "../infrastructure/logger";

/**
 * Export the model pricing array as CSV.
 * Columns: id, name, prompt, completion, image, request, cache_read, cache_write,
 *   web_search, internal_reasoning, blended_rate, context_length, deprecated
 */
function toCsv(models: ModelPricingInfo[]): string {
	const header = [
		"id",
		"name",
		"prompt_per_1M",
		"completion_per_1M",
		"image_per_1M",
		"request_per_1M",
		"cache_read_per_1M",
		"cache_write_per_1M",
		"web_search_per_1M",
		"internal_reasoning_per_1M",
		"blended_rate_per_1M",
		"context_length",
		"deprecated",
	].join(",");

	const rows = models.map((m) =>
		[
			csvEscape(m.id),
			csvEscape(m.name),
			m.perMillion.prompt,
			m.perMillion.completion,
			m.perMillion.image,
			m.perMillion.request,
			m.perMillion.inputCacheRead,
			m.perMillion.inputCacheWrite,
			m.perMillion.webSearch,
			m.perMillion.internalReasoning,
			m.blendedRate,
			m.contextLength,
			m.isDeprecated ? "yes" : "no",
		].join(","),
	);

	return [header, ...rows].join("\n") + "\n";
}

/** Escape a field for CSV (quote if it contains commas, quotes, or newlines). */
function csvEscape(s: string): string {
	if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
		return `"${s.replaceAll('"', '""')}"`;
	}
	return s;
}

/**
 * Prompt the user for a file save location and export pricing data.
 * Supports CSV (compact, spreadsheet-ready) and JSON (full fidelity).
 */
export async function exportPricing(
	models: ModelPricingInfo[],
	format: "csv" | "json",
): Promise<void> {
	log.info(`exportPricing: requested ${format} export of ${models.length} models`);

	if (models.length === 0) {
		log.warn("exportPricing: no pricing data to export");
		void vscode.window.showWarningMessage("No pricing data to export.");
		return;
	}

	const ext = format === "csv" ? "CSV" : "JSON";
	const uri = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(`openrouter-pricing.${format}`),
		filters: {
			[ext]: [format],
			"All Files": ["*"],
		},
	});

	if (!uri) {
		log.info("exportPricing: user cancelled save dialog");
		return;
	}

	const expectedExt = `.${format}`;
	if (!uri.fsPath.toLowerCase().endsWith(expectedExt)) {
		log.warn(
			`exportPricing: file extension mismatch — expected ${expectedExt}, got "${uri.fsPath}"`,
		);
		void vscode.window.showWarningMessage(
			`Export cancelled: the selected file must have a .${format} extension.`,
		);
		return;
	}

	try {
		const content = format === "csv" ? toCsv(models) : JSON.stringify(models, null, 2);
		const sizeBytes = Buffer.byteLength(content, "utf-8");
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "Exporting pricing…" },
			async () => {
				await fs.promises.writeFile(uri.fsPath, content, "utf-8");
			},
		);
		log.info(`exportPricing: wrote ${sizeBytes} bytes (${format}) to "${uri.fsPath}"`);
		void vscode.window.showInformationMessage(`Exported ${models.length} models to ${uri.fsPath}`);
	} catch (err) {
		log.error("exportPricing: write failed:", formatError(err));
		void vscode.window.showErrorMessage(`Export failed: ${formatErrorBrief(err)}`);
	}
}
