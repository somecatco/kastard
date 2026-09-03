import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { notarizeWithRetry } from "./notarize.mjs";

const environment = {
	APPLE_API_ISSUER: "issuer",
	APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
	APPLE_API_KEY_ID: "key-id",
};
const desktopRoot = resolve(import.meta.dirname, "..");

describe("notarizeWithRetry", () => {
	test("retries unreadable notarytool results", async () => {
		const transientError = new Error(
			"Failed to notarize via notarytool.  Failed with unexpected result:",
		);
		const notarizeArtifact = vi
			.fn()
			.mockRejectedValueOnce(transientError)
			.mockRejectedValueOnce(transientError)
			.mockResolvedValue(undefined);
		const wait = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();

		await notarizeWithRetry("dist/Kastard-arm64.dmg", {
			environment,
			notarizeArtifact,
			wait,
			warn,
		});

		expect(notarizeArtifact).toHaveBeenCalledTimes(3);
		expect(notarizeArtifact).toHaveBeenCalledWith({
			appPath: resolve("dist/Kastard-arm64.dmg"),
			appleApiIssuer: "issuer",
			appleApiKey: "/tmp/AuthKey_TEST.p8",
			appleApiKeyId: "key-id",
		});
		expect(wait.mock.calls).toEqual([[15_000], [30_000]]);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	test("does not retry a notarization rejection", async () => {
		const rejection = new Error("Failed to notarize via notarytool: Invalid");
		const notarizeArtifact = vi.fn().mockRejectedValue(rejection);
		const wait = vi.fn();

		await expect(
			notarizeWithRetry("dist/Kastard-arm64.dmg", {
				environment,
				notarizeArtifact,
				wait,
			}),
		).rejects.toBe(rejection);
		expect(notarizeArtifact).toHaveBeenCalledTimes(1);
		expect(wait).not.toHaveBeenCalled();
	});

	test("requires App Store Connect credentials before submission", async () => {
		const notarizeArtifact = vi.fn();

		await expect(
			notarizeWithRetry("dist/Kastard-arm64.dmg", {
				environment: {},
				notarizeArtifact,
			}),
		).rejects.toThrow(
			"Missing environment variable required for notarization: APPLE_API_KEY.",
		);
		expect(notarizeArtifact).not.toHaveBeenCalled();
	});
});

test("uses the retrying notarization entry point for the app and DMG", () => {
	const builderConfiguration = readFileSync(
		resolve(desktopRoot, "electron-builder.yml"),
		"utf8",
	);
	const releaseWorkflow = readFileSync(
		resolve(desktopRoot, "../../.github/workflows/editor-release.yml"),
		"utf8",
	);
	const packageJson = JSON.parse(
		readFileSync(resolve(desktopRoot, "package.json"), "utf8"),
	) as { scripts: Record<string, string> };

	expect(builderConfiguration).toMatch(/^afterSign: \.\/scripts\/notarize\.mjs$/m);
	expect(builderConfiguration).toMatch(/^\s+notarize: false$/m);
	expect(releaseWorkflow).toContain('node apps/desktop/scripts/notarize.mjs "$dmg"');
	expect(packageJson.scripts["build:preview"]).toContain("--publish never");
	expect(packageJson.scripts["build:production"]).toContain("--publish never");
});
