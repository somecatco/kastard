import { afterEach, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { BackendProvisionerApi } from "./backend-provisioner";
import { ComfyRuntime, ComfyRuntimeStartError } from "./comfy-runtime";
import { ServerLogStore } from "./server-log";

const temporaryDirectories: string[] = [];
const workerRuntime = {
	cudaVersion: "12.8",
	pythonVersion: "3.12.13",
	torchVersion: "2.11.0+cu128",
	torchvisionVersion: "0.26.0+cu128",
	torchaudioVersion: "2.11.0+cu128",
	uvVersion: "0.12.4",
};
const cpuWorkerRuntime = {
	...workerRuntime,
	computeBackend: "cpu" as const,
	cudaVersion: null,
};

afterEach(async () => {
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
}

class StubbornProcess extends FakeProcess {
	readonly signals: NodeJS.Signals[] = [];

	override kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.signals.push(signal);
		return true;
	}
}

test("starts the prepared backend on loopback with the fixed GPU runtime", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	let command = "";
	let args: string[] = [];
	let environment: NodeJS.ProcessEnv = {};
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "/opt/kastard/runtime/bin/python",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch,
		startProcess: (nextCommand, nextArgs, options) => {
			command = nextCommand;
			args = nextArgs;
			environment = options.env;
			return child as unknown as ChildProcess;
		},
		retryMs: 1,
		sourceEnvironment: {
			PATH: "/usr/bin",
			CUDA_VISIBLE_DEVICES: "0",
			UV_CONSTRAINT: "/opt/kastard/runtime-constraints.txt",
			RUNPOD_API_KEY: "must-not-reach-comfyui",
		},
	});

	expect(runtime.start()).toEqual({ status: "starting" });
	expect(runtime.start()).toEqual({ status: "starting" });
	await waitForState(runtime, "ready");

	expect(command).toBe("/opt/kastard/runtime/bin/python");
	expect(args).toEqual([
		join(rootDirectory, "backend", "main.py"),
		"--listen",
		"127.0.0.1",
		"--port",
		"18188",
		"--base-directory",
		rootDirectory,
		"--user-directory",
		join(rootDirectory, "user"),
		"--disable-auto-launch",
	]);
	expect(args).not.toContain("--cpu");
	expect(environment).toEqual({
		PATH: "/usr/bin",
		CUDA_VISIBLE_DEVICES: "0",
		UV_CONSTRAINT: "/opt/kastard/runtime-constraints.txt",
		HOME: join(rootDirectory, "user"),
		XDG_CACHE_HOME: join(rootDirectory, "user", ".cache"),
		PYTHONPYCACHEPREFIX: join(rootDirectory, "user", ".cache", "python-bytecode"),
	});
	expect(environment).not.toHaveProperty("RUNPOD_API_KEY");
	expect(runtime.start()).toEqual({ status: "ready" });

	await runtime.stop();
	expect(child.signalCode).toBe("SIGTERM");
	expect(runtime.getState()).toEqual({ status: "stopped" });
});

test("starts a CPU Worker runtime with ComfyUI CPU mode", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	let args: string[] = [];
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "/opt/kastard/runtime/bin/python",
		backend: backend({ status: "ready", version: "0.33.1", runtime: cpuWorkerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch,
		startProcess: (_command, nextArgs) => {
			args = nextArgs;
			return child as unknown as ChildProcess;
		},
		retryMs: 1,
	});

	expect(runtime.start()).toEqual({ status: "starting" });
	await waitForState(runtime, "ready");
	expect(args).toContain("--cpu");

	await runtime.stop();
});

test("forwards memory cleanup flags to the ready ComfyUI runtime", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	const cleanupRequests: Array<{ url: string; body: string }> = [];
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.endsWith("/free")) {
				cleanupRequests.push({ url, body: String(init?.body) });
			}
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	await runtime.freeMemory({ unload_models: true });
	await runtime.freeMemory({ unload_models: true, free_memory: true });

	expect(cleanupRequests).toEqual([
		{
			url: "http://127.0.0.1:18188/free",
			body: JSON.stringify({ unload_models: true }),
		},
		{
			url: "http://127.0.0.1:18188/free",
			body: JSON.stringify({ unload_models: true, free_memory: true }),
		},
	]);
	await runtime.stop();
});

