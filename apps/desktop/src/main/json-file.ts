import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type JsonFileReadResult =
	| { status: "missing" }
	| { status: "invalid"; error: unknown }
	| { status: "value"; value: unknown };

export async function readJsonFile(path: string): Promise<JsonFileReadResult> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return { status: "missing" };
		throw error;
	}

	try {
		return { status: "value", value: JSON.parse(contents) };
	} catch (error) {
		return { status: "invalid", error };
	}
}

export async function writeJsonFile(path: string, value: object): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function isErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}
