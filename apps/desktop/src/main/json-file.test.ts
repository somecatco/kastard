// @vitest-environment node

import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readJsonFile, writeJsonFile } from "./json-file";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "kastard-json-file-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

test("distinguishes missing, invalid, and parsed JSON files", async () => {
	const directory = await temporaryDirectory();
	const path = join(directory, "settings.json");

	expect(await readJsonFile(path)).toEqual({ status: "missing" });

	await writeFile(path, "{invalid");
	const invalid = await readJsonFile(path);
	expect(invalid.status).toBe("invalid");
	if (invalid.status === "invalid") expect(invalid.error).toBeInstanceOf(SyntaxError);

	await writeFile(path, "null\n");
	expect(await readJsonFile(path)).toEqual({ status: "value", value: null });
});

test("atomically replaces JSON with private permissions", async () => {
	const directory = await temporaryDirectory();
	const parent = join(directory, "nested");
	const path = join(parent, "settings.json");

	await writeJsonFile(path, { version: 1 });
	await chmod(path, 0o644);
	await writeJsonFile(path, { version: 2 });

	expect(await readFile(path, "utf8")).toBe('{"version":2}\n');
	expect(await readdir(parent)).toEqual(["settings.json"]);
	if (process.platform !== "win32") {
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	}
});

test.each(["writeFile", "rename"] as const)(
	"preserves the target and removes the temporary file when %s fails",
	async (operation) => {
		const directory = await temporaryDirectory();
		const path = join(directory, "settings.json");
		await writeFile(path, "original\n");
		const failure = new Error(`${operation} failed`);

		vi.resetModules();
		vi.doMock("node:fs/promises", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs/promises")>();
			return {
				...actual,
				[operation]: async (...args: unknown[]) => {
					if (operation === "writeFile") {
						await Reflect.apply(actual.writeFile, actual, args);
					}
					throw failure;
				},
			};
		});

		try {
			const { writeJsonFile: writeWithFailure } = await import("./json-file");
			await expect(writeWithFailure(path, { version: 2 })).rejects.toBe(failure);
			expect(await readFile(path, "utf8")).toBe("original\n");
			expect(await readdir(directory)).toEqual(["settings.json"]);
		} finally {
			vi.doUnmock("node:fs/promises");
			vi.resetModules();
		}
	},
);