test("reports memory cleanup failures without changing runtime state", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	let cleanupFailure: "http" | "network" = "http";
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async (input: string | URL | Request) => {
			if (!input.toString().endsWith("/free")) {
				return new Response(null, { status: 200 });
			}
			if (cleanupFailure === "network") throw new Error("connection lost");
			return new Response(null, { status: 500 });
		}) as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	await expect(runtime.freeMemory({ unload_models: true })).rejects.toThrow(
		"Worker ComfyUI is not ready.",
	);
	runtime.start();
	await waitForState(runtime, "ready");
	await expect(runtime.freeMemory({ unload_models: true })).rejects.toThrow(
		"Worker ComfyUI memory cleanup returned HTTP 500.",
	);
	cleanupFailure = "network";
	await expect(runtime.freeMemory({ unload_models: true })).rejects.toThrow(
		"Could not reach Worker ComfyUI for memory cleanup.",
	);
	expect(runtime.getState()).toEqual({ status: "ready" });
	await runtime.stop();
});

test("requires a prepared backend before starting", async () => {
	const rootDirectory = await fixture();
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "not-installed", runtime: workerRuntime }),
		logs: new ServerLogStore(),
	});

	expect(() => runtime.start()).toThrow(ComfyRuntimeStartError);
	expect(runtime.getState()).toEqual({ status: "stopped" });
});

test("restarts ComfyUI after the active process stops", async () => {
	const rootDirectory = await fixture();
	const processes = [new FakeProcess(), new FakeProcess()];
	let starts = 0;
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188 + starts,
		requestFetch: (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch,
		startProcess: () => processes[starts++] as unknown as ChildProcess,
		retryMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	expect(await runtime.restart()).toEqual({ status: "starting" });
	expect(processes[0]?.signalCode).toBe("SIGTERM");
	await waitForState(runtime, "ready");
	expect(starts).toBe(2);
	await runtime.stop();
});

test("keeps the active ComfyUI running when its backend is not ready", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	let backendState: ReturnType<BackendProvisionerApi["getState"]> = {
		status: "ready",
		version: "0.33.1",
		runtime: workerRuntime,
	};
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: {
			getState: () => backendState,
			prepare: () => backendState,
		},
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	backendState = {
		status: "failed",
		targetVersion: "0.34.0",
		error: "Backend download failed.",
		retryable: true,
		runtime: workerRuntime,
	};

	await expect(runtime.restart()).rejects.toThrow(
		"Prepare the Worker ComfyUI backend before starting it.",
	);
	expect(child.signalCode).toBeNull();
	expect(runtime.getState()).toEqual({ status: "ready" });
	await runtime.stop();
});

test("reports a stubborn process as active after restart cannot stop it", async () => {
	const rootDirectory = await fixture();
	const child = new StubbornProcess();
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		terminationTimeoutMs: 2,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	await expect(runtime.restart()).rejects.toThrow(
		"The previous Worker ComfyUI process is still stopping.",
	);
	expect(runtime.getState()).toEqual({ status: "stopped" });
	expect(runtime.isActive()).toBe(true);
	expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("refuses to restart while a workflow is active", async () => {
	const rootDirectory = await fixture();
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		isBusy: () => true,
	});

	await expect(runtime.restart()).rejects.toThrow(
		"Worker ComfyUI cannot restart while a workflow is running.",
	);
	expect(runtime.getState()).toEqual({ status: "stopped" });
});

test("records normalized ComfyUI stdout and stderr while the process is running", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	const logs = new ServerLogStore();
	const cursor = logs.getCursor();
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs,
		allocatePort: async () => 18_188,
		requestFetch: (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	child.stdout.write("Prompt ex");
	child.stdout.write("ecuted\r");
	child.stderr.write("\u001b[33mNode warning\u001b[0m\u0001\n");
	await waitFor(() =>
		logs
			.readAfter(cursor)
			.logs.some(({ message }) => message === "[stderr] Node warning"),
	);

	expect(
		logs
			.readAfter(cursor)
			.logs.map(({ message }) => message)
			.filter((message) => message.startsWith("[")),
	).toEqual(["[stdout] Prompt executed", "[stderr] Node warning"]);

	child.stdout.write("Final output");
	await runtime.stop();
	child.stdout.write("Ignored after stop\n");

	expect(
		logs
			.readAfter(cursor)
			.logs.map(({ message }) => message)
			.filter((message) => message.startsWith("[stdout]")),
	).toEqual(["[stdout] Prompt executed", "[stdout] Final output"]);
});

