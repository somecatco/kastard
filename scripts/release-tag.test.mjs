import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveEnteredReleaseTag, resolveReleaseTag } from "./release-tag.mjs";

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

	test("accepts directly entered numbered tag variants", () => {
		const root = createFixture();
		expect(
			resolveEnteredReleaseTag(root, "editor-preview.11-1", sourceRevision),
		).toMatchObject({
			release: { buildVersion: "11", channel: "preview" },
			target: "editor",
		});
		expect(
			resolveEnteredReleaseTag(root, "worker-v0.4.0-1", sourceRevision),
		).toMatchObject({
			release: { channel: "production", productVersion: "0.4.0" },
			target: "worker",
		});
	});

	test("rejects unsupported directly entered tags", () => {
		const root = createFixture();
		for (const tag of ["preview.11-1", "editor-preview.11-1-1", "worker-v0.4.0-1-1"]) {
			expect(() => resolveEnteredReleaseTag(root, tag, sourceRevision)).toThrow();
		}
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
