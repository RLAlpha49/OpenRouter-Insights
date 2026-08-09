import { describe, expect, it } from "vitest";
import { buildDashboardBody } from "../../ui/webviews/usageDashboard";

const regions = [
	"hero",
	"credits",
	"activity",
	"analytics",
	"capabilities",
	"keys",
	"free-tier",
	"actions",
	"footer",
];

function usage() {
	return {
		mode: "management",
		isManagementKey: true,
		capabilities: {
			keys: "available",
			credits: "available",
			activity: "available",
			perKeyActivity: "available",
			analytics: "available",
			keyManagement: "available",
		},
		totalUsed: 1,
		dailyUsage: 0,
		weeklyUsage: 0,
		monthlyUsage: 1,
		limit: 10,
		limitRemaining: 9,
		limitReset: null,
		isFreeTier: false,
		usagePercent: 10,
		allKeys: [],
		selectedKeyHash: "hash-1",
		accountCredits: null,
		fetchedAt: "2026-08-02T00:30:00Z",
		dailyUsageHistory: null,
		analytics: null,
	} as any;
}

describe("dashboard regions", () => {
	it("emits stable region markers for every dashboard section", () => {
		const html = buildDashboardBody(usage(), false);
		for (const region of regions) {
			expect(html).toContain(`data-region="${region}"`);
		}
	});
});
