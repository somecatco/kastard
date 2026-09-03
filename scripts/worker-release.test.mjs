import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveWorkerRelease } from "./worker-release.mjs";

const roots = [];

function git(root, ...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createFixture({ buildNumber = "11", version = "0.0.0" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "kastard-worker-release-"));
	roots.push(root);
	const path = join(root, "apps/worker/package.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ buildNumber, version }, null, 2)}\n`);
	git(root, "init", "--quiet");
	git(root, "config", "user.email", "release-test@example.com");
	git(root, "config", "user.name", "Release Test");
	git(root, "add", "apps/worker/package.json");
	git(root, "commit", "--quiet", "-m", "fixture");
	return { root, sourceRevision: git(root, "rev-parse", "HEAD") };
}

function resolveFixture(tag, options) {
	const { root, sourceRevision } = createFixture(options);
	return resolveWorkerRelease(root, tag, sourceRevision);
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("Worker release tags", () => {
	test("resolves Preview without a product version", () => {
		const release = resolveFixture("worker-preview.11");
		expect(release).toEqual({
			buildNumber: "11",
			channel: "preview",
			productVersion: null,
			sourceRevision: release.sourceRevision,
		});
	});

	test("resolves a numbered Preview tag variant as the same build", () => {
		expect(resolveFixture("worker-preview.11-1")).toMatchObject({
			buildNumber: "11",
			channel: "preview",
			productVersion: null,
		});
	});

	test("resolves the Production version from the tag", () => {
		const release = resolveFixture("worker-v0.2.0");
		expect(release).toEqual({
			buildNumber: "11",
			channel: "production",
			previewTag: "worker-preview.11",
			productVersion: "0.2.0",
			sourceRevision: release.sourceRevision,
		});
	});

	test("resolves a numbered Production tag variant as the same version", () => {
		expect(resolveFixture("worker-v0.2.0-1")).toMatchObject({
			channel: "production",
			productVersion: "0.2.0",
		});
	});

	test("rejects build number and format mismatches", () => {
		const { root, sourceRevision } = createFixture();
		for (const tag of [
			"worker-preview.12",
			"worker-preview.11-0",
			"worker-preview.11-01",
			"worker-preview.11-1-1",
			"worker-v0.1",
			"worker-v0.1.0-0",
			"worker-v0.1.0-01",
			"worker-v0.1.0-1-1",
			"worker-production.11",
			"editor-preview.11",
		]) {
			expect(() => resolveWorkerRelease(root, tag, sourceRevision)).toThrow(
				"does not match",
			);
		}
	});

	test("rejects invalid package and source metadata", () => {
		expect(() => resolveFixture("worker-preview.11", { version: "0.1.0" })).toThrow(
			"must keep version 0.0.0",
		);
		expect(() =>
			resolveFixture("worker-preview.9007199254740992", {
				buildNumber: "9007199254740992",
			}),
		).toThrow("safe positive integer buildNumber");
		const { root } = createFixture();
		expect(() => resolveWorkerRelease(root, "worker-preview.11", "bbbbbbb")).toThrow(
			"full Git commit SHA",
		);
	});
});
