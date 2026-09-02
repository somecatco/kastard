// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { DesktopTheme } from "../shared/api";
import { ThemeStore } from "./theme-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<{ path: string; store: ThemeStore }> {
	const directory = await mkdtemp(join(tmpdir(), "kastard-theme-test-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "theme.json");
	return { path, store: new ThemeStore(path) };
}

test("defaults to the system theme when no preference exists", async () => {
	const target = await fixture();

	await target.store.initialize();

	expect(target.store.get()).toBe("system");
});

test.each<DesktopTheme>(["system", "light", "dark"])(
	"persists the %s theme",
	async (theme) => {
		const target = await fixture();

		await target.store.update(theme);
		const restored = new ThemeStore(target.path);
		await restored.initialize();

		expect(restored.get()).toBe(theme);
		expect(JSON.parse(await readFile(target.path, "utf8"))).toEqual({
			version: 1,
			theme,
		});
	},
);

test.each(["{invalid", '{"version":1,"theme":"sepia"}', '{"theme":"dark"}'])(
	"rejects an invalid saved theme: %s",
	async (contents) => {
		const target = await fixture();
		await writeFile(target.path, contents);

		await expect(target.store.initialize()).rejects.toThrow(
			"The saved desktop theme is invalid.",
		);
		expect(target.store.get()).toBe("system");
	},
);

test("can replace an invalid saved theme", async () => {
	const target = await fixture();
	await writeFile(target.path, "{invalid");
	await expect(target.store.initialize()).rejects.toThrow();

	await target.store.update("light");

	expect(target.store.get()).toBe("light");
	expect(JSON.parse(await readFile(target.path, "utf8"))).toEqual({
		version: 1,
		theme: "light",
	});
});
