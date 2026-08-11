/**
 * Unit tests for StatusBarUpdateUseCase — concurrent coalescing,
 * change detection, config-driven behavior, and pricing resolution.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StatusBarUpdateUseCase } from "../../use-cases/statusBarUpdateUseCase";
import type { IPricingCache } from "../../api/cache/pricingStore";
import type { ModelPricingInfo } from "../../types";
import type {
	StatusBarPresenter,
	StatusBarPricingState,
	ModelSelectionCache,
} from "../../use-cases/ports";
import { EventBus } from "../../infrastructure/eventBus";
import { createFakeReadonlyConfig } from "../__mocks__/config-test-helpers";

function makeModel(overrides?: Partial<ModelPricingInfo>): ModelPricingInfo {
	return {
		id: "openai/gpt-4o",
		name: "OpenAI: GPT-4o",
		blendedRate: 3.5,
		contextLength: 128000,
		contextLengthFormatted: "128,000",
		maxOutputLength: 4096,
		created: 1700000000,
		isDeprecated: false,
		deprecationDate: "",
		isFree: false,
		modality: "text",
		description: "Test model",
		supportedParameters: [],
		supportedFeatures: [],
		topProviderIsModerated: false,
		topProviderContextLength: 0,
		topProviderMaxCompletionTokens: 0,
		quantization: "",
		detailsLink: "",
		discountToUser: 0,
		topProviderId: "",
		topProviderName: "",
		perMillion: {
			prompt: 2.5,
			completion: 10,
			image: 0,
			request: 0,
			inputCacheRead: 1.25,
			inputCacheWrite: 0,
			webSearch: 0,
			internalReasoning: 0,
		},
		...overrides,
	};
}

function createFakeCache(models?: ModelPricingInfo[]): IPricingCache {
	const lookup = new Map<string, ModelPricingInfo>();
	if (models) {
		for (const m of models) lookup.set(m.id, m);
	}
	return {
		get: () => (models ? { fetchedAt: new Date().toISOString(), models } : undefined),
		set: vi.fn(),
		isStale: () => false,
		age: () => "1m ago",
		clear: vi.fn(),
		cacheInfo: () => ({
			age: "1m ago",
			modelCount: models?.length ?? 0,
			sizeEstimate: "1 KB",
			ttlHours: 24,
			stale: false,
		}),
		getLookup: () => lookup,
		getValues: () => models ?? [],
		getLowercasedIndex: () => {
			const idx = new Map<string, ModelPricingInfo>();
			if (models) for (const m of models) idx.set(m.name.toLowerCase(), m);
			return idx;
		},
	};
}

describe("StatusBarUpdateUseCase", () => {
	let statusBar: StatusBarPresenter;
	let modelPicker: ModelSelectionCache;
	let eventBus: EventBus;
	let shown: { displayName: string | undefined; data: StatusBarPricingState["data"] }[];

	beforeEach(() => {
		shown = [];
		statusBar = {
			setEnabled: vi.fn(),
			setCommand: vi.fn(),
			showPricing: ({ displayName, data }: StatusBarPricingState) => {
				shown.push({ displayName, data });
			},
		} as unknown as StatusBarPresenter;
		modelPicker = {
			invalidateConfiguredIdsCache: vi.fn(),
		} as unknown as ModelSelectionCache;
		eventBus = new EventBus();
	});

	it("hides status bar when showInStatusBar is false", async () => {
		const cache = createFakeCache();
		const config = createFakeReadonlyConfig({ showInStatusBar: false });
		const useCase = new StatusBarUpdateUseCase(cache, statusBar, modelPicker, config, eventBus);

		await expect(useCase.execute()).resolves.toBeUndefined();
		expect(shown).toHaveLength(0);
	});

	it("coalesces concurrent calls", async () => {
		const cache = createFakeCache();
		const config = createFakeReadonlyConfig();
		const useCase = new StatusBarUpdateUseCase(cache, statusBar, modelPicker, config, eventBus);

		const p1 = useCase.execute();
		const p2 = useCase.execute();
		await expect(Promise.all([p1, p2])).resolves.toBeDefined();
		expect(shown).toHaveLength(1);
	});

	it("skips re-render when model and pricing status unchanged", async () => {
		const model = makeModel();
		const cache = createFakeCache([model]);
		const config = createFakeReadonlyConfig();
		const useCase = new StatusBarUpdateUseCase(cache, statusBar, modelPicker, config, eventBus);

		// First call should render
		await expect(useCase.execute()).resolves.toBeUndefined();
		expect(shown).toHaveLength(1);
		// Second call with same state should skip (change detection)
		await expect(useCase.execute()).resolves.toBeUndefined();
		expect(shown).toHaveLength(1);
	});

	it("can invalidate change-detection cache", async () => {
		const model = makeModel();
		const cache = createFakeCache([model]);
		const config = createFakeReadonlyConfig();
		const useCase = new StatusBarUpdateUseCase(cache, statusBar, modelPicker, config, eventBus);

		await useCase.execute();
		expect(shown).toHaveLength(1);
		useCase.invalidateCache();
		// After invalidation, next execute should re-render
		await expect(useCase.execute()).resolves.toBeUndefined();
		expect(shown).toHaveLength(2);
	});
});
