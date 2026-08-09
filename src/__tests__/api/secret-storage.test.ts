/**
 * Tests for the credential-generation / change-notification boundary used to
 * invalidate authenticated derived data (analytics cache) after a key rotation
 * or removal. Only the non-secret generation counter is exposed in memory.
 */

import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { SecretStorageService } from "../../api/secretStorageService";

function createFakeContext(): vscode.ExtensionContext {
	const store = new Map<string, string>();
	return {
		secrets: {
			get: vi.fn(async (key: string) => store.get(key) ?? null),
			store: vi.fn(async (key: string, value: string) => {
				store.set(key, value);
			}),
			delete: vi.fn(async (key: string) => {
				store.delete(key);
			}),
		},
		subscriptions: [],
	} as unknown as vscode.ExtensionContext;
}

describe("SecretStorageService credential generation", () => {
	it("starts at generation zero and never exposes the key material", async () => {
		const service = new SecretStorageService(createFakeContext());
		expect(service.credentialGeneration).toBe(0);

		await service.set("sk-or-v1-" + "a".repeat(32));
		expect(service.credentialGeneration).toBe(1);
		// The generation value is a counter, not a derived key.
		expect(service.credentialGeneration).toBeLessThan(1_000_000);
		service.dispose();
	});

	it("advances the generation on set and delete and notifies listeners", async () => {
		const service = new SecretStorageService(createFakeContext());
		const listener = vi.fn();
		service.onCredentialChange(listener);

		await service.set("sk-or-v1-" + "b".repeat(32));
		await service.delete();

		expect(listener).toHaveBeenCalledTimes(3); // immediate + set + delete
		const generations = listener.mock.calls.map((c) => c[0].generation);
		expect(generations).toEqual([0, 1, 2]);
		const reasons = listener.mock.calls.map((c) => c[0].reason);
		expect(reasons).toContain("set");
		expect(reasons).toContain("delete");
		service.dispose();
	});

	it("unsubscribes listeners on dispose", async () => {
		const service = new SecretStorageService(createFakeContext());
		const listener = vi.fn();
		const subscription = service.onCredentialChange(listener);
		subscription.dispose();

		await service.set("sk-or-v1-" + "c".repeat(32));
		// Immediate callback fired before unsubscribe, but no further events.
		expect(listener).toHaveBeenCalledTimes(1);
		service.dispose();
	});

	it("delivers the current generation to late subscribers", async () => {
		const service = new SecretStorageService(createFakeContext());
		await service.set("sk-or-v1-" + "d".repeat(32));

		const late = vi.fn();
		service.onCredentialChange(late);
		expect(late).toHaveBeenCalledWith({ generation: 1, reason: "set" });
		service.dispose();
	});
});
