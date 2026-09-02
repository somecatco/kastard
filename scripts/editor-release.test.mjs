import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveEditorRelease } from "./editor-release.mjs";

const roots = [];

function createFixture({ buildVersion = "11", version = "0.1.0" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "kastard-editor-release-"));
	roots.push(root);
	const path = join(root, "apps/desktop/package.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ build: { buildVersion }, version }, null, 2)}\n`,
	);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("Editor release tags", () => {
	test("resolves the Beta channel from version and buildVersion", () => {
		const release = resolveEditorRelease(createFixture(), "editor-v0.1.0-beta.11");

		expect(release).toEqual({
			appId: "co.somecat.kastard.beta",
			appName: "Kastard Beta",
			artifactName: "Kastard-Beta-0.1.0+11-arm64.dmg",
			buildScript: "build:beta",
			buildVersion: "11",
			outputDirectory: "dist/beta",
			prerelease: true,
			releaseName: "Kastard Beta 0.1.0 (11)",
			version: "0.1.0",
		});
	});

	test("resolves the Production channel from version", () => {
		const release = resolveEditorRelease(createFixture(), "editor-v0.1.0");

		expect(release).toEqual({
			appId: "co.somecat.kastard",
			appName: "Kastard",
			artifactName: "Kastard-0.1.0+11-arm64.dmg",
			buildScript: "build:production",
			buildVersion: "11",
			outputDirectory: "dist/production",
			prerelease: false,
			releaseName: "Kastard 0.1.0 (11)",
			version: "0.1.0",
		});
	});

	test("rejects version and Beta buildVersion mismatches", () => {
		const root = createFixture();

		expect(() => resolveEditorRelease(root, "editor-v0.2.0")).toThrow("does not match");
		expect(() => resolveEditorRelease(root, "editor-v0.1.0-beta.12")).toThrow(
			"does not match",
		);
	});

	test("rejects unsupported prerelease and malformed tags", () => {
		const root = createFixture();

		for (const tag of ["v0.1.0", "editor-v0.1.0-alpha.11", "editor-v0.1.0-beta"]) {
			expect(() => resolveEditorRelease(root, tag)).toThrow("does not match");
		}
	});

	test("rejects an invalid package buildVersion", () => {
		expect(() =>
			resolveEditorRelease(createFixture({ buildVersion: "0" }), "editor-v0.1.0"),
		).toThrow("positive integer buildVersion");
	});

	test("rejects a prerelease package version", () => {
		expect(() =>
			resolveEditorRelease(
				createFixture({ version: "0.1.0-beta.11" }),
				"editor-v0.1.0-beta.11",
			),
		).toThrow("stable semantic version");
	});
});