test("reports startup output when ComfyUI exits before becoming ready", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	const logs = new ServerLogStore();
	const cursor = logs.getCursor();
	let started = false;
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs,
		allocatePort: async () => 18_188,
		requestFetch: (async () => {
			throw new Error("not ready");
		}) as unknown as typeof fetch,
		startProcess: () => {
			started = true;
			return child as unknown as ChildProcess;
		},
		retryMs: 1,
	});

	runtime.start();
	await waitFor(() => started);
	child.stderr.write("CUDA initialization failed.\n");
	child.exit(1);
	await waitForState(runtime, "failed");

	expect(runtime.getState()).toEqual({
		status: "failed",
		error: "ComfyUI exited with code 1.",
	});
	expect(logs.readAfter(cursor).logs.map(({ message }) => message)).toEqual([
		"Starting Worker ComfyUI.",
		"[stderr] CUDA initialization failed.",
		"Worker ComfyUI failed: ComfyUI exited with code 1.",
	]);
});

test("keeps split custom node import failures as warnings when readiness responds", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async () => {
			child.stderr.write("0.1 seconds (IMPORT");
			child.stderr.write(
				` FAILED): /worker/custom_nodes/broken-node\n${"x".repeat(5_000)}`,
			);
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");

	expect(runtime.getState()).toEqual({
		status: "ready",
		warnings: [
			"ComfyUI could not initialize every custom node. 0.1 seconds (IMPORT FAILED): /worker/custom_nodes/broken-node",
		],
	});
	expect(child.signalCode).toBeNull();
});

test("adds unique sanitized custom node warnings after ComfyUI is ready", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	const logs = new ServerLogStore();
	const cursor = logs.getCursor();
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs,
		allocatePort: async () => 18_188,
		requestFetch: (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	child.stdout.write(
		"\u001b[32m[INFO]\u001b[0m 0.2 seconds (PRESTARTUP FAILED): broken-node\n",
	);
	child.stdout.write(
		"\u001b[32m[INFO]\u001b[0m 0.2 seconds (PRESTARTUP FAILED): broken-node\n",
	);
	child.stderr.write("0.3 seconds (IMPORT FAILED): another-node\n");
	await waitFor(() => {
		const state = runtime.getState();
		return state.status === "ready" && state.warnings?.length === 2;
	});

	expect(runtime.getState()).toEqual({
		status: "ready",
		warnings: [
			"ComfyUI could not initialize every custom node. [INFO] 0.2 seconds (PRESTARTUP FAILED): broken-node",
			"ComfyUI could not initialize every custom node. 0.3 seconds (IMPORT FAILED): another-node",
		],
	});
	expect(
		logs
			.readAfter(cursor)
			.logs.filter(({ level }) => level === "warning")
			.map(({ message }) => message),
	).toEqual([
		"ComfyUI could not initialize every custom node. [INFO] 0.2 seconds (PRESTARTUP FAILED): broken-node",
		"ComfyUI could not initialize every custom node. 0.3 seconds (IMPORT FAILED): another-node",
	]);
	expect(child.signalCode).toBeNull();
});

test("does not become ready when the process errors as the probe succeeds", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async () => {
			child.emit("error", new Error("Process handle failed."));
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "failed");

	expect(runtime.getState()).toEqual({
		status: "failed",
		error: "ComfyUI process failed. Process handle failed.",
	});
});

test("does not restart until a failed process has exited", async () => {
	const rootDirectory = await fixture();
	const child = new StubbornProcess();
	let starts = 0;
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async () => {
			throw new Error("not ready");
		}) as unknown as typeof fetch,
		startProcess: () => {
			starts += 1;
			return child as unknown as ChildProcess;
		},
		startupTimeoutMs: 2,
		retryMs: 1,
		terminationTimeoutMs: 2,
	});

	expect(runtime.start()).toEqual({ status: "starting" });
	await waitForState(runtime, "failed");
	expect(runtime.isActive()).toBe(true);
	expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(() => runtime.start()).toThrow(
		"The previous Worker ComfyUI process is still stopping.",
	);
	expect(starts).toBe(1);
});

test("returns to stopped when a ready ComfyUI exits cleanly", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	child.exit(0);

	expect(runtime.getState()).toEqual({ status: "stopped" });
});

