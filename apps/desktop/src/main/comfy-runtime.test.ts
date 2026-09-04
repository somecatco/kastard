// @vitest-environment node

import { type ChildProcess, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import type { ComfyRuntimeState, ModelLibraryEntry } from "../shared/api";
import { ComfyRuntime } from "./comfy-runtime";

const temporaryDirectories: string[] = [];
const runtimeManifest = {
	version: "0.33.1",
	sha256: "backend-sha",
	pythonVersion: "3.12.13",
	managerVersion: "4.2.2",
	dependencyLock: { sha256: "runtime-lock-sha" },
	platform: "darwin-arm64",
	uv: { version: "0.12.4" },
};

const virtualModel: ModelLibraryEntry = {
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

class FakeProcess extends EventEmitter {
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

async function fixture() {
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
	return { resourcesDirectory, frontendDirectory, dataDirectory };
}

function writeRuntimeManifest(
	resourcesDirectory: string,
	overrides: Partial<typeof runtimeManifest> = {},
): Promise<void> {
	return writeFile(
		join(resourcesDirectory, ".kastard-source.json"),
		JSON.stringify({ ...runtimeManifest, ...overrides }),
	);
}

async function createManagedPython(args: string[]): Promise<void> {
	if (args[0] !== "venv") return;
	const environment = args.at(-1);
	if (!environment) throw new Error("Missing environment path.");
	await mkdir(join(environment, "bin"), { recursive: true });
	await writeFile(join(environment, "bin", "python"), "");
}

async function createGitHubNode(
	directory: string,
	repository = "git@github.com:Owner/local-git-node.git",
): Promise<string> {
	await mkdir(directory, { recursive: true });
	git(directory, "init", "--quiet");
	await writeFile(join(directory, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
	git(directory, "add", "__init__.py");
	commitGit(directory, "initial");
	git(directory, "remote", "add", "origin", repository);
	git(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
	return git(directory, "rev-parse", "HEAD").trim().toLowerCase();
}

async function createCnrNode(
	directory: string,
	name: string,
	version: string,
	repository?: string,
): Promise<void> {
	await mkdir(directory, { recursive: true });
	await Promise.all([
		writeFile(join(directory, ".tracking"), "__init__.py\n"),
		writeFile(
			join(directory, "pyproject.toml"),
			`[project]\nname = "${name}"\nversion = "${version}"\n${
				repository === undefined
					? ""
					: `\n[project.urls]\nRepository = "${repository}"\n`
			}`,
		),
	]);
}

async function addSubmodule(directory: string, source: string): Promise<string> {
	await createGitHubNode(directory);
	await mkdir(source, { recursive: true });
	git(source, "init", "--quiet");
	await writeFile(join(source, "dependency.py"), "clean dependency\n");
	git(source, "add", "dependency.py");
	commitGit(source, "initial dependency");
	git(
		directory,
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		source,
		"dependency",
	);
	git(directory, "add", ".gitmodules", "dependency");
	commitGit(directory, "add dependency");
	git(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
	return git(directory, "rev-parse", "HEAD").trim().toLowerCase();
}

function commitGit(directory: string, message: string): void {
	git(
		directory,
		"-c",
		"user.name=Kastard Test",
		"-c",
		"user.email=kastard@example.com",
		"commit",
		"--quiet",
		"-m",
		message,
	);
}

function git(directory: string, ...args: string[]): string {
	return execFileSync("git", ["--no-optional-locks", "-C", directory, ...args], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}

test("prepares a managed CPU environment and starts ComfyUI with Manager", async () => {
	const paths = await fixture();
	const commands: string[][] = [];
	const backendArgs: string[][] = [];
	const backendEnvironments: NodeJS.ProcessEnv[] = [];
	const child = new FakeProcess();
	const states: ComfyRuntimeState[] = [];
	const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: request,
		runCommand: async (_command, args, options) => {
			commands.push(args);
			await createManagedPython(args);
			if (args[0] !== "venv") {
				options.onOutput(
					"Resolved 4 packages in 10ms\nDownloading torch (100MiB)\nDownloaded torch\nPrepared 4 packages in 1s\nInstalled 4 packages in 10ms\n",
				);
			}
		},
		startProcess: (_command, args, options) => {
			backendArgs.push(args);
			backendEnvironments.push(options.env);
			return child as unknown as ChildProcess;
		},
		retryMs: 1,
		getModels: () => [virtualModel],
	});
	runtime.subscribe((state) => states.push(state));

	await expect(runtime.start()).resolves.toBe("http://127.0.0.1:18188/");
	await expect(runtime.start()).resolves.toBe("http://127.0.0.1:18188/");
	await expect(runtime.getManagerVersion()).resolves.toBe("4.2.2");

	expect(commands).toHaveLength(2);
	expect(commands[0]).toEqual(
		expect.arrayContaining(["venv", "--python", "3.12.13", "--managed-python"]),
	);
	expect(commands[1]).toEqual(expect.arrayContaining(["pip", "install"]));
	expect(commands[1]).not.toContain("--torch-backend");
	expect(commands[1]).toEqual(
		expect.arrayContaining([
			"--require-hashes",
			"--requirements",
			join(paths.resourcesDirectory, "backend", "runtime-lock.txt"),
		]),
	);
	expect(backendArgs).toHaveLength(1);
	expect(backendEnvironments[0]?.PYTHONPYCACHEPREFIX).toBe(
		join(paths.dataDirectory, "cache", "python-bytecode"),
	);
	expect(request).toHaveBeenCalledWith(
		new URL("http://127.0.0.1:18188/api/settings/Comfy.Workflow.NamedValuesRestore"),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "true",
			signal: expect.any(AbortSignal),
		},
	);
	await expect(
		access(join(paths.dataDirectory, "data", "custom_nodes")),
	).resolves.toBeUndefined();
	await expect(
		access(
			join(
				paths.dataDirectory,
				"virtual-models",
				"diffusion_models",
				"flux1-dev.safetensors",
			),
		),
	).resolves.toBeUndefined();
	const modelPathsConfig = await readFile(
		join(paths.dataDirectory, "editor-model-paths.json"),
		"utf8",
	);
	expect(modelPathsConfig).not.toContain("\t");
	expect(JSON.parse(modelPathsConfig)).toMatchObject({
		kastard_virtual: {
			base_path: join(paths.dataDirectory, "virtual-models"),
			checkpoints: "checkpoints",
			diffusion_models: "diffusion_models",
			LLM: "LLM",
		},
		kastard_local: {
			base_path: join(paths.dataDirectory, "data", "models"),
			is_default: true,
			checkpoints: "checkpoints",
			configs: "configs",
			controlnet: "controlnet\nt2i_adapter",
			diffusion_models: "unet\ndiffusion_models",
			LLM: "LLM",
			text_encoders: "text_encoders\nclip",
		},
	});
	expect(backendArgs[0]).toEqual(
		expect.arrayContaining([
			"--listen",
			"127.0.0.1",
			"--cpu",
			"--enable-manager",
			"--front-end-root",
			paths.frontendDirectory,
			"--models-directory",
			join(paths.dataDirectory, "virtual-models"),
			"--extra-model-paths-config",
			join(paths.dataDirectory, "editor-model-paths.json"),
		]),
	);
	expect(states).toEqual([
		{ status: "preparing", phase: "python", progress: 5, firstRun: true },
		{ status: "preparing", phase: "python", progress: 20, firstRun: true },
		{ status: "preparing", phase: "dependencies", progress: 20, firstRun: true },
		{ status: "preparing", phase: "dependencies", progress: 25, firstRun: true },
		{ status: "preparing", phase: "dependencies", progress: 38, firstRun: true },
		{ status: "preparing", phase: "dependencies", progress: 80, firstRun: true },
		{ status: "preparing", phase: "dependencies", progress: 88, firstRun: true },
		{ status: "preparing", phase: "dependencies", progress: 90, firstRun: true },
		{ status: "starting" },
		{ status: "ready", url: "http://127.0.0.1:18188/" },
	]);

	await runtime.stop();
	expect(child.signalCode).toBe("SIGTERM");
});

test("lists installed custom nodes and verifies GitHub repositories concurrently", async () => {
	const paths = await fixture();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	await Promise.all([
		createCnrNode(
			join(customNodes, "comfyui-kjnodes"),
			"comfyui-kjnodes",
			"1.5.0",
			"https://github.com/kijai/ComfyUI-KJNodes",
		),
		createCnrNode(
			join(customNodes, "ComfyUI-DaSiWa-Nodes"),
			"different-package",
			"0.4.12",
			"https://github.com/wrong/package",
		),
	]);
	const gitCommit = await createGitHubNode(join(customNodes, "local-git-node"));
	const secondGitNode = join(customNodes, "second-git-node");
	const secondGitCommit = await createGitHubNode(secondGitNode);
	git(
		secondGitNode,
		"remote",
		"set-url",
		"origin",
		"https://github.com/owner/second-git-node.git",
	);
	const child = new FakeProcess();
	let listRequest = 0;
	const request = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname !== "/v2/customnode/installed") {
			return new Response(null, { status: 404 });
		}
		listRequest += 1;
		if (listRequest === 2) {
			return Response.json({
				"../other-repo": { ver: "unknown", cnr_id: null },
			});
		}
		if (listRequest === 3) {
			return Response.json([{ name: "invalid" }]);
		}
		if (listRequest === 4) {
			return new Response(null, { status: 503 });
		}
		return Response.json({
			"local-git-node": {
				ver: "unknown",
				cnr_id: null,
				aux_id: "owner/local-git-node",
			},
			"second-git-node": {
				ver: "unknown",
				cnr_id: null,
				aux_id: "owner/second-git-node",
			},
			"comfyui-kjnodes": {
				ver: "1.5.0",
				cnr_id: "comfyui-kjnodes",
				aux_id: null,
			},
			"ComfyUI-DaSiWa-Nodes": {
				ver: "0.4.12",
				cnr_id: "ComfyUI-DaSiWa-Nodes",
				aux_id: null,
			},
		});
	});
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	await runtime.start();
	await expect(runtime.listCustomNodes()).resolves.toEqual([
		{
			name: "ComfyUI-DaSiWa-Nodes",
			version: "0.4.12",
			managerId: "ComfyUI-DaSiWa-Nodes",
		},
		{
			name: "comfyui-kjnodes",
			version: "1.5.0",
			managerId: "comfyui-kjnodes",
			repository: "https://github.com/kijai/ComfyUI-KJNodes",
		},
		{
			name: "local-git-node",
			version: gitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "second-git-node",
			version: secondGitCommit,
			managerId: null,
			repository: "https://github.com/owner/second-git-node.git",
		},
	]);
	expect(
		request.mock.calls.some(
			([input]) =>
				String(input) === "http://127.0.0.1:18188/v2/customnode/installed?mode=default",
		),
	).toBe(true);
	await expect(runtime.listCustomNodes()).rejects.toThrow(
		"ComfyUI Manager returned an invalid custom-nodes list.",
	);
	await expect(runtime.listCustomNodes()).rejects.toThrow(
		"ComfyUI Manager returned an invalid custom-nodes list.",
	);
	await expect(runtime.listCustomNodes()).rejects.toThrow(
		"ComfyUI Manager returned HTTP 503.",
	);
	await runtime.stop();
});

test("lists local custom nodes without starting ComfyUI", async () => {
	const paths = await fixture();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const cnrNode = join(customNodes, "comfyui-kjnodes");
	const gitNode = join(customNodes, "local-git-node");
	const dirtyGitNode = join(customNodes, "dirty-git-node");
	const submoduleGitNode = join(customNodes, "submodule-git-node");
	const suffixedDisabledGitNode = join(customNodes, "suffixed-git-node.disabled");
	const ignoredGitNode = join(customNodes, "ignored-git-node");
	const localOnlyGitNode = join(customNodes, "local-only-git-node");
	const manualNode = join(customNodes, "manual-node");
	const disabledNodes = join(customNodes, ".disabled");
	await Promise.all([
		mkdir(cnrNode, { recursive: true }),
		mkdir(manualNode, { recursive: true }),
		mkdir(disabledNodes, { recursive: true }),
	]);
	const gitCommit = await createGitHubNode(gitNode);
	const dirtyGitCommit = await createGitHubNode(dirtyGitNode);
	await createGitHubNode(ignoredGitNode);
	await writeFile(join(ignoredGitNode, ".gitignore"), "local-config.py\n");
	git(ignoredGitNode, "add", ".gitignore");
	commitGit(ignoredGitNode, "ignore local config");
	git(ignoredGitNode, "update-ref", "refs/remotes/origin/main", "HEAD");
	await writeFile(join(ignoredGitNode, "local-config.py"), "LOCAL_SETTING = True\n");
	const ignoredGitCommit = git(ignoredGitNode, "rev-parse", "HEAD")
		.trim()
		.toLowerCase();
	await createGitHubNode(localOnlyGitNode);
	await writeFile(join(localOnlyGitNode, "__init__.py"), "LOCAL_ONLY = True\n");
	git(localOnlyGitNode, "add", "__init__.py");
	commitGit(localOnlyGitNode, "local only");
	const localOnlyCommit = git(localOnlyGitNode, "rev-parse", "HEAD")
		.trim()
		.toLowerCase();
	const submoduleSource = join(paths.dataDirectory, "submodule-source");
	const submoduleGitCommit = await addSubmodule(submoduleGitNode, submoduleSource);
	const suffixedDisabledGitCommit = await createGitHubNode(suffixedDisabledGitNode);
	await writeFile(join(submoduleSource, "dependency.py"), "next dependency\n");
	git(submoduleSource, "add", "dependency.py");
	commitGit(submoduleSource, "update dependency");
	const divergentSubmoduleCommit = git(submoduleSource, "rev-parse", "HEAD").trim();
	git(
		join(submoduleGitNode, "dependency"),
		"fetch",
		"origin",
		divergentSubmoduleCommit,
	);
	git(
		join(submoduleGitNode, "dependency"),
		"checkout",
		"--quiet",
		"--detach",
		divergentSubmoduleCommit,
	);
	await writeFile(
		join(submoduleGitNode, "dependency", "dependency.py"),
		"local dependency change\n",
	);
	await writeFile(join(dirtyGitNode, "untracked.txt"), "local change\n");
	await Promise.all([
		writeFile(join(cnrNode, ".tracking"), "__init__.py\n"),
		writeFile(
			join(cnrNode, "pyproject.toml"),
			'[build-system]\nrequires = []\n\n[project]\nname = "comfyui-kjnodes"\nversion = "1.5.0"\n\n[project.urls]\nRepository = "https://github.com/kijai/ComfyUI-KJNodes"\n',
		),
		writeFile(join(customNodes, "manual.py"), "NODE_CLASS_MAPPINGS = {}\n"),
		writeFile(join(disabledNodes, "z-disabled.py"), "NODE_CLASS_MAPPINGS = {}\n"),
	]);
	const startProcess = vi.fn();
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		startProcess,
	});

	await expect(runtime.listCustomNodes()).resolves.toEqual([
		{
			name: "comfyui-kjnodes",
			version: "1.5.0",
			managerId: "comfyui-kjnodes",
			repository: "https://github.com/kijai/ComfyUI-KJNodes",
		},
		{
			name: "dirty-git-node",
			version: dirtyGitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
			workerSyncIssue:
				"Tracked or untracked local changes are not included in the Git commit.",
		},
		{
			name: "ignored-git-node",
			version: ignoredGitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "local-git-node",
			version: gitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "local-only-git-node",
			version: localOnlyCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "manual-node",
			version: "unknown",
			managerId: null,
			workerSyncIssue: "No Registry package or supported GitHub repository was found.",
		},
		{
			name: "manual.py",
			version: "unknown",
			managerId: null,
			workerSyncIssue: "No Registry package or supported GitHub repository was found.",
		},
		{
			name: "submodule-git-node",
			version: submoduleGitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "suffixed-git-node",
			version: suffixedDisabledGitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "z-disabled.py",
			version: "unknown",
			managerId: null,
			workerSyncIssue: "No Registry package or supported GitHub repository was found.",
		},
	]);
	await expect(runtime.getManagerVersion()).resolves.toBe("4.2.2");
	expect(startProcess).not.toHaveBeenCalled();
	expect(runtime.getState()).toEqual({ status: "idle" });
});

