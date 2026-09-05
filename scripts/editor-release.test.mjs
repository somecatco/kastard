import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveEditorRelease } from "./editor-release.mjs";

const roots = [];

function git(root, ...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createFixture({ buildVersion = "11", version = "0.0.0" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "kastard-editor-release-"));
	roots.push(root);
	const path = join(root, "apps/desktop/package.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ build: { buildVersion }, version }, null, 2)}\n`,
	);
	git(root, "init", "--quiet");
	git(root, "config", "user.email", "release-test@example.com");
	git(root, "config", "user.name", "Release Test");
	git(root, "add", "apps/desktop/package.json");
	git(root, "commit", "--quiet", "-m", "fixture");
	return { root, sourceRevision: git(root, "rev-parse", "HEAD") };
}

function resolveFixture(tag, options) {
	const { root, sourceRevision } = createFixture(options);
	return resolveEditorRelease(root, tag, sourceRevision);
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("Editor release tags", () => {
	test("resolves Preview without a product version", () => {
		const release = resolveFixture("editor-preview.11");
		const shortRevision = release.sourceRevision.slice(0, 7);

		expect(release).toEqual({
			appId: "co.somecat.kastard.preview",
			appName: "Kastard Preview",
			artifactName: `Kastard-Preview-11+${shortRevision}-arm64.dmg`,
			buildScript: "build:preview",
			buildVersion: "11",
			bundleVersion: "0.0.0",
			channel: "preview",
			outputDirectory: "dist/preview",
			prerelease: true,
			productVersion: null,
			releaseName: `editor preview 11 (${shortRevision})`,
			sourceRevision: release.sourceRevision,
		});
	});

	test("resolves a numbered Preview tag variant as the same build", () => {
		const release = resolveFixture("editor-preview.11-1");

		expect(release).toMatchObject({
			buildVersion: "11",
			channel: "preview",
			productVersion: null,
		});
	});

	test("resolves the Production version from the tag", () => {
		const release = resolveFixture("editor-v0.2.0");
		const shortRevision = release.sourceRevision.slice(0, 7);

		expect(release).toEqual({
			appId: "co.somecat.kastard",
			appName: "Kastard",
			artifactName: `Kastard-0.2.0+11-${shortRevision}-arm64.dmg`,
			buildScript: "build:production",
			buildVersion: "11",
			bundleVersion: "0.2.0",
			channel: "production",
			outputDirectory: "dist/production",
			prerelease: false,
			previewTag: "editor-preview.11",
			productVersion: "0.2.0",
			releaseName: `Kastard 0.2.0 (11, ${shortRevision})`,
			sourceRevision: release.sourceRevision,
		});
	});

	test("resolves a numbered Production tag variant as the same version", () => {
		const release = resolveFixture("editor-v0.2.0-1");

		expect(release).toMatchObject({
			channel: "production",
			productVersion: "0.2.0",
		});
	});

	test("rejects Preview buildVersion mismatches", () => {
		expect(() => resolveFixture("editor-preview.12")).toThrow("does not match");
	});

	test("rejects unsupported and malformed tags", () => {
		const { root, sourceRevision } = createFixture();
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
		expect(() => resolveFixture("editor-v0.1.0", { buildVersion: "0" })).toThrow(
			"safe positive integer buildVersion",
		);
		expect(() =>
			resolveFixture("editor-preview.9007199254740992", {
				buildVersion: "9007199254740992",
			}),
		).toThrow("safe positive integer buildVersion");
		expect(() => resolveFixture("editor-preview.11", { version: "0.1.0" })).toThrow(
			"must keep version 0.0.0",
		);
		const { root } = createFixture();
		expect(() => resolveEditorRelease(root, "editor-preview.11", "aaaaaaa")).toThrow(
			"full Git commit SHA",
		);
	});
});
