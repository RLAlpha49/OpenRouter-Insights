/**
 * Currency conversion — static exchange rates to avoid network
 * dependency. Rates sourced from mid-market data and represent
 * approximate values. Users can override rates via the
 * `openrouterInsights.general.currencyRate` setting.
 *
 * All non-USD formatted prices are prefixed with "~" to indicate
 * they are approximate conversions of the authoritative USD pricing.
 *
 * Keys: OpenRouter /api/v1/models always returns USD.
 * Conversions: multiply USD value by rate to get target currency.
 */

import * as vscode from "vscode";

/** Static USD → currency rates (approximate, mid-market). */
const EXCHANGE_RATES: Record<string, number> = {
	USD: 1.0,
	EUR: 0.92,
	GBP: 0.79,
	JPY: 149.5,
	KRW: 1315.0,
	CNY: 7.25,
	INR: 83.5,
	CAD: 1.37,
	AUD: 1.53,
	BRL: 5.15,
};

/** Currency symbol per ISO code. */
const CURRENCY_SYMBOLS: Record<string, string> = {
	USD: "$",
	EUR: "€",
	GBP: "£",
	JPY: "¥",
	KRW: "₩",
	CNY: "¥",
	INR: "₹",
	CAD: "C$",
	AUD: "A$",
	BRL: "R$",
};

/**
 * Resolve the effective exchange rate, preferring a user override
 * if set. Returns the rate factor (multiply USD by this to get target).
 */
export function resolveRate(currency: string, overrideRate: number): number {
	if (overrideRate > 0) return overrideRate;
	return EXCHANGE_RATES[currency] ?? 1.0;
}

/**
 * Convert a USD value to the configured currency.
 * Accepts an optional rate override from user settings.
 * Returns the converted numeric value (not formatted).
 */
export function convertFromUsd(
	usdValue: number,
	currency: string,
	overrideRate: number = 0,
): number {
	const rate = resolveRate(currency, overrideRate);
	return usdValue * rate;
}

/** Return the currency's symbol (e.g. "$", "€"). */
export function currencySymbol(currency: string): string {
	return CURRENCY_SYMBOLS[currency] ?? "$";
}

/**
 * Whether the currency is not USD. Used to decide if "~" prefix
 * should be prepended to formatted values.
 */
export function isApproximate(currency: string): boolean {
	return currency !== "USD";
}

/**
 * Format a numeric value as a price string using locale-aware formatting.
 *
 * @param usdValue      Price in USD
 * @param currency      Target currency code (e.g. "EUR")
 * @param overrideRate  Optional user-configured exchange rate override
 * @returns Formatted price string like "~€1.23" or "¥150"
 */
export function formatCurrencyPrice(
	usdValue: number,
	currency: string,
	overrideRate: number = 0,
): string {
	const converted = convertFromUsd(usdValue, currency, overrideRate);
	const symbol = currencySymbol(currency);
	const approx = isApproximate(currency) ? "~" : "";

	// JPY and KRW have no decimal subunits — show as integers
	const isNoDecimal = currency === "JPY" || currency === "KRW";
	let decimals: number;
	if (isNoDecimal) {
		decimals = 0;
	} else if (converted < 10) {
		decimals = 2;
	} else {
		decimals = 1;
	}

	const locale = vscode.env.language;
	try {
		const fmt = new Intl.NumberFormat(locale, {
			style: "decimal",
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals,
		});
		return `${approx}${symbol}${fmt.format(isNoDecimal ? Math.round(converted) : converted)}`;
	} catch {}

	const rounded = isNoDecimal ? Math.round(converted).toString() : converted.toFixed(decimals);

	return `${approx}${symbol}${rounded}`;
}
