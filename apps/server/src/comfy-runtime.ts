import { type ChildProcess, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type {
	WorkerComfyMemoryCleanupRequest,
	WorkerComfyServerState,
} from "@kastard/common";
import type { BackendProvisionerApi } from "./backend-provisioner";
import { ProcessOutputLineBuffer, type ProcessOutputStream } from "./process-output";
import type { ServerLogStore } from "./server-log";
import { workerChildEnvironment } from "./worker-child-environment";

const HEALTH_FAILURE_THRESHOLD = 3;
const BUSY_HEALTH_FAILURE_THRESHOLD = 12;
const PROBE_TIMEOUT_MS = 10_000;
const PROCESS_OUTPUT_CLOSE_GRACE_MS = 1_000;

export type ComfyRuntimeState = WorkerComfyServerState;

export interface ComfyRuntimeApi {
	getState(): ComfyRuntimeState;
	isActive(): boolean;
	start(): ComfyRuntimeState;
	restart(): Promise<ComfyRuntimeState>;
	freeMemory(request: WorkerComfyMemoryCleanupRequest): Promise<void>;
}

type StartProcess = (
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

type ProcessOutputCapture = {
	finish: () => void;
	stop: () => void;
};

type ComfyRuntimeOptions = {
	rootDirectory: string;
	runtimePython: string;
	backend: BackendProvisionerApi;
	logs: ServerLogStore;
	startProcess?: StartProcess;
	requestFetch?: typeof fetch;
	allocatePort?: () => Promise<number>;
	startupTimeoutMs?: number;
	retryMs?: number;
	healthCheckMs?: number;
	probeTimeoutMs?: number;
	terminationTimeoutMs?: number;
	processOutputCloseGraceMs?: number;
	isBusy?: () => boolean;
	sourceEnvironment?: NodeJS.ProcessEnv;
};

export class ComfyRuntimeStartError extends Error {
	constructor(
		message: string,
		readonly statusCode: 409,
	) {
		super(message);
	}
}

export class ComfyRuntimeUnavailableError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

export class ComfyRuntimeController implements ComfyRuntimeApi {
	private runtime: ComfyRuntimeApi | null = null;
	private error = "ComfyUI execution is initializing.";
	private retryable = true;

	attach(runtime: ComfyRuntimeApi): void {
		this.runtime = runtime;
	}

	fail(error: string): void {
		this.error = error;
		this.retryable = false;
		this.runtime = null;
	}

	getState(): ComfyRuntimeState {
		return this.current().getState();
	}

	isActive(): boolean {
		return this.current().isActive();
	}

	start(): ComfyRuntimeState {
		return this.current().start();
	}

	restart(): Promise<ComfyRuntimeState> {
		return this.current().restart();
	}

	freeMemory(request: WorkerComfyMemoryCleanupRequest): Promise<void> {
		return this.current().freeMemory(request);
	}

	private current(): ComfyRuntimeApi {
		if (this.runtime === null) {
			throw new ComfyRuntimeUnavailableError(this.error, this.retryable);
		}
		return this.runtime;
	}
}

export class ComfyRuntime implements ComfyRuntimeApi {
	private state: ComfyRuntimeState = { status: "stopped" };
	private readonly startProcess: StartProcess;
	private readonly requestFetch: typeof fetch;
	private readonly allocatePort: () => Promise<number>;
	private readonly startupTimeoutMs: number;
	private readonly retryMs: number;
	private readonly healthCheckMs: number;
	private readonly probeTimeoutMs: number;
	private readonly terminationTimeoutMs: number;
	private readonly processOutputCloseGraceMs: number;
	private process: ChildProcess | null = null;
	private runtimeUrl: string | null = null;
	private operation = 0;
	private readonly startupWarnings = new Set<string>();
	private stopProcessOutput: (() => void) | null = null;

	constructor(private readonly options: ComfyRuntimeOptions) {
		this.startProcess = options.startProcess ?? startComfyProcess;
		this.requestFetch = options.requestFetch ?? fetch;
		this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
		this.startupTimeoutMs = options.startupTimeoutMs ?? 180_000;
		this.retryMs = options.retryMs ?? 250;
		this.healthCheckMs = options.healthCheckMs ?? 5_000;
		this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
		this.terminationTimeoutMs = options.terminationTimeoutMs ?? 5_000;
		this.processOutputCloseGraceMs =
			options.processOutputCloseGraceMs ?? PROCESS_OUTPUT_CLOSE_GRACE_MS;
	}

	getState(): ComfyRuntimeState {
		return this.state;
	}

	isActive(): boolean {
		return (
			this.state.status === "starting" ||
			this.state.status === "ready" ||
			(this.process !== null && processAlive(this.process))
		);
	}

	getInternalUrl(): string | null {
		return this.state.status === "ready" ? this.runtimeUrl : null;
	}

	getGeneration(): number {
		return this.operation;
	}

	start(): ComfyRuntimeState {
		if (this.state.status === "starting" || this.state.status === "ready") {
			return this.state;
		}
		if (this.process !== null) {
			if (processAlive(this.process)) {
				throw new ComfyRuntimeStartError(
					"The previous Worker ComfyUI process is still stopping.",
					409,
				);
			}
			this.process = null;
		}
		this.requireReadyBackend();

		this.stopProcessOutput?.();
		const operation = ++this.operation;
		this.startupWarnings.clear();
		this.state = { status: "starting" };
		this.options.logs.write("info", "Starting Worker ComfyUI.");
		void this.startOnce(operation);
		return this.state;
	}

	async restart(): Promise<ComfyRuntimeState> {
		if (this.options.isBusy?.()) {
			throw new ComfyRuntimeStartError(
				"Worker ComfyUI cannot restart while a workflow is running.",
				409,
			);
		}
		this.requireReadyBackend();
		this.options.logs.write("info", "Restarting Worker ComfyUI.");
		await this.stop();
		return this.start();
	}

	async freeMemory(request: WorkerComfyMemoryCleanupRequest): Promise<void> {
		const runtimeUrl = this.getInternalUrl();
		if (runtimeUrl === null) {
			throw new ComfyRuntimeUnavailableError("Worker ComfyUI is not ready.", true);
		}
		let response: Response;
		try {
			response = await this.requestFetch(new URL("free", runtimeUrl), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(this.probeTimeoutMs),
			});
		} catch {
			throw new ComfyRuntimeUnavailableError(
				"Could not reach Worker ComfyUI for memory cleanup.",
				true,
			);
		}
		if (response.status !== 200) {
			throw new ComfyRuntimeUnavailableError(
				`Worker ComfyUI memory cleanup returned HTTP ${response.status}.`,
				true,
			);
		}
	}

	private requireReadyBackend(): void {
		if (this.options.backend.getState().status !== "ready") {
			throw new ComfyRuntimeStartError(
				"Prepare the Worker ComfyUI backend before starting it.",
				409,
			);
		}
	}

	async stop(): Promise<void> {
		this.stopProcessOutput?.();
		this.operation += 1;
		const activeProcess = this.process;
		this.runtimeUrl = null;
		this.state = { status: "stopped" };
		if (activeProcess === null) return;
		await terminateProcess(activeProcess, this.terminationTimeoutMs);
		if (this.process === activeProcess && !processAlive(activeProcess)) {
			this.process = null;
		}
	}

	private async startOnce(operation: number): Promise<void> {
		let child: ChildProcess | null = null;
		try {
			const backendDirectory = join(this.options.rootDirectory, "backend");
			const mainPath = join(backendDirectory, "main.py");
			await access(mainPath);
			const port = await this.allocatePort();
			if (operation !== this.operation) return;
			const url = `http://127.0.0.1:${port}/`;
			const cpu = this.options.backend.getState().runtime.computeBackend === "cpu";
			const startedProcess = this.startProcess(
				this.options.runtimePython,
				[
					mainPath,
					"--listen",
					"127.0.0.1",
					"--port",
					String(port),
					...(cpu ? ["--cpu"] : []),
					"--base-directory",
					this.options.rootDirectory,
					"--user-directory",
					join(this.options.rootDirectory, "user"),
					"--disable-auto-launch",
				],
				{
					cwd: backendDirectory,
					env: workerChildEnvironment(this.options.sourceEnvironment ?? process.env, {
						HOME: join(this.options.rootDirectory, "user"),
						XDG_CACHE_HOME: join(this.options.rootDirectory, "user", ".cache"),
						PYTHONPYCACHEPREFIX: join(
							this.options.rootDirectory,
							"user",
							".cache",
							"python-bytecode",
						),
					}),
				},
			);
			child = startedProcess;
			this.process = startedProcess;
			let childError: Error | null = null;
			const processOutput = this.captureProcessOutput(startedProcess, operation);
			this.stopProcessOutput = processOutput.stop;
			startedProcess.once("error", (error) => {
				childError = error;
				if (
					this.process === startedProcess &&
					operation === this.operation &&
					this.state.status === "ready"
				) {
					this.fail(processErrorMessage(error));
					void this.terminateFailedProcess(startedProcess, operation);
				}
			});
			startedProcess.once("exit", (code, signal) => {
				if (this.process !== startedProcess || operation !== this.operation) return;
				processOutput.finish();
				this.process = null;
				this.runtimeUrl = null;
				if (this.state.status !== "ready") return;
				if (code === 0) {
					this.state = { status: "stopped" };
					this.options.logs.write("info", "Worker ComfyUI stopped.");
				} else {
					this.fail(exitMessage(code, signal));
				}
			});
			startedProcess.once("close", processOutput.stop);
			await this.waitUntilReady(startedProcess, url, () => childError);
			if (childError !== null) throw new Error(processErrorMessage(childError));
			if (startedProcess.exitCode !== null || startedProcess.signalCode !== null) {
				throw new Error(
					exitMessage(startedProcess.exitCode, startedProcess.signalCode),
				);
			}
			if (operation !== this.operation || this.process !== startedProcess) return;
			this.runtimeUrl = url;
			this.state = this.readyState();
			this.options.logs.write("info", "Worker ComfyUI is ready.");
			void this.monitorHealth(startedProcess, url, operation);
		} catch (error) {
			if (operation !== this.operation) return;
			if (child !== null) {
				await terminateProcess(child, this.terminationTimeoutMs);
			}
			if (operation !== this.operation) return;
			if (this.process === child && child !== null && !processAlive(child)) {
				this.process = null;
			}
			const message = errorMessage(error);
			this.fail(message);
		}
	}

	private async terminateFailedProcess(
		child: ChildProcess,
		operation: number,
	): Promise<void> {
		await terminateProcess(child, this.terminationTimeoutMs);
		if (
			this.process === child &&
			operation === this.operation &&
			!processAlive(child)
		) {
			this.process = null;
		}
	}

	private captureProcessOutput(
		child: ChildProcess,
		operation: number,
	): ProcessOutputCapture {
		let active = true;
		let closeTimer: ReturnType<typeof setTimeout> | null = null;
		const recordLine = (stream: ProcessOutputStream, line: string): void => {
			this.options.logs.write("info", `[${stream}] ${line}`);
			const warning = startupWarningMessage(line);
			if (warning === null || this.startupWarnings.has(warning)) return;
			this.startupWarnings.add(warning);
			this.options.logs.write("warning", warning);
			if (this.state.status === "ready") this.state = this.readyState();
		};
		const buffers = {
			stdout: new ProcessOutputLineBuffer((line) => recordLine("stdout", line)),
			stderr: new ProcessOutputLineBuffer((line) => recordLine("stderr", line)),
		};
		const record = (stream: ProcessOutputStream, chunk: Buffer | string): void => {
			if (!active || operation !== this.operation) return;
			buffers[stream].write(chunk.toString());
		};
		const stop = (): void => {
			if (!active) return;
			if (closeTimer !== null) clearTimeout(closeTimer);
			if (operation === this.operation) {
				buffers.stdout.flush();
				buffers.stderr.flush();
			}
			active = false;
			if (this.stopProcessOutput === stop) this.stopProcessOutput = null;
		};
		const finish = (): void => {
			if (!active || closeTimer !== null) return;
			closeTimer = setTimeout(stop, this.processOutputCloseGraceMs);
			closeTimer.unref();
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: Buffer | string) => {
			record("stdout", chunk);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			record("stderr", chunk);
		});
		return { finish, stop };
	}

	private async waitUntilReady(
		child: ChildProcess,
		url: string,
		getChildError: () => Error | null,
	): Promise<void> {
		const deadline = Date.now() + this.startupTimeoutMs;
		while (Date.now() < deadline) {
			const childError = getChildError();
			if (childError !== null) throw new Error(processErrorMessage(childError));
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(exitMessage(child.exitCode, child.signalCode));
			}
			const ready = await this.probe(url, Math.min(2_000, this.retryMs * 4));
			if (ready) return;
			await delay(this.retryMs);
		}
		throw new Error(`ComfyUI did not start within ${this.startupTimeoutMs}ms.`);
	}

	private readyState(): ComfyRuntimeState {
		return this.startupWarnings.size === 0
			? { status: "ready" }
			: { status: "ready", warnings: [...this.startupWarnings] };
	}

	private async monitorHealth(
		child: ChildProcess,
		url: string,
		operation: number,
	): Promise<void> {
		let failures = 0;
		let warnedBusy = false;
		while (this.isReadyProcess(child, operation)) {
			await delay(this.healthCheckMs);
			if (!this.isReadyProcess(child, operation)) return;
			if (await this.probe(url, this.probeTimeoutMs)) {
				failures = 0;
				warnedBusy = false;
				continue;
			}
			if (!this.isReadyProcess(child, operation)) return;
			failures += 1;
			const busy = this.options.isBusy?.() ?? false;
			if (busy && !warnedBusy) {
				warnedBusy = true;
				this.options.logs.write(
					"warning",
					"ComfyUI is not answering health checks while a workflow is running.",
				);
			}
			const threshold = busy ? BUSY_HEALTH_FAILURE_THRESHOLD : HEALTH_FAILURE_THRESHOLD;
			if (failures < threshold) continue;
			this.fail(
				`ComfyUI stopped responding after ${failures} consecutive health checks.`,
			);
			await this.terminateFailedProcess(child, operation);
			return;
		}
	}

	private isReadyProcess(child: ChildProcess, operation: number): boolean {
		return (
			operation === this.operation &&
			this.process === child &&
			this.state.status === "ready" &&
			processAlive(child)
		);
	}

	private async probe(url: string, timeoutMs: number): Promise<boolean> {
		try {
			const response = await this.requestFetch(new URL("system_stats", url), {
				signal: AbortSignal.timeout(timeoutMs),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	private fail(error: string): void {
		this.runtimeUrl = null;
		this.state = { status: "failed", error };
		this.options.logs.write("error", `Worker ComfyUI failed: ${error}`);
	}
}

function startComfyProcess(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess {
	return spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function allocateLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a ComfyUI port."));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

function exitMessage(code: number | null, signal: NodeJS.Signals | null): string {
	const reason = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
	return `ComfyUI exited with ${reason}.`;
}

function processErrorMessage(error: Error): string {
	return `ComfyUI process failed. ${error.message}`;
}

function startupWarningMessage(line: string): string | null {
	const detail = line.trim();
	return detail.includes("(IMPORT FAILED):") || detail.includes("(PRESTARTUP FAILED):")
		? `ComfyUI could not initialize every custom node. ${detail}`
		: null;
}

async function terminateProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (!processAlive(child)) return;
	const gracefulExit = waitForProcessExit(child, timeoutMs);
	child.kill("SIGTERM");
	if (await gracefulExit) return;
	const forcedExit = waitForProcessExit(child, timeoutMs);
	child.kill("SIGKILL");
	await forcedExit;
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (!processAlive(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (exited: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.removeListener("exit", onExit);
			resolve(exited);
		};
		const onExit = (): void => finish(true);
		const timeout = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
		if (!processAlive(child)) finish(true);
	});
}

function processAlive(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