test("installs a GitHub custom node with the active ComfyUI Manager", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const repository = "https://github.com/owner/local-git-node.git";
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	let installed = false;
	let releaseInstall: (() => void) | undefined;
	const installGate = new Promise<void>((resolve) => {
		releaseInstall = resolve;
	});
	let installStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		installStarted = resolve;
	});
	let installInvocation:
		| { command: string; args: string[]; env: NodeJS.ProcessEnv }
		| undefined;
	vi.stubEnv("KASTARD_PRIVATE_TOKEN", "not-for-custom-nodes");
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") {
			return Response.json(
				installed ? { "local-git-node": { ver: "unknown", cnr_id: null } } : {},
			);
		}
		return new Response(null, { status: 404 });
	});
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_202,
		fetch: request as typeof fetch,
		runCommand: async (command, args, options) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			installInvocation = { command, args, env: options.env };
			installStarted?.();
			await installGate;
			await createGitHubNode(join(customNodes, "local-git-node"));
			installed = true;
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	const installation = runtime.installCustomNode(repository);
	await started;
	await expect(runtime.installCustomNode(repository)).rejects.toThrow(
		"Another custom-node change is in progress.",
	);
	await expect(runtime.start()).rejects.toThrow(
		"ComfyUI cannot start while a custom-node change is in progress.",
	);
	await expect(runtime.restart()).rejects.toThrow(
		"ComfyUI cannot restart while a custom-node change is in progress.",
	);
	releaseInstall?.();

	const result = await installation;
	expect(result).toMatchObject({
		node: {
			name: "local-git-node",
			managerId: null,
			repository,
		},
		nodes: [
			{
				name: "local-git-node",
				managerId: null,
				repository,
			},
		],
		restartRequired: true,
	});
	expect(installInvocation).toEqual({
		command: join(paths.dataDirectory, "environment", "bin", "python"),
		args: [
			"-m",
			"cm_cli",
			"install",
			repository,
			"--mode",
			"cache",
			"--user-directory",
			join(paths.dataDirectory, "data", "user", "__manager"),
			"--exit-on-fail",
		],
		env: expect.objectContaining({
			COMFYUI_PATH: join(paths.resourcesDirectory, "backend"),
			COMFYUI_FOLDERS_BASE_PATH: join(paths.dataDirectory, "data"),
			GIT_TERMINAL_PROMPT: "0",
			PIP_NO_INPUT: "1",
		}),
	});
	expect(installInvocation?.env.KASTARD_PRIVATE_TOKEN).toBeUndefined();
	expect(
		await readFile(
			join(paths.dataDirectory, "data", "user", "__manager", "extra_model_paths.yaml"),
			"utf8",
		),
	).toContain(`base_path: ${JSON.stringify(join(paths.dataDirectory, "data"))}`);
	await expect(runtime.installCustomNode(repository)).rejects.toThrow(
		"local-git-node already uses this GitHub repository.",
	);
	await runtime.stop();
});

