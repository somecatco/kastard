import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, unzipSync } from "fflate";
import {
	download,
	extractZip,
	pathExists,
	readJson,
	replaceTarget,
	verifyChecksum,
} from "./artifact";

type UvArtifact = {
	archiveUrl: string;
	sha256: string;
	format: "tar.gz" | "zip";
	executablePath: string;
};

type BackendManifest = {
	version: string;
	archiveUrl: string;
	sha256: string;
	license: string;
	pythonVersion: string;
	managerVersion: string;
	dependencyLock: {
		path: string;
		sha256: string;
	};
	uv: {
		version: string;
		license: string;
		licenseUrls: Record<string, string>;
		artifacts: Record<string, UvArtifact>;
	};
};

const appRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(appRoot, "../..");
const manifestPath = join(repoRoot, "vendor/comfyui-backend.json");
const targetDir = join(appRoot, "resources/comfyui-runtime");
const stampName = ".kastard-source.json";
const platformKey = `${process.platform}-${process.arch}`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function readManifest(): Promise<BackendManifest> {
	const parsed = await readJson(manifestPath);
	if (
		!isRecord(parsed) ||
		typeof parsed.version !== "string" ||
		typeof parsed.archiveUrl !== "string" ||
		typeof parsed.sha256 !== "string" ||
		typeof parsed.license !== "string" ||
		typeof parsed.pythonVersion !== "string" ||
		typeof parsed.managerVersion !== "string" ||
		!isRecord(parsed.dependencyLock) ||
		typeof parsed.dependencyLock.path !== "string" ||
		typeof parsed.dependencyLock.sha256 !== "string" ||
		!isRecord(parsed.uv) ||
		typeof parsed.uv.version !== "string" ||
		typeof parsed.uv.license !== "string" ||
		!isRecord(parsed.uv.licenseUrls) ||
		!isRecord(parsed.uv.artifacts)
	) {
		throw new Error("Invalid ComfyUI backend manifest.");
	}
	return parsed as BackendManifest;
}

async function isCurrent(manifest: BackendManifest): Promise<boolean> {
	if (!(await pathExists(join(targetDir, "backend", "main.py")))) return false;
	if (
		!(await pathExists(
			join(targetDir, "bin", process.platform === "win32" ? "uv.exe" : "uv"),
		))
	)
		return false;
	for (const name of Object.keys(manifest.uv.licenseUrls)) {
		if (!(await pathExists(join(targetDir, "licenses", `uv-LICENSE-${name}`)))) {
			return false;
		}
	}
	try {
		verifyChecksum(
			await readFile(join(targetDir, "backend", "runtime-lock.txt")),
			manifest.dependencyLock.sha256,
			"ComfyUI runtime dependency lock",
		);
	} catch {
		return false;
	}
	try {
		const stamp = JSON.parse(await readFile(join(targetDir, stampName), "utf8")) as {
			version?: unknown;
			sha256?: unknown;
			pythonVersion?: unknown;
			managerVersion?: unknown;
			dependencyLock?: { sha256?: unknown };
			platform?: unknown;
			uv?: { version?: unknown };
		};
		return (
			stamp.version === manifest.version &&
			stamp.sha256 === manifest.sha256 &&
			stamp.pythonVersion === manifest.pythonVersion &&
			stamp.managerVersion === manifest.managerVersion &&
			stamp.dependencyLock?.sha256 === manifest.dependencyLock.sha256 &&
			stamp.platform === platformKey &&
			stamp.uv?.version === manifest.uv.version
		);
	} catch {
		return false;
	}
}

function tarEntry(bytes: Uint8Array, wanted: string): Uint8Array | null {
	const archive = gunzipSync(bytes);
	for (let offset = 0; offset + 512 <= archive.length; ) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const decode = (start: number, length: number) =>
			new TextDecoder()
				.decode(header.subarray(start, start + length))
				.replace(/\0.*$/u, "");
		const name = decode(0, 100);
		const prefix = decode(345, 155);
		const path = prefix ? `${prefix}/${name}` : name;
		const size = Number.parseInt(decode(124, 12).trim() || "0", 8);
		if (!Number.isFinite(size) || size < 0) throw new Error("Invalid uv tar archive.");
		const contentsStart = offset + 512;
		if (path === wanted) return archive.slice(contentsStart, contentsStart + size);
		offset = contentsStart + Math.ceil(size / 512) * 512;
	}
	return null;
}

