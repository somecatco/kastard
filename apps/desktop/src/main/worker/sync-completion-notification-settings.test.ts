// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SyncCompletionNotificationSettingsStore } from "./sync-completion-notification-settings";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<{
	path: string;
	store: SyncCompletionNotificationSettingsStore;
}> {
	const directory = await mkdtemp(join(tmpdir(), "kastard-sync-notification-test-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "settings.json");
	return { path, store: new SyncCompletionNotificationSettingsStore(path) };
}

test("defaults sync completion notifications to enabled", async () => {
	const target = await fixture();

	await target.store.initialize();

	expect(target.store.get()).toEqual({ enabled: true });
});

test("persists sync completion notification settings", async () => {
	const target = await fixture();

	await target.store.update({ enabled: false });
	const restored = new SyncCompletionNotificationSettingsStore(target.path);
	await restored.initialize();

	expect(restored.get()).toEqual({ enabled: false });
	expect(JSON.parse(await readFile(target.path, "utf8"))).toEqual({
		version: 1,
		enabled: false,
	});
});

test.each(["{invalid", '{"version":1}', '{"version":2,"enabled":true}'])(
	"rejects invalid saved settings: %s",
	async (contents) => {
		const target = await fixture();
		await writeFile(target.path, contents);

		await expect(target.store.initialize()).rejects.toThrow(
			"The saved sync completion notification settings are invalid.",
		);
		expect(target.store.get()).toEqual({ enabled: true });
	},
);

test("can replace invalid saved settings", async () => {
	const target = await fixture();
	await writeFile(target.path, "{invalid");
	await expect(target.store.initialize()).rejects.toThrow();

	await target.store.update({ enabled: false });

	expect(target.store.get()).toEqual({ enabled: false });
});
