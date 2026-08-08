import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { env } from "vscode";
import { findStateDb, getStateDbBaseDirs } from "../../models/stateDbLocator";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, accessSync: vi.fn() };
});

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

afterEach(() => {
	vi.restoreAllMocks();
	vi.stubEnv("APPDATA", originalEnv.APPDATA);
	vi.stubEnv("HOME", originalEnv.HOME);
	vi.stubEnv("XDG_CONFIG_HOME", originalEnv.XDG_CONFIG_HOME);
	Object.defineProperty(process, "platform", { value: originalPlatform });
	(env as { appName: string }).appName = "Code";
});

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

describe("state database locator", () => {
	it("uses APPDATA on Windows", () => {
		setPlatform("win32");
		vi.stubEnv("APPDATA", "C:\\Users\\alex\\AppData\\Roaming");

		expect(getStateDbBaseDirs()).toEqual(["C:\\Users\\alex\\AppData\\Roaming"]);
	});

	it("uses the macOS Application Support directory", () => {
		setPlatform("darwin");
		vi.stubEnv("HOME", "/Users/alex");

		expect(getStateDbBaseDirs()).toEqual([
			path.join("/Users/alex", "Library", "Application Support"),
		]);
	});

	it("prefers XDG_CONFIG_HOME and includes the Linux fallback", () => {
		setPlatform("linux");
		vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg");
		vi.stubEnv("HOME", "/home/alex");

		expect(getStateDbBaseDirs()).toEqual(["/tmp/xdg", path.join("/home/alex", ".config")]);
	});

	it("returns no base directories when the platform environment is unavailable", () => {
		setPlatform("linux");
		vi.stubEnv("XDG_CONFIG_HOME", undefined);
		vi.stubEnv("HOME", undefined);

		expect(getStateDbBaseDirs()).toEqual([]);
	});

	it("prefers the Insiders application folder when the file exists", () => {
		setPlatform("linux");
		vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg");
		vi.stubEnv("HOME", undefined);
		(env as { appName: string }).appName = "Visual Studio Code - Insiders";
		const access = vi.mocked(fs.accessSync).mockImplementation((candidate) => {
			if (String(candidate).includes("Code - Insiders")) return;
			throw new Error("missing");
		});

		expect(findStateDb()).toBe(
			path.join("/tmp/xdg", "Code - Insiders", "User", "globalStorage", "state.vscdb"),
		);
		expect(access).toHaveBeenCalled();
	});
});