test("keeps immediate late output intact and stops after the close grace", async () => {
	const rootDirectory = await fixture();
	const child = new FakeProcess();
	const logs = new ServerLogStore();
	const cursor = logs.getCursor();
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs,
		allocatePort: async () => 18_188,
		requestFetch: (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		processOutputCloseGraceMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	child.stdout.write("Before ");
	child.exit(1);
	child.stdout.write("and after exit");
	await new Promise((resolve) => setTimeout(resolve, 5));
	child.stdout.write("Ignored after grace\n");

	expect(logs.readAfter(cursor).logs.map(({ message }) => message)).toEqual([
		"Starting Worker ComfyUI.",
		"Worker ComfyUI is ready.",
		"Worker ComfyUI failed: ComfyUI exited with code 1.",
		"[stdout] Before and after exit",
	]);
});

test("keeps terminating an unresponsive ComfyUI process until it exits", async () => {
	const rootDirectory = await fixture();
	const child = new StubbornProcess();
	let probes = 0;
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_188,
		requestFetch: (async () => {
			probes += 1;
			if (probes === 1) return new Response(null, { status: 200 });
			throw new Error("not responding");
		}) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		healthCheckMs: 1,
		terminationTimeoutMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	await waitForState(runtime, "failed");

	expect(runtime.getState()).toEqual({
		status: "failed",
		error: "ComfyUI stopped responding after 3 consecutive health checks.",
	});
	expect(probes).toBe(4);
	await waitFor(() => child.signals.length === 2);
	expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("keeps ComfyUI ready when health probes complete within the configured timeout", async () => {
	const rootDirectory = await fixture();
	const child = new StubbornProcess();
	let probes = 0;
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_190,
		requestFetch: (async (_url: unknown, init: RequestInit) => {
			probes += 1;
			if (probes === 1) return new Response(null, { status: 200 });
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					resolve();
				}, 40);
				init.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("aborted"));
				});
			});
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		healthCheckMs: 1,
		probeTimeoutMs: 200,
		terminationTimeoutMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	await waitFor(() => probes >= 5);
	expect(runtime.getState().status).toBe("ready");
	expect(child.signals).toEqual([]);
	await runtime.stop();
});

test("keeps ComfyUI ready when a slow health probe completes within the default timeout", async () => {
	const rootDirectory = await fixture();
	const child = new StubbornProcess();
	let probes = 0;
	let slowProbeSucceeded = false;
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs: new ServerLogStore(),
		allocatePort: async () => 18_191,
		requestFetch: (async (_url: unknown, init: RequestInit) => {
			probes += 1;
			if (probes === 1) return new Response(null, { status: 200 });
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					resolve();
				}, 2_500);
				init.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("aborted"));
				});
			});
			slowProbeSucceeded = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		healthCheckMs: 1,
		// probeTimeoutMs is deliberately omitted so this pins PROBE_TIMEOUT_MS.
		terminationTimeoutMs: 1,
	});

	runtime.start();
	await waitForState(runtime, "ready");
	await waitFor(() => slowProbeSucceeded, 5_000);
	expect(runtime.getState().status).toBe("ready");
	await runtime.stop();
});

test("tolerates an unresponsive ComfyUI while a workflow is running", async () => {
	const rootDirectory = await fixture();
	const child = new StubbornProcess();
	const logs = new ServerLogStore();
	const cursor = logs.getCursor();
	let probes = 0;
	let busy = false;
	const runtime = new ComfyRuntime({
		rootDirectory,
		runtimePython: "python3",
		backend: backend({ status: "ready", version: "0.33.1", runtime: workerRuntime }),
		logs,
		allocatePort: async () => 18_189,
		requestFetch: (async () => {
			probes += 1;
			// The first failure lands while idle; the workflow starts before the second.
			if (probes >= 3) busy = true;
			if (probes === 1) return new Response(null, { status: 200 });
			throw new Error("not responding");
		}) as unknown as typeof fetch,
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		healthCheckMs: 1,
		terminationTimeoutMs: 1,
		isBusy: () => busy,
	});

	runtime.start();
	await waitForState(runtime, "ready");

	// The idle threshold is 3 consecutive failures; a running workflow must survive it.
	await waitFor(() => probes >= 8);
	expect(runtime.getState().status).toBe("ready");
	expect(
		logs
			.readAfter(cursor)
			.logs.some(
				(entry) =>
					entry.level === "warning" && entry.message.includes("while a workflow"),
			),
	).toBe(true);

	busy = false;
	await waitForState(runtime, "failed");
	await waitFor(() => child.signals.length === 2);
	expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

async function fixture(): Promise<string> {
	const rootDirectory = await mkdtemp(join(tmpdir(), "kastard-worker-comfy-test-"));
	temporaryDirectories.push(rootDirectory);
	await Promise.all([
		mkdir(join(rootDirectory, "backend"), { recursive: true }),
		mkdir(join(rootDirectory, "user"), { recursive: true }),
	]);
	await writeFile(join(rootDirectory, "backend", "main.py"), "");
	return rootDirectory;
}

function backend(
	state: ReturnType<BackendProvisionerApi["getState"]>,
): BackendProvisionerApi {
	return {
		getState: () => state,
		prepare: () => state,
	};
}

async function waitForState(
	runtime: ComfyRuntime,
	status: ReturnType<ComfyRuntime["getState"]>["status"],
): Promise<void> {
	await waitFor(() => runtime.getState().status === status);
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
