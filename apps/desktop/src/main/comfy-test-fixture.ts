// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, vi } from "vitest";
import type { ModelLibraryEntry } from "../shared/api";

import { EditorModelPaths } from "./editor-model-paths";
export const temporaryDirectories: string[] = [];
export const runtimeManifest = {
	version: "0.33.1",
	sha256: "backend-sha",
	pythonVersion: "3.12.13",
	managerVersion: "4.2.2",
	dependencyLock: { sha256: "runtime-lock-sha" },
	platform: "darwin-arm64",
	uv: { version: "0.12.4" },
};

export const virtualModel: ModelLibraryEntry = {
	id: "flux",
	name: "FLUX.1 Dev",
	sourceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
	path: "diffusion_models/flux1-dev.safetensors",
	sync: true,
	artifact: {
		provider: "huggingface",
		modelId: "black-forest-labs/FLUX.1-dev",
		versionId: "3de623fc3c33e44ffbe2bad470d0f45bccf2eb21",
		versionLabel: "3de623f",
		fileId: "flux1-dev.safetensors",
		fileName: "flux1-dev.safetensors",
		sizeBytes: 23_802_932_552,
	},
};

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

export class FakeProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.signalCode = signal;
		this.emit("exit", null, signal);
		return true;
	}

	exit(code: number): void {
		this.exitCode = code;
		this.emit("exit", code, null);
	}

	fail(error: Error): void {
		this.emit("error", error);
	}
}

export async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "kastard-comfy-runtime-test-"));
	temporaryDirectories.push(root);
	const resourcesDirectory = join(root, "resources");
	const frontendDirectory = join(root, "frontend");
	const dataDirectory = join(root, "data");
	await mkdir(join(resourcesDirectory, "backend"), { recursive: true });
	await mkdir(join(resourcesDirectory, "bin"), { recursive: true });
	await mkdir(frontendDirectory, { recursive: true });
	await Promise.all([
		writeFile(join(resourcesDirectory, "backend", "main.py"), ""),
		writeFile(join(resourcesDirectory, "backend", "runtime-lock.txt"), "locked\n"),
		writeFile(
			join(resourcesDirectory, "backend", "manager_requirements.txt"),
			"comfyui_manager==4.2.2\n",
		),
		writeFile(
			join(resourcesDirectory, "backend", "requirements.txt"),
			"comfyui-frontend-package==1.48.7\ntorch\n",
		),
		writeFile(join(resourcesDirectory, "bin", "uv"), ""),
		writeFile(join(frontendDirectory, "index.html"), ""),
		writeRuntimeManifest(resourcesDirectory),
	]);
	return {
		resourcesDirectory,
		frontendDirectory,
		dataDirectory,
		modelPaths: new EditorModelPaths(dataDirectory),
	};
}

export function writeRuntimeManifest(
	resourcesDirectory: string,
	overrides: Partial<typeof runtimeManifest> = {},
): Promise<void> {
	return writeFile(
		join(resourcesDirectory, ".kastard-source.json"),
		JSON.stringify({ ...runtimeManifest, ...overrides }),
	);
}

export async function createManagedPython(args: string[]): Promise<void> {
	if (args[0] !== "venv") return;
	const environment = args.at(-1);
	if (!environment) throw new Error("Missing environment path.");
	await mkdir(join(environment, "bin"), { recursive: true });
	await writeFile(join(environment, "bin", "python"), "");
}