test("resolves registered versions by exact GitHub repository", async () => {
	const paths = await fixture();
	const repository = "https://github.com/owner/registered-node.git";
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === "/nodes/search") {
			return Response.json({
				nodes: [
					{
						id: "different-node",
						repository: "https://github.com/another/registered-node",
						latest_version: { version: "9.9.9" },
					},
					{
						id: "registered-node",
						repository: "https://github.com/Owner/Registered-Node",
						latest_version: { version: "1.2.3" },
					},
				],
			});
		}
		if (url.pathname === "/nodes/registered-node/versions") {
			return Response.json([
				{ version: "1.2.3", status: "active" },
				{ version: "1.2.2", status: "pending" },
				{ version: "1.2.2", status: "pending" },
				{ version: "1.0.0", status: "banned" },
			]);
		}
		return new Response(null, { status: 404 });
	});
	const runtime = new ComfyRuntime({
		...paths,
		registryApiUrl: "https://registry.example.com",
		fetch: request as typeof fetch,
	});

	await expect(runtime.resolveCustomNodeInstallOptions(repository)).resolves.toEqual({
		managerId: "registered-node",
		latestVersion: "1.2.3",
		versions: ["1.2.3", "1.2.2"],
	});
	const searchUrl = new URL(String(request.mock.calls[0]?.[0]));
	expect(searchUrl.searchParams.get("repository_url_search")).toBe(repository);
	const versionsUrl = new URL(String(request.mock.calls[1]?.[0]));
	expect(versionsUrl.searchParams.getAll("statuses")).toEqual([
		"NodeVersionStatusActive",
		"NodeVersionStatusPending",
	]);
});

test("does not treat a fuzzy Registry search result as a registered repository", async () => {
	const paths = await fixture();
	const request = vi.fn(
		async (): Promise<Response> =>
			Response.json({
				nodes: [
					{
						id: "similar-node",
						repository: "https://github.com/another/similar-node",
						latest_version: { version: "1.0.0" },
					},
				],
			}),
	);
	const runtime = new ComfyRuntime({
		...paths,
		registryApiUrl: "https://registry.example.com",
		fetch: request as typeof fetch,
	});

	await expect(
		runtime.resolveCustomNodeInstallOptions(
			"https://github.com/owner/similar-node.git",
		),
	).resolves.toBeNull();
	expect(request).toHaveBeenCalledTimes(1);
});

