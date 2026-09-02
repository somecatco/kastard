// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	const path = join(directory, "connection.json");
	return {
		store: new ConnectionPreferencesStore(path),
		path,
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
		recentServerUrl: "worker.example.com:22001",
		syncAfterConnect: false,
		systemMetricsEnabled: false,
	};

	await target.store.save(preferences);
	expect(await target.store.load()).toEqual(preferences);
	expect(JSON.parse(await readFile(target.path, "utf8"))).toEqual({
		version: 3,
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
	["an unsupported schema", JSON.stringify({ version: 4 })],
	[
		"an invalid recent Worker address",
		JSON.stringify({
			version: 3,
			recentProvider: "other",
			recentServerUrl: "https://worker.example.com",
			syncAfterConnect: false,
			systemMetricsEnabled: true,
		}),
	],
])("treats %s as missing connection preferences", async (_name, contents) => {
	const target = await fixture();
	await writeFile(target.path, contents);

	expect(await target.store.load()).toBeNull();
});
