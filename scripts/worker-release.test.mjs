import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveWorkerRelease } from "./worker-release.mjs";

const roots = [];

function createFixture({ buildNumber = "11", version = "0.1.0" } = {}) {
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
	test("resolves the Beta tag", () => {
		expect(resolveWorkerRelease(createFixture(), "worker-v0.1.0-beta.11")).toEqual({
			buildNumber: "11",
			channel: "beta",
			version: "0.1.0",
		});
	});

	test("resolves the Production tag", () => {
		expect(resolveWorkerRelease(createFixture(), "worker-v0.1.0")).toEqual({
			buildNumber: "11",
			channel: "production",
			version: "0.1.0",
		});
	});

	test("rejects version, build number, and format mismatches", () => {
		const root = createFixture();
		for (const tag of [
			"worker-v0.2.0-beta.11",
			"worker-v0.1.0-beta.12",
			"worker-v0.1.0-production",
			"editor-v0.1.0-beta.11",
		]) {
			expect(() => resolveWorkerRelease(root, tag)).toThrow("does not match");
		}
	});

	test("rejects invalid package release metadata", () => {
		expect(() =>
			resolveWorkerRelease(
				createFixture({ version: "0.1.0-beta.11" }),
				"worker-v0.1.0-beta.11",
			),
		).toThrow("stable semantic version");
		expect(() =>
			resolveWorkerRelease(
				createFixture({ buildNumber: "9007199254740992" }),
				"worker-v0.1.0-beta.9007199254740992",
			),
		).toThrow("safe positive integer buildNumber");
	});
});