test.each([
	{ selectedVersion: "1.2.2", packageSpec: "registered-node@1.2.2" },
	{ selectedVersion: "nightly", packageSpec: "registered-node@nightly" },
])(
	"revalidates and installs a registered custom node as $packageSpec",
	async ({ selectedVersion, packageSpec }) => {
		const paths = await fixture();
		const child = new FakeProcess();
		const repository = "https://github.com/owner/registered-node.git";
		const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
		let installed = false;
		let installedCommit = "";
		let invokedPackageSpec: string | undefined;
		const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				return Response.json(
					installed
						? {
								"registered-node": {
									ver:
										selectedVersion === "nightly" ? installedCommit : selectedVersion,
									cnr_id: "registered-node",
								},
							}
						: {},
				);
			}
			if (url.pathname === "/nodes/search") {
				return Response.json({
					nodes: [
						{
							id: "registered-node",
							repository,
							latest_version: { version: "1.2.3" },
						},
					],
				});
			}
			if (url.pathname === "/nodes/registered-node/versions") {
				return Response.json([{ version: "1.2.3" }, { version: "1.2.2" }]);
			}
			return new Response(null, { status: 404 });
		});
		const runtime = new ComfyRuntime({
			...paths,
			platform: "darwin",
			arch: "arm64",
			allocatePort: async () => 18_204,
			registryApiUrl: "https://registry.example.com",
			fetch: request as typeof fetch,
			runCommand: async (_command, args) => {
				await createManagedPython(args);
				if (args[0] !== "-m" || args[1] !== "cm_cli") return;
				invokedPackageSpec = args[3];
				if (selectedVersion === "nightly") {
					installedCommit = await createGitHubNode(
						join(customNodes, "registered-node"),
						repository,
					);
				} else {
					await createCnrNode(
						join(customNodes, "registered-node"),
						"registered-node",
						selectedVersion,
						repository,
					);
				}
				installed = true;
			},
			startProcess: () => child as unknown as ChildProcess,
			retryMs: 1,
		});
		await runtime.start();

		const result = await runtime.installCustomNode(repository, selectedVersion);

		expect(invokedPackageSpec).toBe(packageSpec);
		expect(result.node).toMatchObject({
			name: "registered-node",
			version: selectedVersion === "nightly" ? installedCommit : selectedVersion,
			repository,
		});
		if (selectedVersion === "nightly") expect(result.node.managerId).toBeNull();
		await runtime.stop();
	},
);

test("retains an early dependency failure without trashing the installed custom node", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const repository = "https://github.com/owner/registered-node.git";
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const installedNode = join(customNodes, "registered-node");
	const trashItem = vi.fn(async () => undefined);
	let installed = false;
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") {
			return Response.json(
				installed
					? { "registered-node": { ver: "1.2.3", cnr_id: "registered-node" } }
					: {},
			);
		}
		return new Response(null, { status: 404 });
	});
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_203,
		fetch: request as typeof fetch,
		runCommand: async (_command, args, options) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			await createCnrNode(installedNode, "registered-node", "1.2.3", repository);
			installed = true;
			options.onOutput(
				"[ComfyUI-Manager] Installation failed:\nFailed to execute install script: registered-node@1.2.3\nERROR: An error occurred while installing registered-node\n",
			);
			options.onOutput("x".repeat(20_000));
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(runtime.installCustomNode(repository)).rejects.toThrow(
		"ComfyUI Manager reported installation errors. ERROR: An error occurred while installing registered-node",
	);
	expect(trashItem).not.toHaveBeenCalled();
	await expect(access(installedNode)).resolves.toBeUndefined();
	await runtime.stop();
});

test("moves only the matching incomplete Manager installation to Trash", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const repository = "https://github.com/owner/incomplete-node.git";
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const incompleteNode = join(customNodes, "incomplete-node");
	const unrelatedNode = join(customNodes, "unrelated-node");
	const trashItem = vi.fn(async () => undefined);
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") return Response.json({});
		return new Response(null, { status: 404 });
	});
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_203,
		fetch: request as typeof fetch,
		runCommand: async (_command, args, options) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			await Promise.all([
				createCnrNode(incompleteNode, "incomplete-node", "1.0.0", repository),
				mkdir(unrelatedNode, { recursive: true }),
			]);
			options.onOutput("[ FAIL ] requirements installation failed\n");
			throw new Error("python exited with code 1. Full dependency traceback.");
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(runtime.installCustomNode(repository)).rejects.toThrow(
		"ComfyUI Manager reported installation errors. [ FAIL ] requirements installation failed",
	);
	expect(trashItem).toHaveBeenCalledWith(incompleteNode);
	expect(trashItem).not.toHaveBeenCalledWith(unrelatedNode);
	await runtime.stop();
});

test("rejects an unrelated directory reported after a failed installation", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const unrelatedNode = join(customNodes, "unrelated-node");
	const trashItem = vi.fn(async () => undefined);
	let installed = false;
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") {
			return Response.json(
				installed ? { "unrelated-node": { ver: "unknown", cnr_id: null } } : {},
			);
		}
		return new Response(null, { status: 404 });
	});
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_203,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			await mkdir(unrelatedNode, { recursive: true });
			installed = true;
			throw new Error("python exited with code 1");
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(
		runtime.installCustomNode("https://github.com/owner/requested-node.git"),
	).rejects.toThrow("ComfyUI Manager could not install the custom node.");
	expect(trashItem).not.toHaveBeenCalled();
	await expect(access(unrelatedNode)).resolves.toBeUndefined();
	await runtime.stop();
});

test("cancels an active custom-node installation when ComfyUI stops", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	let installStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		installStarted = resolve;
	});
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") return Response.json({});
		return new Response(null, { status: 404 });
	});
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		fetch: request as typeof fetch,
		runCommand: async (_command, args, options) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			installStarted?.();
			await new Promise<void>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
			});
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	const installation = runtime.installCustomNode(
		"https://github.com/owner/canceled-node.git",
	);
	await started;
	await runtime.stop();
	await expect(installation).rejects.toThrow("Custom-node installation was canceled.");
	expect(child.signalCode).toBe("SIGTERM");
});

test("times out an unresponsive Manager inventory during installation", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
			}
			return new Response(null, { status: 404 });
		},
	);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		customNodeInventoryTimeoutMs: 5,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	await expect(
		runtime.installCustomNode("https://github.com/owner/timeout-node.git"),
	).rejects.toThrow(
		"ComfyUI Manager did not return the custom-node inventory in time.",
	);
	await runtime.stop();
});

test("maps a stalled Manager inventory body to the timeout error", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				return {
					ok: true,
					json: () =>
						new Promise((_resolve, reject) => {
							init?.signal?.addEventListener(
								"abort",
								() => reject(new Error("aborted")),
								{ once: true },
							);
						}),
				} as Response;
			}
			return new Response(null, { status: 404 });
		},
	);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		customNodeInventoryTimeoutMs: 5,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	await expect(
		runtime.installCustomNode("https://github.com/owner/stalled-body-node.git"),
	).rejects.toThrow(
		"ComfyUI Manager did not return the custom-node inventory in time.",
	);
	await runtime.stop();
});

test("cancels an unresponsive Manager inventory when ComfyUI stops", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	let inventoryStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		inventoryStarted = resolve;
	});
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				inventoryStarted?.();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
			}
			return new Response(null, { status: 404 });
		},
	);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	const installation = runtime.installCustomNode(
		"https://github.com/owner/canceled-node.git",
	);
	await started;
	await runtime.stop();
	await expect(installation).rejects.toThrow("Custom-node installation was canceled.");
});

test("cancels a Registry version lookup when ComfyUI stops", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	let lookupStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		lookupStarted = resolve;
	});
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") return Response.json({});
			if (url.pathname === "/nodes/search") {
				lookupStarted?.();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
			}
			return new Response(null, { status: 404 });
		},
	);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		registryApiUrl: "https://registry.example.com",
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	const installation = runtime.installCustomNode(
		"https://github.com/owner/canceled-node.git",
		"1.0.0",
	);
	await started;
	await runtime.stop();
	await expect(installation).rejects.toThrow("Custom-node installation was canceled.");
});

