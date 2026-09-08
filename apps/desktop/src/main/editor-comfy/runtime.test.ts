// @vitest-environment node

import type { ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ComfyRuntimeState } from "../../shared/api";
import { ComfyRuntime } from "./runtime";

import {
	createManagedPython,
	FakeProcess,
	fixture,
	runtimeManifest,
	temporaryDirectories,
	virtualModel,
	writeRuntimeManifest,
} from "./test-fixture";

test("prepares a managed CPU environment and starts ComfyUI with Manager", async () => {
	const paths = await fixture();
	const commands: string[][] = [];
	const backendArgs: string[][] = [];
	const backendEnvironments: NodeJS.ProcessEnv[] = [];
	const child = new FakeProcess();
	const states: ComfyRuntimeState[] = [];
	const restoreResults = vi.fn(async () => {
		expect(states.at(-1)).toEqual({ status: "starting" });
	});
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
		restoreResults,
	});
	runtime.subscribe((state) => states.push(state));

	await expect(runtime.start()).resolves.toBe("http://127.0.0.1:18188/");
	await expect(runtime.start()).resolves.toBe("http://127.0.0.1:18188/");
	expect(restoreResults).toHaveBeenCalledOnce();

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
	await runtime.restart(new AbortController().signal);

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

	const restarted = runtime.restart(new AbortController().signal);
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

test("cancels result restoration when startup is stopped", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	let markRestoring = (): void => {};
	const restoring = new Promise<void>((resolve) => {
		markRestoring = resolve;
	});
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		restoreResults: async (signal) => {
			markRestoring();
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		},
	});
	const start = runtime.start();
	const rejected = expect(start).rejects.toThrow(/abort/iu);
	await restoring;
	await runtime.stop();
	await rejected;
	expect(child.signalCode).toBe("SIGTERM");
	expect(runtime.getState()).toEqual({ status: "idle" });
});

test("does not start another process when shutdown interrupts a restart", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	child.kill = () => true;
	const startProcess = vi.fn(() => child as unknown as ChildProcess);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18188,
		fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess,
		retryMs: 1,
	});
	await runtime.start();
	const controller = new AbortController();
	const restarting = runtime.restart(controller.signal);
	const rejected = expect(restarting).rejects.toThrow();
	controller.abort();
	const stopping = runtime.stop();
	child.exit(0);
	await Promise.all([rejected, stopping]);
	expect(startProcess).toHaveBeenCalledOnce();
	expect(runtime.getState()).toEqual({ status: "idle" });
});
