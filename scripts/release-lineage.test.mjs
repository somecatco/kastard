import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyProductionLineage } from "./release-lineage.mjs";

const roots = [];

function git(root, ...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createRepository() {
	const root = mkdtempSync(join(tmpdir(), "kastard-release-lineage-"));
	roots.push(root);
	git(root, "init", "--quiet");
	git(root, "config", "user.email", "release-test@example.com");
	git(root, "config", "user.name", "Release Test");
	writeFileSync(join(root, "release.txt"), "preview\n");
	git(root, "add", "release.txt");
	git(root, "commit", "--quiet", "-m", "preview");
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("Production release lineage", () => {
	test("requires the matching Preview Git tag on the Production commit", () => {
		const root = createRepository();
		const previewRevision = git(root, "rev-parse", "HEAD");
		const release = {
			channel: "production",
			previewTag: "editor-preview.15",
			sourceRevision: previewRevision,
		};

		expect(() => verifyProductionLineage(root, release)).toThrow(
			"requires editor-preview.15 or a numbered suffix on the same source revision",
		);
		git(root, "tag", release.previewTag);
		expect(() => verifyProductionLineage(root, release)).not.toThrow();

		writeFileSync(join(root, "release.txt"), "production\n");
		git(root, "add", "release.txt");
		git(root, "commit", "--quiet", "-m", "production");
		expect(() =>
			verifyProductionLineage(root, {
				...release,
				sourceRevision: git(root, "rev-parse", "HEAD"),
			}),
		).toThrow("must point to the Production source revision");
	});

	test("accepts one numbered Preview suffix on the Production commit", () => {
		const root = createRepository();
		const release = {
			channel: "production",
			previewTag: "editor-preview.15",
			sourceRevision: git(root, "rev-parse", "HEAD"),
		};

		git(root, "tag", `${release.previewTag}-1`);
		expect(() => verifyProductionLineage(root, release)).not.toThrow();
	});

	test("ignores malformed Preview suffixes", () => {
		const root = createRepository();
		const release = {
			channel: "production",
			previewTag: "editor-preview.15",
			sourceRevision: git(root, "rev-parse", "HEAD"),
		};

		for (const suffix of ["0", "01", "1-1", "candidate"]) {
			git(root, "tag", `${release.previewTag}-${suffix}`);
		}
		expect(() => verifyProductionLineage(root, release)).toThrow(
			"requires editor-preview.15 or a numbered suffix on the same source revision",
		);
	});
});