test("uninstalls Manager-owned custom nodes without restarting ComfyUI", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const trashItem = vi.fn(async () => undefined);
	let queuedTask: Record<string, unknown> | null = null;
	let uninstallComplete = false;
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				return Response.json({
					"ComfyUI-Manager": { ver: "4.2.2", cnr_id: null },
					"comfyui-kjnodes": { ver: "1.5.0", cnr_id: "comfyui-kjnodes" },
				});
			}
			if (url.pathname === "/v2/manager/queue/task") {
				queuedTask = JSON.parse(String(init?.body));
				return Response.json({});
			}
			if (url.pathname === "/v2/manager/queue/start") return Response.json({});
			if (url.pathname === "/v2/manager/queue/history") {
				if (!uninstallComplete) return Response.json({ history: {} });
				const taskId = String(queuedTask?.ui_id);
				return Response.json({
					history: {
						ui_id: taskId,
						status: { completed: true, status_str: "success", messages: [] },
					},
				});
			}
			return new Response(null, { status: 404 });
		},
	);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_198,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(runtime.removeCustomNode("ComfyUI-Manager")).rejects.toThrow(
		"ComfyUI Manager cannot be removed from Kastard.",
	);
	const removal = runtime.removeCustomNode("comfyui-kjnodes");
	await vi.waitFor(() => expect(queuedTask).not.toBeNull());
	await expect(runtime.start()).rejects.toThrow(
		"ComfyUI cannot start while a custom-node change is in progress.",
	);
	await expect(runtime.restart()).rejects.toThrow(
		"ComfyUI cannot restart while a custom-node change is in progress.",
	);
	expect(child.signalCode).toBeNull();
	uninstallComplete = true;
	await expect(removal).resolves.toEqual({
		restartRequired: true,
	});

	expect(queuedTask).toMatchObject({
		ui_id: expect.stringMatching(/^kastard-/u),
		client_id: expect.stringMatching(/^kastard-/u),
		kind: "uninstall",
		params: { node_name: "comfyui-kjnodes", is_unknown: false },
	});
	expect(trashItem).not.toHaveBeenCalled();
	expect(runtime.getState()).toEqual({
		status: "ready",
		url: "http://127.0.0.1:18198/",
	});
	await runtime.stop();
});

test("moves a manual custom-node symlink to Trash without following it", async () => {
	const paths = await fixture();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const externalNode = join(paths.dataDirectory, "external-node");
	const nodePath = join(customNodes, "linked-node");
	await mkdir(customNodes, { recursive: true });
	await createGitHubNode(externalNode);
	await symlink(externalNode, nodePath);
	const child = new FakeProcess();
	const trashItem = vi.fn(async () => undefined);
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") {
			return Response.json({ "linked-node": { ver: "unknown", cnr_id: null } });
		}
		return new Response(null, { status: 404 });
	});
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_199,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(runtime.removeCustomNode("linked-node")).resolves.toEqual({
		restartRequired: true,
	});
	expect(trashItem).toHaveBeenCalledWith(nodePath);
	await expect(access(externalNode)).resolves.toBeUndefined();
	await runtime.stop();
});

test("allows Trash recovery only after a custom-node startup failure", async () => {
	const paths = await fixture();
	const nodePath = join(paths.dataDirectory, "data", "custom_nodes", "broken-node");
	await mkdir(nodePath, { recursive: true });
	const child = new FakeProcess();
	const trashItem = vi.fn(async () => undefined);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_200,
		fetch: vi.fn().mockRejectedValue(new Error("ComfyUI is not ready.")),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => {
			queueMicrotask(() => {
				child.stderr.write("(IMPORT FAILED): broken-node\n");
				child.stderr.write("x".repeat(13_000));
				child.exit(1);
			});
			return child as unknown as ChildProcess;
		},
		retryMs: 1,
		startupTimeoutMs: 500,
		trashItem,
	});

	await expect(runtime.start()).rejects.toThrow("ComfyUI exited with code 1.");
	expect(runtime.getState()).toMatchObject({ status: "error", reason: "custom-node" });
	await expect(runtime.removeCustomNode("broken-node")).resolves.toEqual({
		restartRequired: false,
	});
	expect(trashItem).toHaveBeenCalledWith(nodePath);

	const genericPaths = await fixture();
	const genericNode = join(
		genericPaths.dataDirectory,
		"data",
		"custom_nodes",
		"generic-node",
	);
	await mkdir(genericNode, { recursive: true });
	const genericChild = new FakeProcess();
	const genericRuntime = new ComfyRuntime({
		...genericPaths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_201,
		fetch: vi.fn().mockRejectedValue(new Error("ComfyUI is not ready.")),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => {
			queueMicrotask(() => {
				genericChild.stderr.write("Backend process failed.\n");
				genericChild.exit(1);
			});
			return genericChild as unknown as ChildProcess;
		},
		retryMs: 1,
		startupTimeoutMs: 500,
		trashItem,
	});
	await expect(genericRuntime.start()).rejects.toThrow("Backend process failed.");
	expect(genericRuntime.getState()).toMatchObject({ status: "error" });
	expect(genericRuntime.getState()).not.toHaveProperty("reason");
	await expect(genericRuntime.removeCustomNode("generic-node")).rejects.toThrow(
		"Custom nodes can only be removed while ComfyUI is ready.",
	);
});

test("keeps a CNR package when its repository URL is invalid", async () => {
	const paths = await fixture();
	await createCnrNode(
		join(paths.dataDirectory, "data", "custom_nodes", "comfyui-kjnodes"),
		"comfyui-kjnodes",
		"1.5.0",
		"file:///private/custom-node",
	);
	const runtime = new ComfyRuntime({ ...paths, platform: "darwin", arch: "arm64" });

	await expect(runtime.listCustomNodes()).resolves.toEqual([
		{
			name: "comfyui-kjnodes",
			version: "1.5.0",
			managerId: "comfyui-kjnodes",
		},
	]);
});

test("uses the local GitHub origin and HEAD without checking remote reachability", async () => {
	const paths = await fixture();
	const directory = join(
		paths.dataDirectory,
		"data",
		"custom_nodes",
		"tagged-git-node",
	);
	const commit = await createGitHubNode(directory);
	git(directory, "update-ref", "-d", "refs/remotes/origin/main");
	git(directory, "tag", "v1.0.0");
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
	});

	await expect(runtime.listCustomNodes()).resolves.toEqual([
		{
			name: "tagged-git-node",
			version: commit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
	]);
});

