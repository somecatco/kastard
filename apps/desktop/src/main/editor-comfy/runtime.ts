import { type ChildProcess, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { isCustomNodeManagerVersion } from "@kastard/common";
import type { ComfyRuntimeState, ModelLibraryEntry } from "../../shared/api";
import type { EditorModelPaths } from "./model-paths";
import {
	type CommandOptions,
	environmentPython,
	exitMessage,
	type RunCommand,
	runCommand,
	type StartProcess,
} from "./process";

type RuntimeManifest = {
	version: string;
	sha256: string;
	pythonVersion: string;
	managerVersion: string;
	dependencyLock: { sha256: string };
	platform: string;
	uv: { version: string };
};

/** The ComfyUI source the runtime starts, either the bundled one or a user-selected release. */
export type BackendSource = {
	directory: string;
	version: string;
	sha256: string;
	/** Hash-pinned lock shipped with the bundled backend; absent for selected releases. */
	dependencyLock: { path: string; sha256: string } | null;
};

type RuntimeOptions = {
	modelPaths: EditorModelPaths;
	resourcesDirectory: string;
	frontendDirectory: string;
	dataDirectory: string;
	platform?: NodeJS.Platform;
	arch?: string;
	runCommand?: RunCommand;
	startProcess?: StartProcess;
	fetch?: typeof fetch;
	allocatePort?: () => Promise<number>;
	startupTimeoutMs?: number;
	retryMs?: number;
	terminationTimeoutMs?: number;
	getModels?: () => readonly ModelLibraryEntry[];
	/** Resolves the selected ComfyUI release, installing it when needed, or `null` for the bundled one. */
	resolveBackend?: (
		signal: AbortSignal,
	) => Promise<Omit<BackendSource, "dependencyLock"> | null>;
	resolveFrontend?: (signal: AbortSignal) => Promise<string | null>;
	/** Resolves a user-selected Manager override for the active backend. */
	resolveManagerVersion?: (backendDirectory: string) => Promise<string> | string;
	restoreResults?: (signal: AbortSignal) => Promise<void>;
};

const STAMP_NAME = ".kastard-runtime.json";
const LOG_TAIL_LENGTH = 12_000;
const FRONTEND_SETTINGS_TIMEOUT_MS = 5_000;
const NAMED_VALUES_SETTING = "Comfy.Workflow.NamedValuesRestore";

export class ComfyRuntime {
	private state: ComfyRuntimeState = { status: "idle" };
	private readonly listeners = new Set<(state: ComfyRuntimeState) => void>();
	private readonly platform: NodeJS.Platform;
	private readonly arch: string;
	private readonly runCommand: RunCommand;
	private readonly startProcess: StartProcess;
	private readonly requestFetch: typeof fetch;
	private readonly allocatePort: () => Promise<number>;
	private readonly startupTimeoutMs: number;
	private readonly retryMs: number;
	private readonly terminationTimeoutMs: number;
	private startPromise: Promise<string> | null = null;
	private prepareController: AbortController | null = null;
	private process: ChildProcess | null = null;
	private stopping = false;
	private logTail = "";
	private customNodeStartupFailureDetected = false;

	constructor(private readonly options: RuntimeOptions) {
		this.platform = options.platform ?? process.platform;
		this.arch = options.arch ?? process.arch;
		this.runCommand = options.runCommand ?? runCommand;
		this.startProcess = options.startProcess ?? startProcess;
		this.requestFetch = options.fetch ?? fetch;
		this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
		this.startupTimeoutMs = options.startupTimeoutMs ?? 180_000;
		this.retryMs = options.retryMs ?? 250;
		this.terminationTimeoutMs = options.terminationTimeoutMs ?? 10_000;
	}

	getState(): ComfyRuntimeState {
		return this.state;
	}

	getUrl(): string | null {
		return this.state.status === "ready" ? this.state.url : null;
	}

	subscribe(listener: (state: ComfyRuntimeState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async start(): Promise<string> {
		const currentUrl = this.getUrl();
		if (currentUrl !== null && this.process?.exitCode === null) return currentUrl;
		if (this.startPromise !== null) return this.startPromise;
		this.stopping = false;
		const controller = new AbortController();
		this.prepareController = controller;
		this.startPromise = this.startOnce(controller.signal).finally(() => {
			this.startPromise = null;
			if (this.prepareController === controller) this.prepareController = null;
		});
		return this.startPromise;
	}

	async stop(): Promise<void> {
		const starting = this.startPromise;
		this.stopping = true;
		this.prepareController?.abort();
		const activeProcess = this.process;
		this.process = null;
		if (
			activeProcess !== null &&
			activeProcess.exitCode === null &&
			activeProcess.signalCode === null
		) {
			activeProcess.kill("SIGTERM");
		}
		this.update({ status: "idle" });
		if (activeProcess !== null) {
			await processExit(activeProcess, this.terminationTimeoutMs);
		}
		await starting?.catch(() => undefined);
	}

	/** Restarts on the currently selected ComfyUI frontend and backend. */
	async restart(signal: AbortSignal): Promise<string> {
		await this.stop();
		signal.throwIfAborted();
		return this.start();
	}

	private async startOnce(signal: AbortSignal): Promise<string> {
		this.resetOutput();
		try {
			const manifest = await this.readManifest();
			const backend = await this.resolveBackendSource(manifest, signal);
			const frontendDirectory =
				(await this.options.resolveFrontend?.(signal)) ??
				this.options.frontendDirectory;
			signal.throwIfAborted();
			const { python } = await this.prepareEnvironment(manifest, backend, signal);
			signal.throwIfAborted();
			this.resetOutput();
			this.update({ status: "starting" });
			const port = await this.allocatePort();
			signal.throwIfAborted();
			const url = `http://127.0.0.1:${port}/`;
			await this.startBackend(python, backend, frontendDirectory, port, url, signal);
			signal.throwIfAborted();
			this.update({ status: "ready", url });
			return url;
		} catch (error) {
			const message = errorMessage(error);
			if (!this.stopping) {
				this.update({
					status: "error",
					message,
					...(this.customNodeStartupFailureDetected
						? { reason: "custom-node" as const }
						: {}),
				});
			}
			throw new Error(message, { cause: error });
		}
	}

	private async readManifest(): Promise<RuntimeManifest> {
		const raw = await readFile(
			join(this.options.resourcesDirectory, ".kastard-source.json"),
			"utf8",
		);
		const parsed: unknown = JSON.parse(raw);
		if (!isRuntimeManifest(parsed))
			throw new Error("Invalid ComfyUI runtime manifest.");
		const platform = `${this.platform}-${this.arch}`;
		if (parsed.platform !== platform) {
			throw new Error(`ComfyUI runtime is for ${parsed.platform}, not ${platform}.`);
		}
		return parsed;
	}

	private bundledBackendDirectory(): string {
		return join(this.options.resourcesDirectory, "backend");
	}

	private async resolveBackendSource(
		manifest: RuntimeManifest,
		signal: AbortSignal,
	): Promise<BackendSource> {
		const selected = (await this.options.resolveBackend?.(signal)) ?? null;
		if (selected !== null) return { ...selected, dependencyLock: null };
		const bundled = manifest;
		const directory = this.bundledBackendDirectory();
		return {
			directory,
			version: bundled.version,
			sha256: bundled.sha256,
			dependencyLock: {
				path: join(directory, "runtime-lock.txt"),
				sha256: bundled.dependencyLock.sha256,
			},
		};
	}

	private async prepareEnvironment(
		manifest: RuntimeManifest,
		backend: BackendSource,
		signal: AbortSignal,
	): Promise<{ python: string; firstRun: boolean }> {
		const root = this.options.dataDirectory;
		const environmentDirectory = join(root, "environment");
		const pythonDirectory = join(root, "python");
		const cacheDirectory = join(root, "cache");
		const python = environmentPython(environmentDirectory, this.platform);
		const stampPath = join(environmentDirectory, STAMP_NAME);
		const pinnedManagerVersion = await readManagerVersion(backend.directory);
		const managerVersion =
			(await this.options.resolveManagerVersion?.(backend.directory)) ??
			pinnedManagerVersion;
		if (!isCustomNodeManagerVersion(managerVersion)) {
			throw new Error("Kastard selected an invalid ComfyUI Manager version.");
		}
		const expectedStamp = {
			version: backend.version,
			sha256: backend.sha256,
			pythonVersion: manifest.pythonVersion,
			managerVersion,
			dependencyLockSha256: backend.dependencyLock?.sha256 ?? null,
			uvVersion: manifest.uv.version,
			platform: manifest.platform,
		};
		const installedStamp = await readStamp(stampPath);
		const firstRun = installedStamp?.version === undefined;
		if ((await pathExists(python)) && stampMatches(installedStamp, expectedStamp)) {
			return { python, firstRun: false };
		}

		const reuseEnvironment =
			(await pathExists(python)) &&
			installedStamp?.pythonVersion === manifest.pythonVersion;
		if (!reuseEnvironment) {
			await rm(environmentDirectory, { recursive: true, force: true });
		}
		await mkdir(root, { recursive: true });
		const commandEnvironment = runtimeEnvironment(
			pythonDirectory,
			cacheDirectory,
			this.platform,
		);
		const uv = join(
			this.options.resourcesDirectory,
			"bin",
			this.platform === "win32" ? "uv.exe" : "uv",
		);
		await access(uv);

		this.update({
			status: "preparing",
			phase: "python",
			progress: 5,
			firstRun,
		});
		if (!reuseEnvironment) {
			await this.runCommand(
				uv,
				[
					"venv",
					"--python",
					manifest.pythonVersion,
					"--managed-python",
					"--no-config",
					environmentDirectory,
				],
				{
					cwd: root,
					env: commandEnvironment,
					onOutput: (text) => this.recordOutput(text),
					signal,
					terminationTimeoutMs: this.terminationTimeoutMs,
				},
			);
		}

		this.update({
			status: "preparing",
			phase: "python",
			progress: 20,
			firstRun,
		});
		this.update({
			status: "preparing",
			phase: "dependencies",
			progress: 20,
			firstRun,
		});
		const reportDependencyProgress = dependencyProgressReporter((progress) => {
			this.update({
				status: "preparing",
				phase: "dependencies",
				progress,
				firstRun,
			});
		});
		// Preserve the Python version so a failed dependency mutation can reuse the venv,
		// while ensuring the incomplete environment never matches the expected stamp.
		await writeFile(
			stampPath,
			`${JSON.stringify({ pythonVersion: manifest.pythonVersion })}\n`,
		);
		await this.runCommand(
			uv,
			[
				"pip",
				"install",
				"--python",
				python,
				...(this.platform === "darwin" ? [] : ["--torch-backend", "cpu"]),
				"--no-config",
				...(backend.dependencyLock === null
					? [
							"--requirements",
							join(backend.directory, "requirements.txt"),
							...(managerVersion === pinnedManagerVersion
								? [
										"--requirements",
										join(backend.directory, "manager_requirements.txt"),
									]
								: []),
						]
					: ["--require-hashes", "--requirements", backend.dependencyLock.path]),
			],
			{
				cwd: root,
				env: commandEnvironment,
				onOutput: (text) => {
					this.recordOutput(text);
					reportDependencyProgress(text);
				},
				signal,
				terminationTimeoutMs: this.terminationTimeoutMs,
			},
		);
		if (managerVersion !== pinnedManagerVersion) {
			await this.runCommand(
				uv,
				[
					"pip",
					"install",
					"--python",
					python,
					...(this.platform === "darwin" ? [] : ["--torch-backend", "cpu"]),
					"--no-config",
					`comfyui_manager==${managerVersion}`,
				],
				{
					cwd: root,
					env: commandEnvironment,
					onOutput: (text) => {
						this.recordOutput(text);
						reportDependencyProgress(text);
					},
					signal,
					terminationTimeoutMs: this.terminationTimeoutMs,
				},
			);
		}
		if (!reuseEnvironment || installedStamp?.version === undefined) {
			const customRequirements = await customNodeRequirements(
				join(root, "data", "custom_nodes"),
			);
			if (customRequirements.length > 0) {
				await this.runCommand(
					uv,
					[
						"pip",
						"install",
						"--python",
						python,
						"--no-config",
						...customRequirements.flatMap((path) => ["--requirements", path]),
					],
					{
						cwd: root,
						env: commandEnvironment,
						onOutput: (text) => this.recordOutput(text),
						signal,
						terminationTimeoutMs: this.terminationTimeoutMs,
					},
				);
			}
		}
		this.update({
			status: "preparing",
			phase: "dependencies",
			progress: 90,
			firstRun,
		});
		await writeFile(
			stampPath,
			`${JSON.stringify(expectedStamp, null, "\t")}\n`,
			"utf8",
		);
		return { python, firstRun };
	}

	private async startBackend(
		python: string,
		backend: BackendSource,
		frontendDirectory: string,
		port: number,
		url: string,
		signal: AbortSignal,
	): Promise<void> {
		await this.options.modelPaths.syncModels(this.options.getModels?.() ?? []);
		signal.throwIfAborted();
		const dataDirectory = join(this.options.dataDirectory, "data");
		const userDirectory = join(dataDirectory, "user");
		const virtualModelsDirectory = join(this.options.dataDirectory, "virtual-models");
		const backendDirectory = backend.directory;
		const databasePath = join(userDirectory, "comfyui.db").replaceAll("\\", "/");
		let childError: Error | null = null;
		const child = await this.options.modelPaths.withStablePaths(async () => {
			await Promise.all([
				mkdir(userDirectory, { recursive: true }),
				mkdir(join(dataDirectory, "custom_nodes"), { recursive: true }),
				mkdir(join(dataDirectory, "models"), { recursive: true }),
				mkdir(virtualModelsDirectory, { recursive: true }),
			]);
			signal.throwIfAborted();
			const child = this.startProcess(
				python,
				[
					join(backendDirectory, "main.py"),
					"--listen",
					"127.0.0.1",
					"--port",
					String(port),
					"--cpu",
					"--front-end-root",
					frontendDirectory,
					"--base-directory",
					dataDirectory,
					"--models-directory",
					virtualModelsDirectory,
					"--user-directory",
					userDirectory,
					"--database-url",
					`sqlite:///${databasePath}`,
					"--extra-model-paths-config",
					join(this.options.dataDirectory, "editor-model-paths.json"),
					"--enable-manager",
					"--disable-auto-launch",
				],
				{
					cwd: backendDirectory,
					env: runtimeEnvironment(
						join(this.options.dataDirectory, "python"),
						join(this.options.dataDirectory, "cache"),
						this.platform,
					),
				},
			);
			this.process = child;
			this.captureProcessOutput(child);
			child.once("error", (error) => {
				childError = error;
				if (this.process !== child) return;
				this.process = null;
				if (!this.stopping && this.state.status === "ready") {
					this.update({ status: "error", message: processErrorMessage(error) });
				}
			});
			child.once("exit", (code, signal) => {
				if (this.process !== child) return;
				this.process = null;
				if (!this.stopping && this.state.status === "ready") {
					this.update({
						status: "error",
						message: exitMessage("ComfyUI", code, signal, this.logTail),
					});
				}
			});
			await this.waitUntilReady(child, url, () => childError);
			return child;
		});
		if (childError !== null) throw new Error(processErrorMessage(childError));
		this.assertBackendRunning(child);
		try {
			await this.enableNamedValuesRestore(url, signal);
			// ComfyUI clears its temp directory on every startup.
			await this.options.restoreResults?.(signal);
		} catch (error) {
			child.kill("SIGTERM");
			throw error;
		}
		this.assertBackendRunning(child);
	}

	private assertBackendRunning(child: ChildProcess): void {
		if (
			this.process === child &&
			child.exitCode === null &&
			child.signalCode === null
		) {
			return;
		}
		throw new Error(
			exitMessage("ComfyUI", child.exitCode, child.signalCode, this.logTail),
		);
	}

	private async enableNamedValuesRestore(
		url: string,
		signal: AbortSignal,
	): Promise<void> {
		let response: Response;
		try {
			response = await this.requestFetch(
				new URL(`api/settings/${NAMED_VALUES_SETTING}`, url),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "true",
					signal: AbortSignal.any([
						signal,
						AbortSignal.timeout(
							Math.min(FRONTEND_SETTINGS_TIMEOUT_MS, this.startupTimeoutMs),
						),
					]),
				},
			);
		} catch (error) {
			throw new Error(
				`ComfyUI frontend settings could not be applied. ${errorMessage(error)}`,
			);
		}
		if (!response.ok) {
			throw new Error(`ComfyUI frontend settings returned HTTP ${response.status}.`);
		}
	}

	private captureProcessOutput(child: ChildProcess): void {
		child.stdout?.on("data", (chunk: Buffer | string) => {
			this.recordOutput(chunk.toString());
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			this.recordOutput(chunk.toString());
		});
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
				throw new Error(
					exitMessage("ComfyUI", child.exitCode, child.signalCode, this.logTail),
				);
			}
			try {
				const response = await this.requestFetch(new URL("system_stats", url), {
					signal: AbortSignal.timeout(Math.min(2_000, this.retryMs * 4)),
				});
				if (response.ok) return;
			} catch {}
			await delay(this.retryMs);
		}
		child.kill("SIGTERM");
		throw new Error(`ComfyUI did not start within ${this.startupTimeoutMs}ms.`);
	}

	private recordOutput(text: string): void {
		const output = `${this.logTail}${text}`;
		if (!this.customNodeStartupFailureDetected && customNodeStartupFailed(output)) {
			this.customNodeStartupFailureDetected = true;
		}
		this.logTail = output.slice(-LOG_TAIL_LENGTH);
	}

	private resetOutput(): void {
		this.logTail = "";
		this.customNodeStartupFailureDetected = false;
	}

	private update(state: ComfyRuntimeState): void {
		this.state = state;
		for (const listener of this.listeners) listener(state);
	}
}

