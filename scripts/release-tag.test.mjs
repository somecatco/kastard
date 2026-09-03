import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createReleaseTag,
	listPreviewTags,
	resolveCliRelease,
	resolveEnteredReleaseTag,
	resolvePreviewTag,
	resolveReleaseTag,
} from "./release-tag.mjs";

const roots = [];

function git(root, ...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "kastard-release-tag-"));
	roots.push(root);
	for (const [path, contents] of [
		["apps/desktop/package.json", { build: { buildVersion: "11" }, version: "0.0.0" }],
		["apps/worker/package.json", { buildNumber: "12", version: "0.0.0" }],
	]) {
		const fullPath = join(root, path);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, `${JSON.stringify(contents, null, 2)}\n`);
	}
	git(root, "init", "--quiet");
	git(root, "config", "user.email", "release-test@example.com");
	git(root, "config", "user.name", "Release Test");
	git(root, "add", "apps/desktop/package.json", "apps/worker/package.json");
	git(root, "commit", "--quiet", "-m", "fixture");
	return { root, sourceRevision: git(root, "rev-parse", "HEAD") };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("Release tag command", () => {
	test("derives Preview tags from build numbers", () => {
		const { root, sourceRevision } = createFixture();
		expect(
			resolveReleaseTag(root, "preview", "editor", undefined, sourceRevision),
		).toBe("editor-preview.11");
		expect(
			resolveReleaseTag(root, "preview", "worker", undefined, sourceRevision),
		).toBe("worker-preview.12");
	});

	test("derives Production tags only from the supplied product version", () => {
		const { root, sourceRevision } = createFixture();
		expect(
			resolveReleaseTag(root, "production", "editor", "0.3.0", sourceRevision),
		).toBe("editor-v0.3.0");
		expect(
			resolveReleaseTag(root, "production", "worker", "0.4.0", sourceRevision),
		).toBe("worker-v0.4.0");
	});

	test("accepts directly entered numbered tag variants", () => {
		const { root, sourceRevision } = createFixture();
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
		const { root, sourceRevision } = createFixture();
		for (const tag of ["preview.11-1", "editor-preview.11-1-1", "worker-v0.4.0-1-1"]) {
			expect(() => resolveEnteredReleaseTag(root, tag, sourceRevision)).toThrow();
		}
	});

	test("rejects unsupported selections and channel arguments", () => {
		const { root, sourceRevision } = createFixture();
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

	test("promotes Preview tags using metadata from their source revisions", () => {
		const { root, sourceRevision: previewRevision } = createFixture();
		git(root, "tag", "editor-preview.11", previewRevision);
		git(root, "tag", "worker-preview.12-1", previewRevision);

		writeFileSync(
			join(root, "apps/desktop/package.json"),
			`${JSON.stringify({ build: { buildVersion: "13" }, version: "0.0.0" }, null, 2)}\n`,
		);
		writeFileSync(
			join(root, "apps/worker/package.json"),
			`${JSON.stringify({ buildNumber: "14", version: "0.0.0" }, null, 2)}\n`,
		);
		git(root, "add", "apps/desktop/package.json", "apps/worker/package.json");
		git(root, "commit", "--quiet", "-m", "later changes");
		const currentRevision = git(root, "rev-parse", "HEAD");

		expect(resolvePreviewTag(root, "worker-preview.12-1")).toEqual({
			sourceRevision: previewRevision,
			tag: "worker-preview.12-1",
			target: "worker",
		});
		expect(listPreviewTags(root, "editor")).toEqual([
			{
				sourceRevision: previewRevision,
				tag: "editor-preview.11",
				target: "editor",
			},
		]);
		expect(
			resolveReleaseTag(root, "production", "worker", "0.4.0", previewRevision),
		).toBe("worker-v0.4.0");
		expect(
			resolveEnteredReleaseTag(root, "worker-v0.4.0", previewRevision),
		).toMatchObject({
			release: { previewTag: "worker-preview.12", sourceRevision: previewRevision },
			target: "worker",
		});

		const production = resolveCliRelease(
			root,
			["production", "worker", "0.4.0", "worker-preview.12-1"],
			currentRevision,
		);
		expect(production).toEqual({
			sourceRevision: previewRevision,
			tag: "worker-v0.4.0",
		});
		createReleaseTag(root, production.tag, production.sourceRevision);
		expect(git(root, "rev-parse", "worker-v0.4.0^{commit}")).toBe(previewRevision);
	});

	test("rejects non-Preview tags as promotion sources", () => {
		const { root, sourceRevision } = createFixture();
		git(root, "tag", "worker-v0.4.0", sourceRevision);
		expect(() => resolvePreviewTag(root, "worker-v0.4.0")).toThrow(
			"is not a Preview tag",
		);
		expect(() => resolvePreviewTag(root, "worker-preview.99")).toThrow(
			"does not exist",
		);
		git(root, "tag", "worker-preview.12", sourceRevision);
		expect(() =>
			resolveCliRelease(
				root,
				["production", "editor", "0.4.0", "worker-preview.12"],
				sourceRevision,
			),
		).toThrow("cannot be promoted to editor Production");
	});
});