function uvExecutable(bytes: Uint8Array, artifact: UvArtifact): Uint8Array {
	if (artifact.format === "tar.gz") {
		const executable = tarEntry(bytes, artifact.executablePath);
		if (executable === null)
			throw new Error("uv archive does not contain its executable.");
		return executable;
	}
	const executable = unzipSync(bytes)[artifact.executablePath];
	if (executable === undefined)
		throw new Error("uv archive does not contain its executable.");
	return executable;
}

async function main(): Promise<void> {
	const manifest = await readManifest();
	const dependencyLock = await readFile(
		join(repoRoot, "vendor", manifest.dependencyLock.path),
	);
	verifyChecksum(
		dependencyLock,
		manifest.dependencyLock.sha256,
		"ComfyUI runtime dependency lock",
	);
	const artifact = manifest.uv.artifacts[platformKey];
	if (artifact === undefined)
		throw new Error(`Unsupported ComfyUI runtime platform: ${platformKey}.`);
	if (await isCurrent(manifest)) {
		console.info(
			`ComfyUI backend ${manifest.version} is already synchronized for ${platformKey}.`,
		);
		return;
	}

	const temporaryRoot = await mkdtemp(join(tmpdir(), "kastard-comfy-backend-"));
	const stagingDir = join(temporaryRoot, "runtime");
	try {
		const licenseEntries = Object.entries(manifest.uv.licenseUrls);
		const [backendArchive, uvArchive, ...licenses] = await Promise.all([
			download(manifest.archiveUrl, "ComfyUI backend"),
			download(artifact.archiveUrl, "uv"),
			...licenseEntries.map(([name, url]) => download(url, `uv ${name} license`)),
		]);
		verifyChecksum(backendArchive, manifest.sha256, "ComfyUI backend");
		verifyChecksum(uvArchive, artifact.sha256, "uv");
		await extractZip(backendArchive, join(stagingDir, "backend"), true);
		const mainPath = join(stagingDir, "backend", "main.py");
		if (!(await pathExists(mainPath)))
			throw new Error("ComfyUI backend archive does not contain main.py.");

		const expectedManager = `comfyui_manager==${manifest.managerVersion}`;
		const managerRequirements = await readFile(
			join(stagingDir, "backend", "manager_requirements.txt"),
			"utf8",
		);
		if (managerRequirements.trim() !== expectedManager) {
			throw new Error(
				`ComfyUI Manager requirement mismatch. Expected ${expectedManager}.`,
			);
		}
		await Bun.write(join(stagingDir, "backend", "runtime-lock.txt"), dependencyLock);

		const executableName = process.platform === "win32" ? "uv.exe" : "uv";
		const executablePath = join(stagingDir, "bin", executableName);
		await mkdir(dirname(executablePath), { recursive: true });
		await Bun.write(executablePath, uvExecutable(uvArchive, artifact));
		if (process.platform !== "win32") await chmod(executablePath, 0o755);
		await mkdir(join(stagingDir, "licenses"), { recursive: true });
		for (const [index, [name]] of licenseEntries.entries()) {
			const contents = licenses[index];
			if (contents === undefined) throw new Error(`uv ${name} license is missing.`);
			await Bun.write(join(stagingDir, "licenses", `uv-LICENSE-${name}`), contents);
		}
		await Bun.write(
			join(stagingDir, stampName),
			`${JSON.stringify({ ...manifest, platform: platformKey, uv: { ...manifest.uv, artifacts: undefined } }, null, "\t")}\n`,
		);
		await mkdir(dirname(targetDir), { recursive: true });
		await replaceTarget(stagingDir, targetDir);
		console.info(
			`Synchronized ComfyUI backend ${manifest.version} for ${platformKey}.`,
		);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

await main();