function customNodeStartupFailed(output: string): boolean {
	return output
		.split(/\r\n|[\r\n]/u)
		.some(
			(line) =>
				line.includes("(IMPORT FAILED):") || line.includes("(PRESTARTUP FAILED):"),
		);
}

function dependencyProgressReporter(
	onProgress: (progress: number) => void,
): (text: string) => void {
	let buffer = "";
	let progress = 20;
	let resolvedPackages = 0;
	const downloadedPackages = new Set<string>();
	const report = (next: number): void => {
		if (next <= progress) return;
		progress = next;
		onProgress(next);
	};
	const processLine = (line: string): void => {
		const resolved = line.match(/Resolved (\d+) packages?/u);
		if (resolved?.[1] !== undefined) {
			resolvedPackages = Number.parseInt(resolved[1], 10);
			report(25);
		}
		const downloaded = line.match(/Downloaded ([^\r\n]+)/u);
		if (downloaded?.[1] !== undefined) {
			downloadedPackages.add(downloaded[1].trim());
			if (resolvedPackages > 0) {
				report(
					Math.min(
						75,
						25 + Math.round((downloadedPackages.size / resolvedPackages) * 50),
					),
				);
			}
		}
		if (/Prepared \d+ packages?/u.test(line)) report(80);
		if (/Installed \d+ packages?/u.test(line)) report(88);
	};
	return (text) => {
		const lines = `${buffer}${text}`.split(/\r\n|[\r\n]/u);
		buffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	};
}

