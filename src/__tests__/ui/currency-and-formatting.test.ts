import { describe, expect, it } from "vitest";
import {
	resolveRate,
	convertFromUsd,
	currencySymbol,
	isApproximate,
	formatCurrencyPrice,
} from "../../ui/formatting/currencyService";
import {
	fmtPrice,
	truncate,
	coerceNum,
	escapeMarkdown,
	fmtBlendPct,
} from "../../ui/formatting/formatting";
import { escapeHtml } from "../../ui/escapeHtml";
import { classifyError } from "../../api/transport/fetchHelpers";

describe("resolveRate", () => {
	it("uses a positive override rate", () => expect(resolveRate("EUR", 0.95)).toBe(0.95));
	it("uses the built-in rate when the override is zero or negative", () => {
		expect(resolveRate("EUR", 0)).toBe(0.92);
		expect(resolveRate("EUR", -5)).toBe(0.92);
	});
	it("preserves USD overrides and defaults unknown currencies to one", () => {
		expect(resolveRate("USD", 0)).toBe(1);
		expect(resolveRate("USD", 1.5)).toBe(1.5);
		expect(resolveRate("XYZ", 0)).toBe(1);
	});
});

describe("convertFromUsd", () => {
	it("converts USD using built-in rates", () => {
		expect(convertFromUsd(10, "EUR")).toBeCloseTo(9.2, 1);
		expect(convertFromUsd(1, "JPY")).toBeCloseTo(149.5, 0);
	});
	it("uses an override rate and leaves USD unchanged", () => {
		expect(convertFromUsd(10, "EUR", 1)).toBe(10);
		expect(convertFromUsd(10, "USD")).toBe(10);
	});
});

describe("currency formatting", () => {
	it("returns symbols for supported and unknown currencies", () => {
		expect(currencySymbol("USD")).toBe("$");
		expect(currencySymbol("EUR")).toBe("€");
		expect(currencySymbol("GBP")).toBe("£");
		expect(currencySymbol("JPY")).toBe("¥");
		expect(currencySymbol("INR")).toBe("₹");
		expect(currencySymbol("XYZ")).toBe("$");
	});
	it("marks non-USD rates as approximate", () => {
		expect(isApproximate("USD")).toBe(false);
		expect(isApproximate("EUR")).toBe(true);
		expect(isApproximate("JPY")).toBe(true);
	});
	it("formats USD, foreign currency, and locale-specific prices", () => {
		expect(formatCurrencyPrice(5.5, "USD")).not.toContain("~");
		expect(formatCurrencyPrice(5.5, "EUR")).toContain("~€");
		expect(formatCurrencyPrice(1, "JPY")).toContain("¥");
		// Now uses VS Code display language (vscode.env.language) instead of passed locale
		expect(formatCurrencyPrice(1234.56, "USD")).toBe(formatCurrencyPrice(1234.56, "USD"));
	});

	it("formats non-decimal currencies and falls back for invalid locales", () => {
		expect(formatCurrencyPrice(1, "KRW")).toBe("~₩1,315");
		expect(formatCurrencyPrice(1, "CNY")).toBe("~¥7.25");
	});

	it("uses the fixed fallback formatter when locale is empty", () => {
		expect(formatCurrencyPrice(1.234, "USD")).toBe("$1.23");
	});
});

describe("formatting helpers", () => {
	it("formats invalid, free, small, and large prices", () => {
		expect(fmtPrice(undefined)).toBe("?");
		expect(fmtPrice(NaN)).toBe("?");
		expect(fmtPrice(0)).toBe("free");
		expect(fmtPrice(0.005)).toBe("0.005");
		expect(fmtPrice(0.5)).toBe("0.50");
		expect(fmtPrice(5.678)).toBe("5.68");
		expect(fmtPrice(15.678)).toBe("15.7");
	});
	it("truncates only values longer than the limit", () => {
		expect(truncate("hello", 10)).toBe("hello");
		expect(truncate("hello world", 8)).toBe("hello w…");
		expect(truncate("hello", 5)).toBe("hello");
	});
	it("coerces missing and invalid numbers to zero", () => {
		expect(coerceNum(undefined)).toBe(0);
		expect(coerceNum(null)).toBe(0);
		expect(coerceNum(NaN)).toBe(0);
		expect(coerceNum(42)).toBe(42);
	});
	it("escapes Markdown punctuation", () => {
		expect(escapeMarkdown("`**_[link]")).toBe("\\`\\*\\*\\_\\[link\\]");
	});
});

describe("fmtBlendPct", () => {
	it("formats whole number percentages", () => {
		expect(fmtBlendPct(0.12)).toBe("12%");
		expect(fmtBlendPct(0.5)).toBe("50%");
		expect(fmtBlendPct(0)).toBe("0%");
		expect(fmtBlendPct(1)).toBe("100%");
	});
	it("formats decimal percentages with one decimal place", () => {
		expect(fmtBlendPct(0.125)).toBe("12.5%");
		expect(fmtBlendPct(0.055)).toBe("5.5%");
		expect(fmtBlendPct(0.333)).toBe("33.3%");
	});
	it("handles edge cases", () => {
		expect(fmtBlendPct(0.123)).toBe("12.3%");
		expect(fmtBlendPct(0.999)).toBe("99.9%");
	});
});

describe("escapeHtml", () => {
	it("escapes every supported special character", () => {
		expect(escapeHtml("<>&\"'")).toBe("&lt;&gt;&amp;&quot;&#39;");
	});
	it("leaves plain text unchanged", () => {
		expect(escapeHtml("Hello World")).toBe("Hello World");
	});
});

describe("classifyError", () => {
	it.each([
		[401, "permanent"],
		[403, "permanent"],
		[429, "transient"],
		[500, "transient"],
	])("classifies HTTP status %s as %s", (statusCode, kind) => {
		const error = Object.assign(new Error("request failed"), { statusCode });
		expect(classifyError(error)).toMatchObject({ kind, code: statusCode });
	});
	it("classifies abort and connection errors as transient", () => {
		expect(classifyError(new DOMException("Aborted", "AbortError"))).toMatchObject({
			kind: "transient",
			message: "Request timed out",
		});
		expect(classifyError(new TypeError("fetch failed: ECONNREFUSED"))).toMatchObject({
			kind: "transient",
		});
	});
	it("classifies code errors and generic errors as permanent", () => {
		expect(classifyError(new TypeError("Cannot read properties of undefined"))).toMatchObject({
			kind: "permanent",
		});
		expect(classifyError(new Error("Something happened"))).toMatchObject({ kind: "permanent" });
	});
});
