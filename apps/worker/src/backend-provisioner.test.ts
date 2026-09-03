import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import {
	BackendProvisioner,
	BackendProvisioningError,
	type BackendState,
	type WorkerRuntime,
} from "./backend-provisioner";
import { WorkerLogStore } from "./worker-log";

const runtime: WorkerRuntime = {
	cudaVersion: "12.8",
	pythonVersion: "3.12.13",
	torchVersion: "2.11.0+cu128",
	torchvisionVersion: "0.26.0+cu128",
	torchaudioVersion: "2.11.0+cu128",
	uvVersion: "0.12.4",
};
const archive = zipSync({
	"ComfyUI-0.33.1/main.py": new TextEncoder().encode("print('ready')\n"),
	"ComfyUI-0.33.1/comfy/__init__.py": new Uint8Array(),
});
const archiveSha256 = createHash("sha256").update(archive).digest("hex");
const target = {
	version: "0.33.1",
	archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.33.1.zip",
	sha256: archiveSha256,
};
const nextArchive = zipSync({
	"ComfyUI-0.34.0/main.py": new TextEncoder().encode("print('next')\n"),
	"ComfyUI-0.34.0/comfy/__init__.py": new Uint8Array(),
});
const nextTarget = {
	version: "0.34.0",
	archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.34.0.zip",
	sha256: createHash("sha256").update(nextArchive).digest("hex"),
};
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("BackendProvisioner", () => {
	test("pins each generated dependency lock in its Worker runtime manifest", async () => {
		const vendorDirectory = join(import.meta.dir, "../../../vendor");
		for (const profile of ["cpu", "cu128", "cu130"]) {
			const manifest = JSON.parse(
				await readFile(
					join(vendorDirectory, `comfyui-worker-runtime-${profile}.json`),
					"utf8",
				),
			) as {
				profile: string;
				pythonVersion: string;
				dependencyLock: { path: string; sha256: string };
			};
			const lock = await readFile(join(vendorDirectory, manifest.dependencyLock.path));

			expect(manifest.profile).toBe(profile);
			expect(manifest.pythonVersion).toBe("3.13.12");
			await access(join(vendorDirectory, `comfyui-worker-constraints-${profile}.txt`));
			expect(createHash("sha256").update(lock).digest("hex")).toBe(
				manifest.dependencyLock.sha256,
			);
		}
	});

	test("prepares the selected ComfyUI source in the persistent root", async () => {
		const rootDirectory = await temporaryDirectory();
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (_url, destination, onProgress) => {
				onProgress(42);
				await Bun.write(destination, archive);
				return archiveSha256;
			},
		});

		expect(provisioner.getState()).toEqual({ status: "not-installed", runtime });
		expect(provisioner.prepare(target)).toMatchObject({
			status: "preparing",
			targetVersion: "0.33.1",
			phase: "download",
		});
		await waitForState(provisioner, "ready");

		expect(provisioner.getState()).toEqual({
			status: "ready",
			version: "0.33.1",
			runtime,
		});
		for (const path of [
			"backend/main.py",
			"models",
			"custom_nodes",
			"input",
			"output",
			"temp",
			"user",
		]) {
			await access(join(rootDirectory, path));
		}
		const stamp = JSON.parse(
			await readFile(join(rootDirectory, ".kastard-backend.json"), "utf8"),
		);
		expect(stamp).toEqual({
			schemaVersion: 1,
			version: "0.33.1",
			sha256: target.sha256,
			runtime,
		});
	});

	test("notifies dependents after a newly prepared backend becomes ready", async () => {
		const rootDirectory = await temporaryDirectory();
		let readyCalls = 0;
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (_url, destination) => {
				await Bun.write(destination, archive);
				return archiveSha256;
			},
			onReady: () => {
				readyCalls += 1;
			},
		});

		provisioner.prepare(target);
		await waitForState(provisioner, "ready");
		for (let attempt = 0; readyCalls === 0 && attempt < 100; attempt += 1) {
			await Bun.sleep(1);
		}

		expect(readyCalls).toBe(1);
	});

	test("restores a complete published installation", async () => {
		const rootDirectory = await temporaryDirectory();
		const first = await provisionerFor(rootDirectory);
		first.prepare(target);
		await waitForState(first, "ready");

		const restored = await provisionerFor(rootDirectory);
		expect(restored.getState()).toEqual({
			status: "ready",
			version: "0.33.1",
			runtime,
		});
		expect(restored.prepare(target)).toEqual(restored.getState());
	});

	test("recovers a published backend when the root stamp was not written", async () => {
		const rootDirectory = await temporaryDirectory();
		const first = await provisionerFor(rootDirectory);
		first.prepare(target);
		await waitForState(first, "ready");
		await rm(join(rootDirectory, ".kastard-backend.json"));

		const restored = await provisionerFor(rootDirectory);

		expect(restored.getState()).toEqual({
			status: "ready",
			version: "0.33.1",
			runtime,
		});
	});

	test("restores a published backend after the Worker runtime changes", async () => {
		const rootDirectory = await temporaryDirectory();
		const first = await provisionerFor(rootDirectory);
		first.prepare(target);
		await waitForState(first, "ready");
		const updatedRuntime = { ...runtime, torchVersion: "2.12.0+cu128" };

		const restored = await BackendProvisioner.create({
			rootDirectory,
			runtime: updatedRuntime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (_url, destination) => {
				await Bun.write(destination, archive);
				return archiveSha256;
			},
		});

		expect(restored.getState()).toEqual({
			status: "ready",
			version: "0.33.1",
			runtime: updatedRuntime,
		});
		const stamp = JSON.parse(
			await readFile(join(rootDirectory, ".kastard-backend.json"), "utf8"),
		);
		expect(stamp.runtime).toEqual(runtime);
	});

	test("removes abandoned staging data when the Worker starts", async () => {
		const rootDirectory = await temporaryDirectory();
		const abandoned = join(
			rootDirectory,
			".backend-staging-00000000-0000-4000-8000-000000000000",
		);
		await mkdir(abandoned);
		const abandonedDownload = join(
			rootDirectory,
			".kastard",
			"backend-artifacts",
			".download-00000000-0000-4000-8000-000000000000.partial",
		);
		await mkdir(join(rootDirectory, ".kastard", "backend-artifacts"), {
			recursive: true,
		});
		await Bun.write(abandonedDownload, archive);

		await provisionerFor(rootDirectory);

		await expect(access(abandoned)).rejects.toThrow();
		await expect(access(abandonedDownload)).rejects.toThrow();
	});

	test("replaces an incomplete backend when retrying after Worker startup", async () => {
		const rootDirectory = await temporaryDirectory();
		const staleDirectory = join(rootDirectory, "backend", "stale");
		await mkdir(staleDirectory, { recursive: true });
		const provisioner = await provisionerFor(rootDirectory);

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining("Retry backend preparation"),
			retryable: true,
		});
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");

		await access(join(rootDirectory, "backend", "main.py"));
		await expect(access(staleDirectory)).rejects.toThrow();
	});

	test("retries after a checksum failure without exposing a partial backend", async () => {
		const rootDirectory = await temporaryDirectory();
		const provisioner = await provisionerFor(rootDirectory);

		provisioner.prepare({ ...target, sha256: "0".repeat(64) });
		const state = await waitForState(provisioner, "failed");

		expect(state).toMatchObject({
			status: "failed",
			targetVersion: "0.33.1",
			error: expect.stringContaining("Checksum mismatch"),
			retryable: true,
		});
		await expect(access(join(rootDirectory, "backend"))).rejects.toThrow();

		expect(provisioner.prepare(target)).toMatchObject({
			status: "preparing",
			targetVersion: "0.33.1",
			phase: "download",
		});
		await waitForState(provisioner, "ready");
		await access(join(rootDirectory, "backend", "main.py"));
	});

	test("does not publish an archive without a ComfyUI entry point", async () => {
		const rootDirectory = await temporaryDirectory();
		const incompleteArchive = zipSync({
			"ComfyUI-0.33.2/comfy/__init__.py": new Uint8Array(),
		});
		const checksum = createHash("sha256").update(incompleteArchive).digest("hex");
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (_url, destination) => {
				await Bun.write(destination, incompleteArchive);
				return checksum;
			},
		});

		provisioner.prepare({
			version: "0.33.2",
			archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.33.2.zip",
			sha256: checksum,
		});
		const state = await waitForState(provisioner, "failed");

		expect(state).toMatchObject({
			status: "failed",
			error: expect.stringContaining("main.py is unavailable"),
			retryable: false,
		});
		await expect(access(join(rootDirectory, "backend"))).rejects.toThrow();
	});

	test("reports current phase and total preparation time", async () => {
		const rootDirectory = await temporaryDirectory();
		let now = 1_000;
		let releaseDownload = (): void => undefined;
		const downloadGate = new Promise<void>((resolve) => {
			releaseDownload = resolve;
		});
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			now: () => now,
			downloadArtifact: async (_url, destination, onProgress) => {
				onProgress(25);
				await downloadGate;
				await Bun.write(destination, archive);
				return archiveSha256;
			},
		});

		provisioner.prepare(target);
		now = 2_500;
		expect(provisioner.getState()).toMatchObject({
			status: "preparing",
			phase: "download",
			phaseElapsedMs: 1_500,
			totalElapsedMs: 1_500,
		});

		releaseDownload();
		await waitForState(provisioner, "ready");
	});

	test("accepts only an official version-matching archive URL", async () => {
		const provisioner = await provisionerFor(await temporaryDirectory());

		expect(() =>
			provisioner.prepare({ ...target, archiveUrl: "https://example.com/comfyui.zip" }),
		).toThrow(BackendProvisioningError);
		expect(provisioner.getState()).toEqual({ status: "not-installed", runtime });
	});

	test("replaces an installed backend with another selected version", async () => {
		const rootDirectory = await temporaryDirectory();
		let replaceCalls = 0;
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: downloadSelectedArchive,
			onReplace: () => {
				replaceCalls += 1;
			},
		});
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");

		expect(provisioner.prepare(nextTarget)).toMatchObject({
			status: "preparing",
			targetVersion: nextTarget.version,
		});
		await waitForState(provisioner, "ready");

		expect(provisioner.getState()).toEqual({
			status: "ready",
			version: nextTarget.version,
			runtime,
		});
		expect(replaceCalls).toBe(1);
		expect(await readFile(join(rootDirectory, "backend/main.py"), "utf8")).toBe(
			"print('next')\n",
		);
		expect(
			JSON.parse(await readFile(join(rootDirectory, ".kastard-backend.json"), "utf8")),
		).toEqual({
			schemaVersion: 1,
			version: nextTarget.version,
			sha256: nextTarget.sha256,
			runtime,
		});
	});

	test("keeps the installed backend while a workflow is running", async () => {
		const rootDirectory = await temporaryDirectory();
		let busy = false;
		let replaceCalls = 0;
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: downloadSelectedArchive,
			onReplace: () => {
				replaceCalls += 1;
			},
			isBusy: () => busy,
		});
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");
		busy = true;

		expect(() => provisioner.prepare(nextTarget)).toThrow(BackendProvisioningError);
		expect(provisioner.getState()).toEqual({
			status: "ready",
			version: target.version,
			runtime,
		});
		expect(replaceCalls).toBe(0);
		expect(provisioner.prepare(target)).toEqual({
			status: "ready",
			version: target.version,
			runtime,
		});
	});

	test("reuses the cached archive when switching back to a previous version", async () => {
		const rootDirectory = await temporaryDirectory();
		let downloads = 0;
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (url, destination, onProgress) => {
				downloads += 1;
				return downloadSelectedArchive(url, destination, onProgress);
			},
		});
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");
		provisioner.prepare(nextTarget);
		await waitForState(provisioner, "ready");
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");

		expect(provisioner.getState()).toEqual({
			status: "ready",
			version: target.version,
			runtime,
		});
		expect(downloads).toBe(2);
	});

	test("keeps the installed backend when a workflow starts during the replacement", async () => {
		const rootDirectory = await temporaryDirectory();
		let busy = false;
		let replaceCalls = 0;
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (url, destination, onProgress) => {
				busy = true;
				return downloadSelectedArchive(url, destination, onProgress);
			},
			onReplace: () => {
				replaceCalls += 1;
			},
			isBusy: () => busy,
		});
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");
		busy = false;

		provisioner.prepare(nextTarget);
		const failed = await waitForState(provisioner, "failed");

		expect(failed).toMatchObject({ status: "failed", retryable: true });
		expect(replaceCalls).toBe(0);
		expect(await readFile(join(rootDirectory, "backend/main.py"), "utf8")).toBe(
			"print('ready')\n",
		);
		expect(
			JSON.parse(await readFile(join(rootDirectory, ".kastard-backend.json"), "utf8")),
		).toEqual({
			schemaVersion: 1,
			version: target.version,
			sha256: target.sha256,
			runtime,
		});
	});

	test("restores the installed backend when the replacement cannot be published", async () => {
		const rootDirectory = await temporaryDirectory();
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: downloadSelectedArchive,
			onReplace: async () => {
				// Drop the staged replacement so publishing it fails after the installed
				// backend has already been moved aside.
				for (const entry of await readdir(rootDirectory)) {
					if (!entry.startsWith(".backend-staging-")) continue;
					await rm(join(rootDirectory, entry), { recursive: true, force: true });
				}
			},
		});
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");

		provisioner.prepare(nextTarget);
		await waitForState(provisioner, "failed");

		expect(await readFile(join(rootDirectory, "backend/main.py"), "utf8")).toBe(
			"print('ready')\n",
		);
		await expect(access(join(rootDirectory, "backend.previous"))).rejects.toThrow();
	});

	test("discards a backend swap left behind by a crash", async () => {
		const rootDirectory = await temporaryDirectory();
		const first = await provisionerFor(rootDirectory);
		first.prepare(target);
		await waitForState(first, "ready");
		await mkdir(join(rootDirectory, "backend.previous"), { recursive: true });

		const restored = await provisionerFor(rootDirectory);

		expect(restored.getState()).toEqual({
			status: "ready",
			version: target.version,
			runtime,
		});
		await expect(access(join(rootDirectory, "backend.previous"))).rejects.toThrow();
	});

	test("restores the backend left behind by a crash between the swap renames", async () => {
		const rootDirectory = await temporaryDirectory();
		const first = await provisionerFor(rootDirectory);
		first.prepare(target);
		await waitForState(first, "ready");
		// The window inside publishBackend where the installed copy only exists aside.
		await rename(
			join(rootDirectory, "backend"),
			join(rootDirectory, "backend.previous"),
		);

		const restored = await provisionerFor(rootDirectory);

		expect(restored.getState()).toEqual({
			status: "ready",
			version: target.version,
			runtime,
		});
		expect(await readFile(join(rootDirectory, "backend/main.py"), "utf8")).toBe(
			"print('ready')\n",
		);
		await expect(access(join(rootDirectory, "backend.previous"))).rejects.toThrow();
	});

	test("reinstalls when the same version arrives with different bytes", async () => {
		const rootDirectory = await temporaryDirectory();
		let busy = false;
		let replaceCalls = 0;
		let serveRebuilt = false;
		const rebuilt = zipSync({
			"ComfyUI-0.33.1/main.py": new TextEncoder().encode("print('rebuilt')\n"),
		});
		const rebuiltTarget = {
			...target,
			sha256: createHash("sha256").update(rebuilt).digest("hex"),
		};
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (url, destination, onProgress) => {
				if (serveRebuilt && url === rebuiltTarget.archiveUrl) {
					onProgress(100);
					await Bun.write(destination, rebuilt);
					return rebuiltTarget.sha256;
				}
				return downloadSelectedArchive(url, destination, onProgress);
			},
			onReplace: () => {
				replaceCalls += 1;
			},
			isBusy: () => busy,
		});
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");

		// Same tag, different archive: the Worker must not report the old bytes as ready.
		serveRebuilt = true;
		busy = true;
		expect(() => provisioner.prepare(rebuiltTarget)).toThrow(BackendProvisioningError);
		busy = false;
		provisioner.prepare(rebuiltTarget);
		await waitForState(provisioner, "ready");

		expect(replaceCalls).toBe(1);
		expect(await readFile(join(rootDirectory, "backend/main.py"), "utf8")).toBe(
			"print('rebuilt')\n",
		);
	});

	test("stops ComfyUI before republishing the version already installed", async () => {
		const rootDirectory = await temporaryDirectory();
		let busy = false;
		let replaceCalls = 0;
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (url, destination, onProgress) => {
				if (url === nextTarget.archiveUrl) {
					throw new Error("Download failed with HTTP 500.");
				}
				return downloadSelectedArchive(url, destination, onProgress);
			},
			onReplace: () => {
				replaceCalls += 1;
			},
			isBusy: () => busy,
		});
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");
		// A no-op prepare must stay a no-op even while a workflow is running.
		busy = true;
		expect(provisioner.prepare(target)).toMatchObject({ status: "ready" });
		expect(replaceCalls).toBe(0);

		busy = false;
		provisioner.prepare(nextTarget);
		await waitForState(provisioner, "failed");

		// The failure left the state on "failed" while the backend is still installed, so
		// asking for that same installed version republishes over it.
		busy = true;
		expect(() => provisioner.prepare(target)).toThrow(BackendProvisioningError);
		expect(replaceCalls).toBe(0);
		busy = false;
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");

		expect(replaceCalls).toBe(1);
		expect(await readFile(join(rootDirectory, "backend/main.py"), "utf8")).toBe(
			"print('ready')\n",
		);
	});

	test("still treats a retried replacement as a replacement", async () => {
		const rootDirectory = await temporaryDirectory();
		let busy = false;
		let failNext = true;
		let replaceCalls = 0;
		const provisioner = await BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (url, destination, onProgress) => {
				if (failNext && url === nextTarget.archiveUrl) {
					failNext = false;
					throw new Error("Download failed with HTTP 500.");
				}
				return downloadSelectedArchive(url, destination, onProgress);
			},
			onReplace: () => {
				replaceCalls += 1;
			},
			isBusy: () => busy,
		});
		provisioner.prepare(target);
		await waitForState(provisioner, "ready");
		provisioner.prepare(nextTarget);
		await waitForState(provisioner, "failed");
		expect(replaceCalls).toBe(0);

		// The installed backend survived the failure, so a retry is still a replacement.
		busy = true;
		expect(() => provisioner.prepare(nextTarget)).toThrow(BackendProvisioningError);
		busy = false;
		provisioner.prepare(nextTarget);
		await waitForState(provisioner, "ready");

		expect(replaceCalls).toBe(1);
		expect(await readFile(join(rootDirectory, "backend/main.py"), "utf8")).toBe(
			"print('next')\n",
		);
	});

	async function downloadSelectedArchive(
		url: string,
		destination: string,
		onProgress: (progress: number) => void,
	): Promise<string> {
		const selected = url === nextTarget.archiveUrl ? nextTarget : target;
		onProgress(100);
		await Bun.write(destination, url === nextTarget.archiveUrl ? nextArchive : archive);
		return selected.sha256;
	}

	async function temporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "kastard-backend-test-"));
		directories.push(directory);
		return directory;
	}

	async function provisionerFor(rootDirectory: string): Promise<BackendProvisioner> {
		return BackendProvisioner.create({
			rootDirectory,
			runtime,
			logs: new WorkerLogStore(),
			downloadArtifact: async (_url, destination) => {
				await Bun.write(destination, archive);
				return archiveSha256;
			},
		});
	}

	async function waitForState(
		provisioner: BackendProvisioner,
		status: "ready" | "failed",
	): Promise<BackendState> {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const state = provisioner.getState();
			if (state.status === status) return state;
			await Bun.sleep(1);
		}
		throw new Error(`Backend state did not reach ${status}.`);
	}
});