test("does not treat a repository subdirectory or symlink as a GitHub custom node", async () => {
	const paths = await fixture();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const nestedNode = join(customNodes, "nested-node");
	const externalNode = join(paths.dataDirectory, "external-node");
	await mkdir(nestedNode, { recursive: true });
	git(customNodes, "init", "--quiet");
	await writeFile(join(nestedNode, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
	git(customNodes, "add", "nested-node/__init__.py");
	commitGit(customNodes, "add nested node");
	git(customNodes, "remote", "add", "origin", "https://github.com/owner/monorepo.git");
	git(customNodes, "update-ref", "refs/remotes/origin/main", "HEAD");
	await createGitHubNode(externalNode);
	await symlink(externalNode, join(customNodes, "symlink-node"));
	const runtime = new ComfyRuntime({ ...paths, platform: "darwin", arch: "arm64" });

	await expect(runtime.listCustomNodes()).resolves.toEqual([
		{
			name: ".git",
			version: "unknown",
			managerId: null,
			workerSyncIssue: "No Registry package or supported GitHub repository was found.",
		},
		{
			name: "nested-node",
			version: "unknown",
			managerId: null,
			workerSyncIssue:
				"The custom node directory is not the root of its Git repository.",
		},
		{
			name: "symlink-node",
			version: "unknown",
			managerId: null,
			workerSyncIssue:
				"Symbolic-link custom node directories cannot be reproduced on the Worker.",
		},
	]);
});

test("replaces virtual model placeholders and rejects unsafe paths", async () => {
	const paths = await fixture();
	const runtime = new ComfyRuntime(paths);
	await mkdir(join(paths.dataDirectory, "data", "models", "ipadapter"), {
		recursive: true,
	});
	const updatedModel = {
		...virtualModel,
		path: "diffusion_models/flux-dev.safetensors",
	};
	const customModel = {
		...virtualModel,
		path: "custom_models/example.safetensors",
	};

	await runtime.syncModels([]);
	expect(
		JSON.parse(
			await readFile(join(paths.dataDirectory, "editor-model-paths.json"), "utf8"),
		).kastard_local.diffusion_models,
	).toBe("unet\ndiffusion_models");
	await Promise.all([
		mkdir(join(paths.dataDirectory, "virtual-models", "base_path")),
		mkdir(join(paths.dataDirectory, "virtual-models", "is_default")),
	]);
	await runtime.syncModels([]);
	const reservedPathsConfig = JSON.parse(
		await readFile(join(paths.dataDirectory, "editor-model-paths.json"), "utf8"),
	);
	expect(reservedPathsConfig.kastard_virtual.base_path).toBe(
		join(paths.dataDirectory, "virtual-models"),
	);
	expect(reservedPathsConfig.kastard_virtual.is_default).toBeUndefined();
	expect(reservedPathsConfig.kastard_local.base_path).toBe(
		join(paths.dataDirectory, "data", "models"),
	);
	expect(reservedPathsConfig.kastard_local.is_default).toBe(true);
	expect(reservedPathsConfig.kastard_local.ipadapter).toBe("ipadapter");
	await runtime.syncModels([virtualModel]);
	await runtime.syncModels([updatedModel]);

	await expect(
		access(
			join(
				paths.dataDirectory,
				"virtual-models",
				"diffusion_models",
				"flux1-dev.safetensors",
			),
		),
	).rejects.toThrow();
	await expect(
		access(
			join(
				paths.dataDirectory,
				"virtual-models",
				"diffusion_models",
				"flux-dev.safetensors",
			),
		),
	).resolves.toBeUndefined();
	await runtime.syncModels([]);
	await expect(
		access(
			join(
				paths.dataDirectory,
				"virtual-models",
				"diffusion_models",
				"flux-dev.safetensors",
			),
		),
	).rejects.toThrow();
	await expect(
		access(join(paths.dataDirectory, "virtual-models", "diffusion_models")),
	).resolves.toBeUndefined();
	await runtime.syncModels([customModel]);
	await runtime.syncModels([]);
	await expect(
		access(join(paths.dataDirectory, "virtual-models", "custom_models")),
	).resolves.toBeUndefined();
	expect(
		JSON.parse(
			await readFile(join(paths.dataDirectory, "editor-model-paths.json"), "utf8"),
		).kastard_virtual.custom_models,
	).toBe("custom_models");
	await expect(
		runtime.syncModels([{ ...virtualModel, path: "../escape/model.safetensors" }]),
	).rejects.toThrow("Invalid virtual model path");
	await expect(
		runtime.syncModels([{ ...virtualModel, path: "base_path/model.safetensors" }]),
	).rejects.toThrow("Invalid virtual model path");
	await expect(
		runtime.syncModels([{ ...virtualModel, path: "is_default/model.safetensors" }]),
	).rejects.toThrow("Invalid virtual model path");
});

test("projects LLM GGUF files into the primary model directory", async () => {
	const paths = await fixture();
	const runtime = new ComfyRuntime(paths);

	await runtime.syncModels([
		{ ...virtualModel, id: "qwen", path: "LLM/Qwen3-4B-Q4_K_M.gguf" },
		{ ...virtualModel, id: "mmproj", path: "LLM/mmproj-model-f16.gguf" },
	]);

	await expect(
		access(join(paths.dataDirectory, "virtual-models", "LLM", "Qwen3-4B-Q4_K_M.gguf")),
	).resolves.toBeUndefined();
	await expect(
		access(join(paths.dataDirectory, "virtual-models", "LLM", "mmproj-model-f16.gguf")),
	).resolves.toBeUndefined();
});

test("preserves user model files while replacing generated placeholders", async () => {
	const paths = await fixture();
	const runtime = new ComfyRuntime(paths);
	const directory = join(paths.dataDirectory, "virtual-models", "diffusion_models");
	const userModel = join(directory, "local.safetensors");

	await runtime.syncModels([virtualModel]);
	await writeFile(userModel, "local model data");
	await runtime.syncModels([]);

	await expect(readFile(userModel, "utf8")).resolves.toBe("local model data");
	await expect(access(join(directory, "flux1-dev.safetensors"))).rejects.toThrow();
});

test("recovers user model files when an interrupted swap directory is recreated", async () => {
	const paths = await fixture();
	const runtime = new ComfyRuntime(paths);
	const directory = join(paths.dataDirectory, "virtual-models");
	const previous = `${directory}.previous`;
	const userModel = join(previous, "diffusion_models", "local.safetensors");

	await mkdir(dirname(userModel), { recursive: true });
	await writeFile(userModel, "local model data");
	await mkdir(directory, { recursive: true });
	await runtime.syncModels([]);

	await expect(
		readFile(join(directory, "diffusion_models", "local.safetensors"), "utf8"),
	).resolves.toBe("local model data");
	await expect(access(previous)).rejects.toThrow();
});

test("reuses a completed environment without reinstalling dependencies", async () => {
	const paths = await fixture();
	const install = vi.fn(async (_command: string, args: string[]) =>
		createManagedPython(args),
	);
	const first = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: install,
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
	});
	await first.start();
	await first.stop();

	const reinstall = vi.fn();
	const reusedStates: ComfyRuntimeState[] = [];
	const second = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_189,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: reinstall,
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
	});
	second.subscribe((state) => reusedStates.push(state));
	await expect(second.start()).resolves.toBe("http://127.0.0.1:18189/");
	expect(reinstall).not.toHaveBeenCalled();
	expect(reusedStates).toEqual([
		{ status: "starting" },
		{ status: "ready", url: "http://127.0.0.1:18189/" },
	]);
	await second.stop();
});

test("updates a compatible environment without deleting custom dependencies", async () => {
	const paths = await fixture();
	const first = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
	});
	await first.start();
	await first.stop();
	const preservedPackage = join(
		paths.dataDirectory,
		"environment",
		"custom-package.txt",
	);
	await writeFile(preservedPackage, "installed");
	await writeRuntimeManifest(paths.resourcesDirectory, {
		version: "0.33.2",
		sha256: "updated-backend-sha",
	});

	const commands: string[][] = [];
	const updated = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_189,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => {
			commands.push(args);
		},
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
	});
	await updated.start();

	expect(commands).toHaveLength(1);
	expect(commands[0]?.slice(0, 2)).toEqual(["pip", "install"]);
	await expect(access(preservedPackage)).resolves.toBeUndefined();
	await updated.stop();
});

test("restores custom node requirements after a Python upgrade", async () => {
	const paths = await fixture();
	const environmentDirectory = join(paths.dataDirectory, "environment");
	const requirement = join(
		paths.dataDirectory,
		"data",
		"custom_nodes",
		"example-node",
		"requirements.txt",
	);
	await mkdir(join(environmentDirectory, "bin"), { recursive: true });
	await mkdir(dirname(requirement), { recursive: true });
	await writeFile(join(environmentDirectory, "bin", "python"), "");
	await writeFile(requirement, "example-package==1.0\n");
	await writeFile(
		join(environmentDirectory, ".kastard-runtime.json"),
		JSON.stringify({
			...runtimeManifest,
			pythonVersion: "3.11.9",
			dependencyLockSha256: runtimeManifest.dependencyLock.sha256,
			uvVersion: runtimeManifest.uv.version,
		}),
	);
	const commands: string[][] = [];
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => {
			commands.push(args);
			await createManagedPython(args);
		},
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
	});

	await runtime.start();

	expect(commands).toHaveLength(3);
	expect(commands[0]?.[0]).toBe("venv");
	expect(commands[2]).toEqual(expect.arrayContaining(["--requirements", requirement]));
	await runtime.stop();
});

