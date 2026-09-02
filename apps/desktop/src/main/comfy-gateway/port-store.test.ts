// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ComfyGatewayPortStore } from "./port-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<{ path: string; store: ComfyGatewayPortStore }> {
	const directory = await mkdtemp(join(tmpdir(), "kastard-comfy-gateway-port-test-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "comfy-gateway.json");
	return { path, store: new ComfyGatewayPortStore(path) };
}

test("starts without a port when no saved Gateway port exists", async () => {
	const target = await fixture();

	await target.store.initialize();

	expect(target.store.get()).toBeNull();
});

test("persists the assigned Gateway port", async () => {
	const target = await fixture();

	await target.store.update(52_781);
	const restored = new ComfyGatewayPortStore(target.path);
	await restored.initialize();

	expect(restored.get()).toBe(52_781);
	expect(JSON.parse(await readFile(target.path, "utf8"))).toEqual({
		version: 1,
		port: 52_781,
	});
});

test.each([
	"{invalid",
	'{"version":1,"port":0}',
	'{"version":1,"port":65536}',
	'{"version":1,"port":5278.5}',
	'{"port":5278}',
])("rejects an invalid saved Gateway port: %s", async (contents) => {
	const target = await fixture();
	await writeFile(target.path, contents);

	await expect(target.store.initialize()).rejects.toThrow(
		"The saved ComfyUI Gateway port is invalid.",
	);
	expect(target.store.get()).toBeNull();
});

test("rejects an invalid assigned Gateway port", async () => {
	const target = await fixture();

	await expect(target.store.update(80)).rejects.toThrow(
		"Invalid ComfyUI Gateway port.",
	);
	expect(target.store.get()).toBeNull();
});
