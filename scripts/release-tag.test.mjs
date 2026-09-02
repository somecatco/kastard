import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveReleaseTag } from "./release-tag.mjs";

const roots = [];
const sourceRevision = "c".repeat(40);

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "kastard-release-tag-"));
	roots.push(root);
	for (const [path, contents] of [
		["apps/desktop/package.json", { build: { buildVersion: "11" }, version: "0.0.0" }],
		["apps/server/package.json", { buildNumber: "12", version: "0.0.0" }],
	]) {
		const fullPath = join(root, path);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, `${JSON.stringify(contents, null, 2)}\n`);
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("Release tag command", () => {
	test("derives Preview tags from build numbers", () => {
		const root = createFixture();
		expect(
			resolveReleaseTag(root, "preview", "editor", undefined, sourceRevision),
		).toBe("editor-preview.11");
		expect(
			resolveReleaseTag(root, "preview", "worker", undefined, sourceRevision),
		).toBe("worker-preview.12");
	});

	test("derives Production tags only from the supplied product version", () => {
		const root = createFixture();
		expect(
			resolveReleaseTag(root, "production", "editor", "0.3.0", sourceRevision),
		).toBe("editor-v0.3.0");
		expect(
			resolveReleaseTag(root, "production", "worker", "0.4.0", sourceRevision),
		).toBe("worker-v0.4.0");
	});

	test("rejects unsupported selections and channel arguments", () => {
		const root = createFixture();
		expect(() =>
			resolveReleaseTag(root, "stage", "editor", undefined, sourceRevision),
		).toThrow("Usage");
		expect(() =>
			resolveReleaseTag(root, "preview", "editor", "0.2.0", sourceRevision),
		).toThrow("Usage");
		expect(() =>
			resolveReleaseTag(root, "production", "editor", undefined, sourceRevision),
		).toThrow("Usage");
		expect(() =>
			resolveReleaseTag(root, "production", "editor", "0.2", sourceRevision),
		).toThrow("Usage");
	});
});
