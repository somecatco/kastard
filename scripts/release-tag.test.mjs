import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveReleaseTag } from "./release-tag.mjs";

const roots = [];

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "kastard-release-tag-"));
	roots.push(root);
	for (const [path, contents] of [
		["apps/desktop/package.json", { build: { buildVersion: "11" }, version: "0.1.0" }],
		["apps/server/package.json", { buildNumber: "12", version: "0.2.0" }],
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
	test("derives supported tags from package metadata", () => {
		const root = createFixture();
		expect(resolveReleaseTag(root, "beta", "editor")).toBe("editor-v0.1.0-beta.11");
		expect(resolveReleaseTag(root, "production", "editor")).toBe("editor-v0.1.0");
		expect(resolveReleaseTag(root, "beta", "worker")).toBe("worker-v0.2.0-beta.12");
		expect(resolveReleaseTag(root, "production", "worker")).toBe("worker-v0.2.0");
	});

	test("rejects unsupported selections", () => {
		const root = createFixture();
		expect(() => resolveReleaseTag(root, "stage", "editor")).toThrow("Usage");
	});
});
