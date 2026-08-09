import { describe, expect, it } from "vitest";
import {
	formatDateOnly,
	formatShortDateLabel,
	formatTimestamp,
} from "../../ui/formatting/formatting";

describe("shared UI date formatting", () => {
	it("formats short chart labels with the UTC calendar date", () => {
		expect(formatShortDateLabel("2026-08-01")).toBe("Aug 1");
	});

	it("formats date-only values with the UTC calendar date", () => {
		expect(formatDateOnly("2026-08-01T23:30:00-05:00")).toBe("Aug 2, 2026");
	});

	it("formats timestamps with an explicit UTC time zone", () => {
		expect(formatTimestamp("2026-08-02T00:30:00Z")).toBe("Aug 2, 2026, 12:30 AM");
	});

	it("returns a stable fallback for invalid dates", () => {
		expect(formatDateOnly("not-a-date")).toBe("—");
		expect(formatTimestamp("not-a-date")).toBe("—");
	});
});
