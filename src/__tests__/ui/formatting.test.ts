import { describe, expect, it } from "vitest";
import {
	formatDateOnly,
	formatShortDateLabel,
	formatTimestamp,
	formatTokenCount,
	formatDetailPrice,
} from "../../ui/formatting/formatting";

describe("shared UI date formatting", () => {
	it("formats short chart labels with the UTC calendar date", () => {
		expect(formatShortDateLabel("2026-08-01")).toBe("Aug 1");
	});

	it("formats date-only values with the UTC calendar date", () => {
		expect(formatDateOnly("2026-08-01T23:30:00-05:00")).toBe("Aug 2, 2026");
	});

	it("formats timestamps in the user's local time zone", () => {
		const expected = new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}).format(new Date("2026-08-02T00:30:00Z"));
		expect(formatTimestamp("2026-08-02T00:30:00Z")).toBe(expected);
	});

	it("returns a stable fallback for invalid dates", () => {
		expect(formatDateOnly("not-a-date")).toBe("—");
		expect(formatTimestamp("not-a-date")).toBe("—");
	});
});

describe("shared model-detail formatting", () => {
	it("formats token counts and model prices", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(1234567)).toContain("1,234,567");
		expect(formatTokenCount(-1)).toBe("—");
		expect(formatDetailPrice(0, "USD", 0)).toBe("—");
		expect(formatDetailPrice(1.25, "USD", 0)).toContain("$");
		expect(formatDetailPrice(1.25, "EUR", 0)).toContain("~€");
	});
});
