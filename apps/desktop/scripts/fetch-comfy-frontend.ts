import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	download,
	extractZip,
	pathExists,
	readJson,
	replaceTarget,
	safeArchivePath,
	verifyChecksum,
} from "./artifact";

type FrontendManifest = {
	version: string;
	archiveUrl: string;
	archiveRoot?: string;
	sha256: string;
	license: string;
	licenseUrl: string;
};

const appRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(appRoot, "../..");
const manifestPath = join(repoRoot, "vendor/comfyui-frontend.json");
const targetDir = join(appRoot, "resources/comfyui-frontend");
const stampName = ".kastard-source.json";

async function readManifest(): Promise<FrontendManifest> {
	const parsed = await readJson(manifestPath);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("version" in parsed) ||
		!("archiveUrl" in parsed) ||
		!("sha256" in parsed) ||
		!("license" in parsed) ||
		!("licenseUrl" in parsed) ||
		("archiveRoot" in parsed && typeof parsed.archiveRoot !== "string")
	) {
		throw new Error("Invalid ComfyUI frontend manifest.");
	}
	return parsed as FrontendManifest;
}

async function isCurrent(manifest: FrontendManifest): Promise<boolean> {
	if (!(await pathExists(join(targetDir, "index.html")))) return false;
	try {
		const raw = await readFile(join(targetDir, stampName), "utf8");
		const stamp = JSON.parse(raw) as { version?: unknown; sha256?: unknown };
		return stamp.version === manifest.version && stamp.sha256 === manifest.sha256;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const manifest = await readManifest();
	if (await isCurrent(manifest)) {
		console.info(`ComfyUI frontend ${manifest.version} is already synchronized.`);
		return;
	}

	const temporaryRoot = await mkdtemp(join(tmpdir(), "kastard-comfy-frontend-"));
	const archiveDir = join(temporaryRoot, "archive");
	try {
		const [archive, license] = await Promise.all([
			download(manifest.archiveUrl, "ComfyUI frontend"),
			download(manifest.licenseUrl, "ComfyUI frontend license"),
		]);
		verifyChecksum(archive, manifest.sha256, "ComfyUI frontend");
		await mkdir(archiveDir, { recursive: true });
		await extractZip(archive, archiveDir);
		const stagingDir = manifest.archiveRoot
			? safeArchivePath(archiveDir, manifest.archiveRoot)
			: archiveDir;
		if (!(await pathExists(join(stagingDir, "index.html")))) {
			throw new Error("ComfyUI frontend archive does not contain index.html.");
		}
		await Bun.write(join(stagingDir, "LICENSE"), license);
		await Bun.write(
			join(stagingDir, stampName),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);
		await mkdir(dirname(targetDir), { recursive: true });
		await replaceTarget(stagingDir, targetDir);
		console.info(`Synchronized ComfyUI frontend ${manifest.version}.`);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

await main();