function runtimeEnvironment(
	pythonDirectory: string,
	cacheDirectory: string,
	platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		PYTHONPYCACHEPREFIX: join(cacheDirectory, "python-bytecode"),
		UV_CACHE_DIR: cacheDirectory,
		UV_MANAGED_PYTHON: "1",
		UV_NO_PROGRESS: "1",
		UV_PYTHON_INSTALL_DIR: pythonDirectory,
	};
	if (platform !== "darwin") environment.UV_TORCH_BACKEND = "cpu";
	delete environment.CONDA_PREFIX;
	delete environment.PYTHONHOME;
	delete environment.PYTHONPATH;
	delete environment.VIRTUAL_ENV;
	return environment;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function stampMatches(
	actual: Record<string, unknown> | null,
	expected: Record<string, string | null>,
): boolean {
	return (
		actual !== null &&
		Object.entries(expected).every(([key, value]) => actual[key] === value)
	);
}

async function readStamp(path: string): Promise<Record<string, unknown> | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function customNodeRequirements(directory: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const requirements = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map(async (entry) => {
				const path = join(directory, entry.name, "requirements.txt");
				return (await pathExists(path)) ? path : null;
			}),
	);
	return requirements.filter((path): path is string => path !== null).sort();
}

export async function readManagerVersion(backendDirectory: string): Promise<string> {
	const requirements = await readFile(
		join(backendDirectory, "manager_requirements.txt"),
		"utf8",
	);
	const version = /^comfyui[-_]manager==(\S+)$/mu.exec(requirements)?.[1];
	if (version === undefined) {
		throw new Error("ComfyUI does not pin a ComfyUI Manager version.");
	}
	return version;
}

