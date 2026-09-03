// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CustomNodeSyncStore } from "./custom-node-sync-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<{ store: CustomNodeSyncStore; path: string }> {
	const directory = await mkdtemp(join(tmpdir(), "kastard-custom-node-sync-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "custom-node-sync.json");
	return { store: new CustomNodeSyncStore(path), path };
}

test("defaults installed custom nodes to sync and persists explicit choices", async () => {
	const target = await fixture();
	await target.store.initialize();
	expect(await target.store.get("comfyui-kjnodes")).toBe(true);

	await Promise.all([
		target.store.update("comfyui-kjnodes", false),
		target.store.update("ComfyUI-DaSiWa-Nodes", true),
	]);

	expect(await target.store.get("comfyui-kjnodes")).toBe(false);
	const restored = new CustomNodeSyncStore(target.path);
	await restored.initialize();
	expect(await restored.get("comfyui-kjnodes")).toBe(false);
	expect(await restored.get("ComfyUI-DaSiWa-Nodes")).toBe(true);
	expect(JSON.parse(await readFile(target.path, "utf8"))).toEqual({
		version: 1,
		nodes: [
			{ name: "ComfyUI-DaSiWa-Nodes", sync: true },
			{ name: "comfyui-kjnodes", sync: false },
		],
	});
});

test("waits for queued writes before reading a sync choice", async () => {
	const target = await fixture();
	await target.store.initialize();
	const update = target.store.update("comfyui-kjnodes", false);

	expect(await target.store.get("comfyui-kjnodes")).toBe(false);
	await update;
});

test("removes an explicit sync choice after a custom node is deleted", async () => {
	const target = await fixture();
	await target.store.initialize();
	await target.store.update("comfyui-kjnodes", false);

	expect(await target.store.remove("comfyui-kjnodes")).toBe(false);

	expect(await target.store.remove("comfyui-kjnodes")).toBeUndefined();
	expect(await target.store.get("comfyui-kjnodes")).toBe(true);
	expect(JSON.parse(await readFile(target.path, "utf8"))).toEqual({
		version: 1,
		nodes: [],
	});
});

test("serializes sync updates and deletion", async () => {
	const target = await fixture();
	await target.store.initialize();

	const [, removed] = await Promise.all([
		target.store.update("comfyui-kjnodes", false),
		target.store.remove("comfyui-kjnodes"),
	]);

	expect(removed).toBe(false);
	expect(await target.store.remove("comfyui-kjnodes")).toBeUndefined();
});

test("rejects malformed saved custom-node sync settings", async () => {
	const target = await fixture();
	await writeFile(target.path, '{"version":1,"nodes":[{"name":"x"}]}');
	await expect(target.store.initialize()).rejects.toThrow(
		"The saved custom-node sync settings are invalid.",
	);
});

test("rejects invalid custom-node package names", async () => {
	const target = await fixture();
	await target.store.initialize();
	await expect(target.store.update(" padded ", false)).rejects.toThrow(
		"Invalid custom-node package name.",
	);
	await expect(target.store.remove("../outside")).rejects.toThrow(
		"Invalid custom-node package name.",
	);
});