test("reports an unexpected backend exit after startup", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();
	child.stderr.write("backend failed");
	child.exit(1);

	expect(runtime.getState()).toEqual({
		status: "error",
		message: "ComfyUI exited with code 1. backend failed",
	});
});

test("does not expose ComfyUI as ready when frontend settings fail", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			return new Response(null, {
				status:
					url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
						? 503
						: 200,
			});
		}),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	await expect(runtime.start()).rejects.toThrow(
		"ComfyUI frontend settings returned HTTP 503.",
	);
	expect(runtime.getState()).toEqual({
		status: "error",
		message: "ComfyUI frontend settings returned HTTP 503.",
	});
	expect(child.signalCode).toBe("SIGTERM");
});

test("fails startup when frontend settings do not respond", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname !== "/api/settings/Comfy.Workflow.NamedValuesRestore") {
				return Promise.resolve(new Response(null, { status: 200 }));
			}
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
					once: true,
				});
			});
		}),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		startupTimeoutMs: 10,
		retryMs: 1,
	});

	await expect(runtime.start()).rejects.toThrow(
		"ComfyUI frontend settings could not be applied.",
	);
	expect(runtime.getState()).toMatchObject({ status: "error" });
	expect(child.signalCode).toBe("SIGTERM");
});

test("does not expose ComfyUI as ready when it exits after applying frontend settings", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore") {
				child.exit(1);
			}
			return new Response(null, { status: 200 });
		}),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	await expect(runtime.start()).rejects.toThrow("ComfyUI exited with code 1.");
	expect(runtime.getState()).toEqual({
		status: "error",
		message: "ComfyUI exited with code 1.",
	});
});

test("reports a backend process spawn error", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn().mockRejectedValue(new Error("not ready")),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => {
			queueMicrotask(() => child.fail(new Error("spawn EACCES")));
			return child as unknown as ChildProcess;
		},
		retryMs: 1,
	});

	await expect(runtime.start()).rejects.toThrow("ComfyUI process failed. spawn EACCES");
	expect(runtime.getState()).toEqual({
		status: "error",
		message: "ComfyUI process failed. spawn EACCES",
	});
});

test("does not spawn ComfyUI after stop while allocating a port", async () => {
	const paths = await fixture();
	const first = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
	});
	await first.start();
	await first.stop();

	let resolvePort: ((port: number) => void) | undefined;
	let markAllocationStarted: (() => void) | undefined;
	const allocationStarted = new Promise<void>((resolve) => {
		markAllocationStarted = resolve;
	});
	const startProcess = vi.fn(() => new FakeProcess() as unknown as ChildProcess);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: () => {
			markAllocationStarted?.();
			return new Promise<number>((resolve) => {
				resolvePort = resolve;
			});
		},
		runCommand: vi.fn(),
		startProcess,
	});
	const start = runtime.start();
	await allocationStarted;
	const stopping = runtime.stop();
	resolvePort?.(18_189);
	await stopping;

	await expect(start).rejects.toThrow(/abort/iu);
	expect(startProcess).not.toHaveBeenCalled();
	expect(runtime.getState()).toEqual({ status: "idle" });
});

test("cancels environment preparation when the runtime stops", async () => {
	const paths = await fixture();
	let preparationStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		preparationStarted = resolve;
	});
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		runCommand: async (_command, _args, options) => {
			preparationStarted?.();
			await new Promise<void>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
			});
		},
	});
	const start = runtime.start();
	await started;
	await runtime.stop();

	await expect(start).rejects.toThrow("aborted");
	expect(runtime.getState()).toEqual({ status: "idle" });
});

test("waits for an aborted preparation process to close", async () => {
	const paths = await fixture();
	const uv = join(paths.resourcesDirectory, "bin", "uv");
	const startedMarker = join(paths.dataDirectory, "preparation-started");
	const stoppingMarker = join(paths.dataDirectory, "preparation-stopping");
	const exitMarker = join(paths.dataDirectory, "preparation-exit");
	await writeFile(
		uv,
		`#!/usr/bin/env node
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
mkdirSync(${JSON.stringify(paths.dataDirectory)}, { recursive: true });
let stopping = false;
process.on("SIGTERM", () => {
	stopping = true;
	writeFileSync(${JSON.stringify(stoppingMarker)}, "");
});
setInterval(() => {
	if (stopping && existsSync(${JSON.stringify(exitMarker)})) process.exit(1);
}, 5);
writeFileSync(${JSON.stringify(startedMarker)}, "");
`,
	);
	await chmod(uv, 0o755);
	const runtime = new ComfyRuntime({ ...paths, platform: "darwin", arch: "arm64" });
	const start = runtime.start();
	await vi.waitFor(() => access(startedMarker));

	let stopped = false;
	const stopping = runtime.stop().then(() => {
		stopped = true;
	});
	await vi.waitFor(() => access(stoppingMarker));
	try {
		expect(stopped).toBe(false);
	} finally {
		await writeFile(exitMarker, "");
	}
	await stopping;

	await expect(start).rejects.toThrow(/abort/iu);
	expect(runtime.getState()).toEqual({ status: "idle" });
});

test("terminates preparation descendants before releasing runtime state", async () => {
	const paths = await fixture();
	const uv = join(paths.resourcesDirectory, "bin", "uv");
	const startedMarker = join(paths.dataDirectory, "descendant-started");
	const stoppingMarker = join(paths.dataDirectory, "descendant-stopping");
	const activityMarker = join(paths.dataDirectory, "descendant-activity");
	const descendantSource = `
const { appendFileSync, writeFileSync } = require("node:fs");
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(stoppingMarker)}, ""));
setInterval(() => appendFileSync(${JSON.stringify(activityMarker)}, "x"), 5);
`;
	await writeFile(
		uv,
		`#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
mkdirSync(${JSON.stringify(paths.dataDirectory)}, { recursive: true });
spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
	stdio: "ignore",
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(startedMarker)}, "");
`,
	);
	await chmod(uv, 0o755);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		terminationTimeoutMs: 100,
	});
	const start = runtime.start();
	await vi.waitFor(() => access(startedMarker));
	await vi.waitFor(() => access(activityMarker));

	await runtime.stop();
	await expect(start).rejects.toThrow(/abort/iu);
	await expect(access(stoppingMarker)).resolves.toBeUndefined();
	const activity = await readFile(activityMarker, "utf8");
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(await readFile(activityMarker, "utf8")).toBe(activity);
	expect(runtime.getState()).toEqual({ status: "idle" });
});

