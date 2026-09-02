import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveWorkerRelease } from "./worker-release.mjs";

const roots = [];
const sourceRevision = "b".repeat(40);

function createFixture({ buildNumber = "11", version = "0.0.0" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "kastard-worker-release-"));
	roots.push(root);
	const path = join(root, "apps/server/package.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ buildNumber, version }, null, 2)}\n`);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("Worker release tags", () => {
	test("resolves Preview without a product version", () => {
		expect(
			resolveWorkerRelease(createFixture(), "worker-preview.11", sourceRevision),
		).toEqual({
			buildNumber: "11",
			channel: "preview",
			productVersion: null,
			sourceRevision,
		});
	});

	test("resolves the Production version from the tag", () => {
		expect(
			resolveWorkerRelease(createFixture(), "worker-v0.2.0", sourceRevision),
		).toEqual({
			buildNumber: "11",
			channel: "production",
			previewTag: "worker-preview.11",
			productVersion: "0.2.0",
			sourceRevision,
		});
	});

	test("rejects build number and format mismatches", () => {
		const root = createFixture();
		for (const tag of [
			"worker-preview.12",
			"worker-v0.1",
			"worker-production.11",
			"editor-preview.11",
		]) {
			expect(() => resolveWorkerRelease(root, tag, sourceRevision)).toThrow(
				"does not match",
			);
		}
	});

	test("rejects invalid package and source metadata", () => {
		expect(() =>
			resolveWorkerRelease(
				createFixture({ version: "0.1.0-rc.1" }),
				"worker-preview.11",
				sourceRevision,
			),
		).toThrow("technical semantic version");
		expect(() =>
			resolveWorkerRelease(
				createFixture({ buildNumber: "9007199254740992" }),
				"worker-preview.9007199254740992",
				sourceRevision,
			),
		).toThrow("safe positive integer buildNumber");
		expect(() =>
			resolveWorkerRelease(createFixture(), "worker-preview.11", "bbbbbbb"),
		).toThrow("full Git commit SHA");
	});
});
