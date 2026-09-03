import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, expect, test, vi } from "vitest";
import { ComfySourceInstaller } from "./comfy-source-installer";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();
const backendArchive = zipSync({
	"ComfyUI-0.34.0/main.py": encoder.encode("print('ready')\n"),
	"ComfyUI-0.34.0/requirements.txt": encoder.encode("torch\n"),
	"ComfyUI-0.34.0/manager_requirements.txt": encoder.encode("comfyui_manager==4.3.0\n"),
});
const frontendArchive = zipSync({
	"index.html": encoder.encode("<!doctype html>\n"),
	"assets/app.js": encoder.encode("export {};\n"),
});
const backendRelease = {
	version: "0.34.0",
	archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.34.0.zip",
};
const frontendRelease = {
	version: "v1.53.0",
	archiveUrl:
		"https://github.com/Comfy-Org/ComfyUI_frontend/releases/download/v1.53.0/dist.zip",
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function rootDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kastard-comfy-install-test-"));
	temporaryDirectories.push(root);
	return join(root, "comfy-sources");
}

function serve(archive: Uint8Array): { fetch: typeof fetch; calls: () => number } {
	let calls = 0;
	const requestFetch = vi.fn(async () => {
		calls += 1;
		return new Response(archive, {
			status: 200,
			headers: { "content-length": String(archive.byteLength) },
		});
	});
	return { fetch: requestFetch as unknown as typeof fetch, calls: () => calls };
}

test("installs a backend release with the hash of the downloaded archive", async () => {
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: serve(backendArchive).fetch,
	});

	const directory = await installer.install("backend", backendRelease);

	expect(await readFile(join(directory, "main.py"), "utf8")).toBe("print('ready')\n");
	expect(await installer.readStamp("backend", "0.34.0")).toEqual({
		version: "0.34.0",
		archiveUrl: backendRelease.archiveUrl,
		sha256: createHash("sha256").update(backendArchive).digest("hex"),
	});
});

test("installs a frontend release without stripping its top-level files", async () => {
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: serve(frontendArchive).fetch,
	});

	const directory = await installer.install("frontend", frontendRelease);

	expect(await readFile(join(directory, "index.html"), "utf8")).toBe(
		"<!doctype html>\n",
	);
	expect(await readFile(join(directory, "assets/app.js"), "utf8")).toBe("export {};\n");
});

test("reuses an installed release instead of downloading it again", async () => {
	const served = serve(backendArchive);
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: served.fetch,
	});

	await installer.install("backend", backendRelease);
	await installer.install("backend", backendRelease);

	expect(served.calls()).toBe(1);
});

test("reports download progress", async () => {
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: serve(backendArchive).fetch,
	});
	const progress: number[] = [];

	await installer.install("backend", backendRelease, (value) => progress.push(value));

	expect(progress.at(-1)).toBe(100);
	expect(progress.every((value) => value >= 0 && value <= 100)).toBe(true);
});

test("rejects an archive that does not contain the component entry point", async () => {
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: serve(zipSync({ "ComfyUI-0.34.0/readme.md": encoder.encode("") })).fetch,
	});

	await expect(installer.install("backend", backendRelease)).rejects.toThrow(
		"does not contain main.py",
	);
	expect(await installer.readStamp("backend", "0.34.0")).toBeNull();
});

test("rejects an archive entry that escapes the install directory", async () => {
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: serve(zipSync({ "dist/../../escaped.js": encoder.encode("") })).fetch,
	});

	await expect(installer.install("frontend", frontendRelease)).rejects.toThrow(
		"Unsafe archive entry",
	);
});

test("surfaces a failed download", async () => {
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
	});

	await expect(installer.install("frontend", frontendRelease)).rejects.toThrow(
		"Download failed with HTTP 404.",
	);
});

test("reports whether a release is already on disk", async () => {
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: serve(backendArchive).fetch,
	});

	expect(await installer.isInstalled("backend", "0.34.0")).toBe(false);
	await installer.install("backend", backendRelease);

	expect(await installer.isInstalled("backend", "0.34.0")).toBe(true);
	expect(await installer.isInstalled("frontend", "0.34.0")).toBe(false);
});

test("removes an installed release from disk", async () => {
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: serve(backendArchive).fetch,
	});
	const directory = await installer.install("backend", backendRelease);

	await installer.remove("backend", "0.34.0");

	expect(await installer.isInstalled("backend", "0.34.0")).toBe(false);
	await expect(readFile(join(directory, "main.py"), "utf8")).rejects.toThrow();
	await expect(installer.remove("backend", "0.34.0")).resolves.toBeUndefined();
});

test("rejects a backend release Kastard could not start", async () => {
	const installer = new ComfySourceInstaller({
		rootDirectory: await rootDirectory(),
		fetch: serve(
			zipSync({
				"ComfyUI-0.34.0/main.py": encoder.encode(""),
				"ComfyUI-0.34.0/requirements.txt": encoder.encode("torch\n"),
			}),
		).fetch,
	});

	await expect(installer.install("backend", backendRelease)).rejects.toThrow(
		"does not contain manager_requirements.txt",
	);
	expect(await installer.isInstalled("backend", "0.34.0")).toBe(false);
});

test("clears staging directories an interrupted install left behind", async () => {
	const root = await rootDirectory();
	const abandoned = `${root}-staging-abandoned`;
	const unrelated = join(dirname(root), "comfy-release-catalog");
	await mkdir(join(abandoned, "0.34.0"), { recursive: true });
	await mkdir(unrelated, { recursive: true });
	const installer = new ComfySourceInstaller({
		rootDirectory: root,
		fetch: serve(backendArchive).fetch,
	});
	await installer.install("backend", backendRelease);

	await installer.initialize();

	await expect(access(abandoned)).rejects.toThrow();
	await expect(access(unrelated)).resolves.toBeUndefined();
	expect(await installer.isInstalled("backend", "0.34.0")).toBe(true);
});