test("starts a selected ComfyUI release from its own requirements", async () => {
	const paths = await fixture();
	const selected = await selectedBackend();
	const commands: string[][] = [];
	const backendArgs: string[][] = [];
	const frontendDirectory = join(paths.dataDirectory, "selected-frontend");
	await mkdir(frontendDirectory, { recursive: true });
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_190,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => {
			commands.push(args);
			await createManagedPython(args);
		},
		startProcess: (_command, args) => {
			backendArgs.push(args);
			return new FakeProcess() as unknown as ChildProcess;
		},
		retryMs: 1,
		resolveBackend: async () => selected,
		resolveFrontend: async () => frontendDirectory,
		selectedBackendDirectory: async () => selected.directory,
	});

	await expect(runtime.start()).resolves.toBe("http://127.0.0.1:18190/");

	expect(commands[1]).not.toContain("--require-hashes");
	expect(commands[1]).toEqual(
		expect.arrayContaining([
			"--requirements",
			join(selected.directory, "requirements.txt"),
			"--requirements",
			join(selected.directory, "manager_requirements.txt"),
		]),
	);
	expect(backendArgs[0]).toEqual(
		expect.arrayContaining([
			join(selected.directory, "main.py"),
			"--front-end-root",
			frontendDirectory,
		]),
	);
	await expect(runtime.getManagerVersion()).resolves.toBe("4.3.0");
});

test("installs an exact Manager override after the bundled hash lock", async () => {
	const paths = await fixture();
	const commands: string[][] = [];
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_195,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => {
			commands.push(args);
			await createManagedPython(args);
		},
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
		resolveManagerVersion: () => "4.3.0",
	});

	await runtime.start();

	expect(commands[1]).toEqual(
		expect.arrayContaining([
			"--require-hashes",
			"--requirements",
			join(paths.resourcesDirectory, "backend", "runtime-lock.txt"),
		]),
	);
	expect(commands[2]).toEqual(
		expect.arrayContaining(["pip", "install", "comfyui_manager==4.3.0"]),
	);
	expect(
		JSON.parse(
			await readFile(
				join(paths.dataDirectory, "environment", ".kastard-runtime.json"),
				"utf8",
			),
		),
	).toMatchObject({ managerVersion: "4.3.0" });
});

test("replaces a selected backend Manager requirement with the override", async () => {
	const paths = await fixture();
	await writeRuntimeManifest(paths.resourcesDirectory, { platform: "linux-arm64" });
	const selected = await selectedBackend();
	const commands: string[][] = [];
	const runtime = new ComfyRuntime({
		...paths,
		platform: "linux",
		arch: "arm64",
		allocatePort: async () => 18_197,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => {
			commands.push(args);
			await createManagedPython(args);
		},
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
		resolveBackend: async () => selected,
		resolveManagerVersion: () => "4.4.0",
	});

	await runtime.start();

	expect(commands[1]).toEqual(
		expect.arrayContaining([
			"--requirements",
			join(selected.directory, "requirements.txt"),
		]),
	);
	expect(commands[1]).not.toContain(
		join(selected.directory, "manager_requirements.txt"),
	);
	expect(commands[1]).toEqual(expect.arrayContaining(["--torch-backend", "cpu"]));
	expect(commands[2]).toContain("comfyui_manager==4.4.0");
	expect(commands[2]).toEqual(expect.arrayContaining(["--torch-backend", "cpu"]));
});

test("keeps the environment reusable after a Manager dependency change fails", async () => {
	const paths = await fixture();
	const customRequirements = join(
		paths.dataDirectory,
		"data",
		"custom_nodes",
		"example",
		"requirements.txt",
	);
	let managerVersion = "4.2.2";
	let failManagerInstall = false;
	let dependencyInstalls = 0;
	let environmentCreates = 0;
	const installs: string[][] = [];
	const states: ComfyRuntimeState[] = [];
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_196,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => {
			await createManagedPython(args);
			if (args[0] === "venv") environmentCreates += 1;
			if (args[0] !== "pip") return;
			installs.push(args);
			dependencyInstalls += 1;
			if (failManagerInstall && args.includes("comfyui_manager==4.3.0")) {
				throw new Error("Manager install failed.");
			}
		},
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
		resolveManagerVersion: () => managerVersion,
	});
	runtime.subscribe((state) => states.push(state));
	const stamp = join(paths.dataDirectory, "environment", ".kastard-runtime.json");

	await runtime.start();
	await runtime.stop();
	managerVersion = "4.3.0";
	failManagerInstall = true;
	await expect(runtime.start()).rejects.toThrow("Manager install failed.");
	expect(JSON.parse(await readFile(stamp, "utf8"))).toEqual({
		pythonVersion: runtimeManifest.pythonVersion,
	});
	await mkdir(dirname(customRequirements), { recursive: true });
	await writeFile(customRequirements, "example-package==1.0.0\n");

	managerVersion = "4.2.2";
	failManagerInstall = false;
	const installsBeforeRecovery = dependencyInstalls;
	states.length = 0;
	await runtime.start();
	expect(dependencyInstalls).toBeGreaterThan(installsBeforeRecovery);
	expect(
		installs
			.slice(installsBeforeRecovery)
			.some((args) => args.includes(customRequirements)),
	).toBe(true);
	expect(environmentCreates).toBe(1);
	expect(states).toContainEqual(
		expect.objectContaining({ status: "preparing", firstRun: true }),
	);
});

test("rebuilds the environment when the selected release changes", async () => {
	const paths = await fixture();
	const selected = await selectedBackend();
	let backend: Awaited<ReturnType<typeof selectedBackend>> | null = null;
	const installs: string[][] = [];
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_191,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => {
			if (args[0] === "pip") installs.push(args);
			await createManagedPython(args);
		},
		startProcess: () => new FakeProcess() as unknown as ChildProcess,
		retryMs: 1,
		resolveBackend: async () => backend,
	});

	await runtime.start();
	expect(installs).toHaveLength(1);

	backend = selected;
	await runtime.restart();

	expect(installs).toHaveLength(2);
	expect(installs[0]).toContain("--require-hashes");
	expect(installs[1]).not.toContain("--require-hashes");
});

async function selectedBackend(): Promise<{
	directory: string;
	version: string;
	sha256: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "kastard-comfy-selected-test-"));
	temporaryDirectories.push(root);
	const directory = join(root, "0.34.0");
	await mkdir(directory, { recursive: true });
	await Promise.all([
		writeFile(join(directory, "main.py"), ""),
		writeFile(join(directory, "requirements.txt"), "torch\n"),
		writeFile(join(directory, "manager_requirements.txt"), "comfyui_manager==4.3.0\n"),
	]);
	return { directory, version: "0.34.0", sha256: "b".repeat(64) };
}

test("waits for the previous ComfyUI to exit before restarting", async () => {
	const paths = await fixture();
	const processes: ControlledExitProcess[] = [];
	const installs: number[] = [];
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_192,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => {
			if (args[0] === "pip") installs.push(processes.length);
			await createManagedPython(args);
		},
		startProcess: () => {
			const child = new ControlledExitProcess();
			processes.push(child);
			return child as unknown as ChildProcess;
		},
		retryMs: 1,
	});
	await runtime.start();
	expect(processes).toHaveLength(1);

	const restarted = runtime.restart();
	await Promise.resolve();
	// The replacement must not begin installing while the old process is still alive.
	expect(installs).toHaveLength(1);
	processes[0]?.finishExit();
	await restarted;

	expect(processes).toHaveLength(2);
	expect(processes[0]?.exitCode).toBe(0);
});

test("forces ComfyUI to exit when graceful shutdown times out", async () => {
	const paths = await fixture();
	const child = new ControlledExitProcess();
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_193,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		terminationTimeoutMs: 1,
	});
	await runtime.start();

	await runtime.stop();

	expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(child.signalCode).toBe("SIGKILL");
});

/** Exits only when told to, the way a real process does after SIGTERM. */
class ControlledExitProcess extends FakeProcess {
	readonly signals: NodeJS.Signals[] = [];

	override kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.signals.push(signal);
		return signal === "SIGKILL" ? super.kill(signal) : true;
	}

	finishExit(): void {
		this.exitCode = 0;
		this.emit("exit", 0, null);
	}
}