/** The frontend package the backend pins, shown as the recommended frontend version. */
export async function readPinnedFrontendVersion(
	backendDirectory: string,
): Promise<string | null> {
	try {
		const requirements = await readFile(
			join(backendDirectory, "requirements.txt"),
			"utf8",
		);
		const version = /^comfyui[-_]frontend[-_]package==(\S+)$/mu.exec(requirements)?.[1];
		return version === undefined ? null : `v${version}`;
	} catch {
		return null;
	}
}

function isRuntimeManifest(value: unknown): value is RuntimeManifest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<RuntimeManifest>;
	return (
		typeof candidate.version === "string" &&
		typeof candidate.sha256 === "string" &&
		typeof candidate.pythonVersion === "string" &&
		typeof candidate.managerVersion === "string" &&
		typeof candidate.platform === "string" &&
		typeof candidate.uv === "object" &&
		candidate.uv !== null &&
		typeof candidate.uv.version === "string" &&
		typeof candidate.dependencyLock === "object" &&
		candidate.dependencyLock !== null &&
		typeof candidate.dependencyLock.sha256 === "string"
	);
}

function startProcess(
	command: string,
	args: string[],
	options: Omit<CommandOptions, "onOutput">,
): ChildProcess {
	return spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
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

/** Resolves when the process is gone, forcing it after the timeout. */
function processExit(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		const finish = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			child.off("exit", finish);
			resolve();
		};
		timer = setTimeout(() => {
			try {
				if (!child.kill("SIGKILL")) finish();
			} catch {
				finish();
			}
		}, timeoutMs);
		child.once("exit", finish);
	});
}

function processErrorMessage(error: Error): string {
	return `ComfyUI process failed. ${error.message}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
