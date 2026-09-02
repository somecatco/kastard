// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readWorkerBackendTarget } from "./backend-target";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

test("reads a packaged ComfyUI source manifest", async () => {
	const path = await manifestPath({
		version: "0.33.1",
		archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.33.1.zip",
		sha256: "a".repeat(64),
	});

	await expect(readWorkerBackendTarget(path)).resolves.toEqual({
		version: "0.33.1",
		archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.33.1.zip",
		sha256: "a".repeat(64),
	});
});

test("rejects an invalid packaged ComfyUI source manifest", async () => {
	const path = await manifestPath({ version: "0.33.1" });

	await expect(readWorkerBackendTarget(path)).rejects.toThrow(
		"Invalid packaged ComfyUI source manifest.",
	);
});

async function manifestPath(value: unknown): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "kastard-backend-target-test-"));
	directories.push(directory);
	const path = join(directory, "manifest.json");
	await writeFile(path, JSON.stringify(value));
	return path;
}
