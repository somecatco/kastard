import { readFile } from "node:fs/promises";
import type { BackendTarget } from "../../shared/api";

export async function readWorkerBackendTarget(path: string): Promise<BackendTarget> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		typeof value.version !== "string" ||
		!("archiveUrl" in value) ||
		typeof value.archiveUrl !== "string" ||
		!("sha256" in value) ||
		typeof value.sha256 !== "string"
	) {
		throw new Error("Invalid packaged ComfyUI source manifest.");
	}
	return {
		version: value.version,
		archiveUrl: value.archiveUrl,
		sha256: value.sha256,
	};
}
