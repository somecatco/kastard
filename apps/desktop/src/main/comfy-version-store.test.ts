import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ComfyVersionStore } from "./comfy-version-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function storePath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kastard-comfy-version-test-"));
	temporaryDirectories.push(root);
	return join(root, "comfy-version.json");
}

test("selects the bundled versions until another release is chosen", async () => {
	const store = new ComfyVersionStore(await storePath());
	await store.initialize();

	expect(store.get()).toEqual({ frontend: null, backend: null, manager: null });
});

test("persists each component selection independently", async () => {
	const path = await storePath();
	const store = new ComfyVersionStore(path);
	await store.initialize();

	await store.update("backend", "0.34.0");
	await store.update("frontend", "v1.51.0");
	await store.update("manager", "4.3.0");

	expect(store.get()).toEqual({
		frontend: "v1.51.0",
		backend: "0.34.0",
		manager: "4.3.0",
	});
	const restored = new ComfyVersionStore(path);
	await restored.initialize();
	expect(restored.get()).toEqual({
		frontend: "v1.51.0",
		backend: "0.34.0",
		manager: "4.3.0",
	});
});

test("returns to the bundled version when a component is cleared", async () => {
	const store = new ComfyVersionStore(await storePath());
	await store.initialize();
	await store.update("backend", "0.34.0");

	await store.update("backend", null);

	expect(store.get()).toEqual({ frontend: null, backend: null, manager: null });
});

test("rejects a version that could escape its install directory", async () => {
	const store = new ComfyVersionStore(await storePath());
	await store.initialize();

	await expect(store.update("backend", "../../etc")).rejects.toThrow(
		"Invalid ComfyUI version.",
	);
	expect(store.get()).toEqual({ frontend: null, backend: null, manager: null });
});

test("rejects the previous selection schema without rewriting it", async () => {
	const path = await storePath();
	const contents = JSON.stringify({
		version: 1,
		frontend: "v1.51.0",
		backend: "0.34.0",
	});
	await writeFile(path, contents);
	const store = new ComfyVersionStore(path);

	await expect(store.initialize()).rejects.toThrow(
		"The saved ComfyUI version selection is invalid.",
	);
	expect(await readFile(path, "utf8")).toBe(contents);
});

test.each([
	["malformed JSON", "{ not json"],
	[
		"an invalid current selection",
		JSON.stringify({
			version: 2,
			frontend: "../../frontend",
			backend: null,
			manager: null,
		}),
	],
	[
		"an unsupported schema",
		JSON.stringify({ version: 3, frontend: null, backend: null, manager: null }),
	],
])("reports %s instead of silently resetting it", async (_name, contents) => {
	const path = await storePath();
	await writeFile(path, contents);
	const store = new ComfyVersionStore(path);

	await expect(store.initialize()).rejects.toThrow(
		"The saved ComfyUI version selection is invalid.",
	);
});

test("stores the selection under a schema version", async () => {
	const path = await storePath();
	const store = new ComfyVersionStore(path);
	await store.initialize();

	await store.update("frontend", "v1.51.0");

	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
		version: 2,
		frontend: "v1.51.0",
		backend: null,
		manager: null,
	});
});

test("rejects an invalid Manager version", async () => {
	const store = new ComfyVersionStore(await storePath());
	await store.initialize();

	await expect(store.update("manager", "../../manager")).rejects.toThrow(
		"Invalid ComfyUI Manager version.",
	);
	expect(store.get()).toEqual({ frontend: null, backend: null, manager: null });
});
