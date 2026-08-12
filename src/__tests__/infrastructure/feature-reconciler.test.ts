import { describe, expect, it, vi } from "vitest";
import { FeatureReconciler } from "../../infrastructure/featureReconciler";

describe("FeatureReconciler", () => {
	it("rolls back a resource when initial synchronization fails", () => {
		const dispose = vi.fn();
		const report = vi.fn();
		let syncAttempts = 0;
		const reconciler = new FeatureReconciler(
			[
				{
					id: "hoverProvider",
					isEnabled: () => true,
					activate: () => ({ dispose }),
					sync: () => {
						syncAttempts += 1;
						if (syncAttempts === 1) throw new Error("sync failed");
					},
				},
			],
			report,
		);

		reconciler.reconcile("hoverProvider");

		expect(report).toHaveBeenCalledWith("hoverProvider", expect.any(Error));
		expect(dispose).toHaveBeenCalledOnce();
		expect(reconciler.isActive("hoverProvider")).toBe(false);
		reconciler.dispose();
	});

	it("rolls back activation hooks and retries with a fresh resource", () => {
		const disposals: Array<ReturnType<typeof vi.fn>> = [];
		const report = vi.fn();
		let shouldFail = true;
		const reconciler = new FeatureReconciler(
			[
				{
					id: "hoverProvider",
					isEnabled: () => true,
					activate: () => {
						const dispose = vi.fn();
						disposals.push(dispose);
						return { dispose };
					},
					activated: () => {
						if (shouldFail) throw new Error("activation hook failed");
					},
				},
			],
			report,
		);

		reconciler.reconcile("hoverProvider");
		expect(reconciler.isActive("hoverProvider")).toBe(false);
		expect(disposals[0]).toHaveBeenCalledOnce();

		shouldFail = false;
		reconciler.reconcile("hoverProvider");
		expect(reconciler.isActive("hoverProvider")).toBe(true);
		expect(disposals).toHaveLength(2);
		reconciler.dispose();
		expect(disposals[1]).toHaveBeenCalledOnce();
	});
});
