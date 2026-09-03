// @vitest-environment node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ConnectionPreferencesStore } from "./connection-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "kastard-preferences-test-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "worker-connection.json");
	const legacyPath = join(directory, "server-connection.json");
	return {
		store: new ConnectionPreferencesStore(path, legacyPath),
		path,
		legacyPath,
	};
}

test("treats a missing file as missing connection preferences", async () => {
	const target = await fixture();

	expect(await target.store.load()).toBeNull();
});

test("saves only non-secret connection preferences", async () => {
	const target = await fixture();
	const preferences = {
		recentProvider: "other" as const,
		recentWorkerAddress: "worker.example.com:22001",
		syncAfterConnect: false,
		systemMetricsEnabled: false,
	};

	await target.store.save(preferences);
	expect(await target.store.load()).toEqual(preferences);
	expect(JSON.parse(await readFile(target.path, "utf8"))).toEqual({
		version: 4,
		...preferences,
	});
});

test.each([
	{ version: 1, encryptedCredential: "encrypted-preferences" },
	{
		version: 2,
		recentProvider: "other",
		recentServerUrl: "worker.example.com:22001",
		syncAfterConnect: false,
	},
])(
	"returns null for version $version preferences without rewriting them in the store",
	async (stored) => {
		const target = await fixture();
		const contents = JSON.stringify(stored);
		await writeFile(target.path, contents);

		expect(await target.store.load()).toBeNull();
		expect(await readFile(target.path, "utf8")).toBe(contents);
	},
);

test.each([
	["malformed JSON", "{"],
	["an unsupported schema", JSON.stringify({ version: 5 })],
	[
		"an invalid recent Worker address",
		JSON.stringify({
			version: 4,
			recentProvider: "other",
			recentWorkerAddress: "https://worker.example.com",
			syncAfterConnect: false,
			systemMetricsEnabled: true,
		}),
	],
])("treats %s as missing connection preferences", async (_name, contents) => {
	const target = await fixture();
	await writeFile(target.path, contents);

	expect(await target.store.load()).toBeNull();
});

test("migrates valid legacy preferences to the Worker connection store", async () => {
	const target = await fixture();
	await writeFile(
		target.legacyPath,
		JSON.stringify({
			version: 3,
			recentProvider: "other",
			recentServerUrl: "worker.example.com:22001",
			syncAfterConnect: false,
			systemMetricsEnabled: true,
		}),
	);

	expect(await target.store.load()).toEqual({
		recentProvider: "other",
		recentWorkerAddress: "worker.example.com:22001",
		syncAfterConnect: false,
		systemMetricsEnabled: true,
	});
	expect(JSON.parse(await readFile(target.path, "utf8"))).toEqual({
		version: 4,
		recentProvider: "other",
		recentWorkerAddress: "worker.example.com:22001",
		syncAfterConnect: false,
		systemMetricsEnabled: true,
	});
	await expect(readFile(target.legacyPath, "utf8")).rejects.toMatchObject({
		code: "ENOENT",
	});
});

test("keeps the current Worker preferences when a legacy file also exists", async () => {
	const target = await fixture();
	await target.store.save({
		recentProvider: "other",
		recentWorkerAddress: "current.example.com:22001",
		syncAfterConnect: true,
		systemMetricsEnabled: true,
	});
	const legacy = JSON.stringify({
		version: 3,
		recentProvider: "other",
		recentServerUrl: "legacy.example.com:22001",
		syncAfterConnect: false,
		systemMetricsEnabled: false,
	});
	await writeFile(target.legacyPath, legacy);

	expect(await target.store.load()).toMatchObject({
		recentWorkerAddress: "current.example.com:22001",
	});
	expect(await readFile(target.legacyPath, "utf8")).toBe(legacy);
});

test("preserves legacy preferences when the migrated store cannot be written", async () => {
	const target = await fixture();
	const blockedParent = join(target.path, "blocked");
	await mkdir(blockedParent, { recursive: true });
	const currentPath = join(blockedParent, "worker-connection.json");
	const legacy = JSON.stringify({
		version: 3,
		recentProvider: "other",
		recentServerUrl: "worker.example.com:22001",
		syncAfterConnect: false,
		systemMetricsEnabled: true,
	});
	await writeFile(target.legacyPath, legacy);
	await chmod(blockedParent, 0o500);
	const store = new ConnectionPreferencesStore(currentPath, target.legacyPath);

	try {
		await expect(store.load()).rejects.toBeDefined();
		expect(await readFile(target.legacyPath, "utf8")).toBe(legacy);
	} finally {
		await chmod(blockedParent, 0o700);
	}
});
