import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

export async function download(url: string, label: string): Promise<Uint8Array> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) {
		throw new Error(`${label} download failed with HTTP ${response.status}.`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

export function verifyChecksum(
	bytes: Uint8Array,
	expected: string,
	label: string,
): void {
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== expected) {
		throw new Error(
			`${label} checksum mismatch. Expected ${expected}, received ${actual}.`,
		);
	}
}

export function safeArchivePath(root: string, entry: string): string {
	if (isAbsolute(entry) || entry.split(/[\\/]/u).includes("..")) {
		throw new Error(`Unsafe archive entry: ${entry}`);
	}
	const output = resolve(root, entry);
	if (output !== root && !output.startsWith(`${root}${sep}`)) {
		throw new Error(`Archive entry escapes the target directory: ${entry}`);
	}
	return output;
}

export async function extractZip(
	bytes: Uint8Array,
	target: string,
	stripFirstDirectory = false,
): Promise<void> {
	const entries = unzipSync(bytes);
	for (const [entry, contents] of Object.entries(entries)) {
		if (entry.endsWith("/")) continue;
		const parts = entry.split("/");
		const relative = stripFirstDirectory ? parts.slice(1).join("/") : entry;
		if (!relative) continue;
		const output = safeArchivePath(target, relative);
		await mkdir(dirname(output), { recursive: true });
		await Bun.write(output, contents);
	}
}

export async function replaceTarget(staging: string, target: string): Promise<void> {
	const backup = `${target}.previous`;
	await rm(backup, { recursive: true, force: true });
	const hadTarget = await pathExists(target);
	if (hadTarget) await rename(target, backup);
	try {
		await rename(staging, target);
		await rm(backup, { recursive: true, force: true });
	} catch (error) {
		if (hadTarget && !(await pathExists(target))) await rename(backup, target);
		throw error;
	}
}
