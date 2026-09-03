import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveEditorRelease } from "./editor-release.mjs";

const roots = [];
const sourceRevision = "a".repeat(40);

function createFixture({ buildVersion = "11", version = "0.0.0" } = {}) {
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
	test("resolves Preview without a product version", () => {
		const release = resolveEditorRelease(
			createFixture(),
			"editor-preview.11",
			sourceRevision,
		);

		expect(release).toEqual({
			appId: "co.somecat.kastard.preview",
			appName: "Kastard Preview",
			artifactName: "Kastard-Preview-11+aaaaaaa-arm64.dmg",
			buildScript: "build:preview",
			buildVersion: "11",
			bundleVersion: "0.0.0",
			channel: "preview",
			outputDirectory: "dist/preview",
			prerelease: true,
			productVersion: null,
			releaseName: "Kastard Preview 11 (aaaaaaa)",
			sourceRevision,
		});
	});

	test("resolves a numbered Preview tag variant as the same build", () => {
		const release = resolveEditorRelease(
			createFixture(),
			"editor-preview.11-1",
			sourceRevision,
		);

		expect(release).toMatchObject({
			buildVersion: "11",
			channel: "preview",
			productVersion: null,
		});
	});

	test("resolves the Production version from the tag", () => {
		const release = resolveEditorRelease(
			createFixture(),
			"editor-v0.2.0",
			sourceRevision,
		);

		expect(release).toEqual({
			appId: "co.somecat.kastard",
			appName: "Kastard",
			artifactName: "Kastard-0.2.0+11-aaaaaaa-arm64.dmg",
			buildScript: "build:production",
			buildVersion: "11",
			bundleVersion: "0.2.0",
			channel: "production",
			outputDirectory: "dist/production",
			prerelease: false,
			previewTag: "editor-preview.11",
			productVersion: "0.2.0",
			releaseName: "Kastard 0.2.0 (11, aaaaaaa)",
			sourceRevision,
		});
	});

	test("resolves a numbered Production tag variant as the same version", () => {
		const release = resolveEditorRelease(
			createFixture(),
			"editor-v0.2.0-1",
			sourceRevision,
		);

		expect(release).toMatchObject({
			channel: "production",
			productVersion: "0.2.0",
		});
	});

	test("rejects Preview buildVersion mismatches", () => {
		expect(() =>
			resolveEditorRelease(createFixture(), "editor-preview.12", sourceRevision),
		).toThrow("does not match");
	});

	test("rejects unsupported and malformed tags", () => {
		const root = createFixture();
		for (const tag of [
			"v0.1.0",
			"editor-v0.1",
			"editor-v0.1.0-0",
			"editor-v0.1.0-01",
			"editor-v0.1.0-1-1",
			"editor-preview",
			"editor-preview.0",
			"editor-preview.11-0",
			"editor-preview.11-01",
			"editor-preview.11-1-1",
		]) {
			expect(() => resolveEditorRelease(root, tag, sourceRevision)).toThrow(
				"does not match",
			);
		}
	});

	test("rejects invalid release metadata", () => {
		expect(() =>
			resolveEditorRelease(
				createFixture({ buildVersion: "0" }),
				"editor-v0.1.0",
				sourceRevision,
			),
		).toThrow("safe positive integer buildVersion");
		expect(() =>
			resolveEditorRelease(
				createFixture({ buildVersion: "9007199254740992" }),
				"editor-preview.9007199254740992",
				sourceRevision,
			),
		).toThrow("safe positive integer buildVersion");
		expect(() =>
			resolveEditorRelease(
				createFixture({ version: "0.1.0-rc.1" }),
				"editor-preview.11",
				sourceRevision,
			),
		).toThrow("technical semantic version");
		expect(() =>
			resolveEditorRelease(createFixture(), "editor-preview.11", "aaaaaaa"),
		).toThrow("full Git commit SHA");
	});
});
