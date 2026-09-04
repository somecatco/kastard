import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
	access,
	cp,
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import {
	gitCustomNodeState,
	isCustomNodeManagerId,
	isCustomNodeManagerVersion,
	isCustomNodeName,
	isGitCommit,
	normalizeGitHubRepository,
	ROOT_GIT_STATUS_ARGS,
} from "@kastard/common";
import {
	type ComfyRuntimeState,
	type CustomNodeEntry,
	type CustomNodeInstallOptions,
	isComfyUiManagerNode,
	isCustomNodeRepositoryUrl,
	type ModelLibraryEntry,
} from "../shared/api";
import { MODEL_PATH_CATEGORIES } from "../shared/model-path";

type RuntimeManifest = {
	version: string;
	sha256: string;
	pythonVersion: string;
	managerVersion: string;
	dependencyLock: { sha256: string };
	platform: string;
	uv: { version: string };
};

type InstalledCustomNode = Omit<CustomNodeEntry, "sync">;

type CustomNodeInstallOutcome = {
	node: InstalledCustomNode;
	nodes: InstalledCustomNode[];
	restartRequired: boolean;
};

type CommandOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	onOutput: (text: string) => void;
	signal?: AbortSignal;
	terminationTimeoutMs?: number;
};

type RunCommand = (
	command: string,
	args: string[],
	options: CommandOptions,
) => Promise<void>;

type StartProcess = (
	command: string,
	args: string[],
	options: Omit<CommandOptions, "onOutput">,
) => ChildProcess;

/** The ComfyUI source the runtime starts, either the bundled one or a user-selected release. */
export type BackendSource = {
	directory: string;
	version: string;
	sha256: string;
	/** Hash-pinned lock shipped with the bundled backend; absent for selected releases. */
	dependencyLock: { path: string; sha256: string } | null;
};

type RuntimeOptions = {
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
	customNodeInventoryTimeoutMs?: number;
	getModels?: () => readonly ModelLibraryEntry[];
	/** Resolves the selected ComfyUI release, installing it when needed, or `null` for the bundled one. */
	resolveBackend?: () => Promise<Omit<BackendSource, "dependencyLock"> | null>;
	resolveFrontend?: () => Promise<string | null>;
	/** Where the selected backend lives, without installing it. `null` for the bundled one. */
	selectedBackendDirectory?: () => Promise<string | null>;
	/** Resolves a user-selected Manager override for the active backend. */
	resolveManagerVersion?: (backendDirectory: string) => Promise<string> | string;
	trashItem?: (path: string) => Promise<void>;
	registryApiUrl?: string;
};

const STAMP_NAME = ".kastard-runtime.json";
const LOG_TAIL_LENGTH = 12_000;
const FRONTEND_SETTINGS_TIMEOUT_MS = 5_000;
const MANAGER_OPERATION_TIMEOUT_MS = 120_000;
const MANAGER_OPERATION_POLL_MS = 250;
const CUSTOM_NODE_INVENTORY_TIMEOUT_MS = 10_000;
const REGISTRY_REQUEST_TIMEOUT_MS = 10_000;
const CUSTOM_NODE_INSTALL_TIMEOUT_MS = 15 * 60 * 1_000;
const NAMED_VALUES_SETTING = "Comfy.Workflow.NamedValuesRestore";
const RESERVED_MODEL_PATH_KEYS = new Set(["base_path", "is_default"]);
const NO_SUPPORTED_CUSTOM_NODE_SOURCE =
	"No Registry package or supported GitHub repository was found.";
const SYMLINK_CUSTOM_NODE_ISSUE =
	"Symbolic-link custom node directories cannot be reproduced on the Worker.";
const REPOSITORY_ROOT_ISSUE =
	"The custom node directory is not the root of its Git repository.";
const GITHUB_ORIGIN_ISSUE =
	"The Git repository does not have a supported GitHub origin.";
const HEAD_COMMIT_ISSUE = "The Git repository does not have a valid HEAD commit.";
const LOCAL_CHANGES_ISSUE =
	"Tracked or untracked local changes are not included in the Git commit.";
const GIT_METADATA_ISSUE = "The Git repository metadata could not be read.";

type GitCustomNodeInspection = Pick<InstalledCustomNode, "version"> &
	Partial<Pick<InstalledCustomNode, "repository" | "workerSyncIssue">>;

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
	private readonly customNodeInventoryTimeoutMs: number;
	private startPromise: Promise<string> | null = null;
	private prepareController: AbortController | null = null;
	private process: ChildProcess | null = null;
	private stopping = false;
	private logTail = "";
	private customNodeStartupFailureDetected = false;
	private customNodeMutationActive = false;
	private customNodeInstallController: AbortController | null = null;
	private customNodeInstallPromise: Promise<CustomNodeInstallOutcome> | null = null;
	private modelSync: Promise<void> = Promise.resolve();

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
		this.customNodeInventoryTimeoutMs =
			options.customNodeInventoryTimeoutMs ?? CUSTOM_NODE_INVENTORY_TIMEOUT_MS;
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

	syncModels(models: readonly ModelLibraryEntry[]): Promise<void> {
		const paths = models.map((model) => model.path);
		return this.queueModelOperation(() => this.replaceVirtualModels(paths));
	}

	private queueModelOperation<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.modelSync.then(operation);
		this.modelSync = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	async listCustomNodes(signal?: AbortSignal): Promise<InstalledCustomNode[]> {
		const directory = join(this.options.dataDirectory, "data", "custom_nodes");
		const url = this.getUrl();
		if (url === null) {
			return localInstalledCustomNodes(directory);
		}
		const timeout = AbortSignal.timeout(this.customNodeInventoryTimeoutMs);
		const requestSignal =
			signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
		try {
			const response = await this.requestFetch(
				new URL("v2/customnode/installed?mode=default", url),
				{ signal: requestSignal },
			);
			if (!response.ok) {
				throw new Error(`ComfyUI Manager returned HTTP ${response.status}.`);
			}
			return addRepositoryMetadata(
				directory,
				installedCustomNodes(await response.json()),
			);
		} catch (error) {
			if (timeout.aborted && !signal?.aborted) {
				throw new Error(
					"ComfyUI Manager did not return the custom-node inventory in time.",
				);
			}
			throw error;
		}
	}

	async installCustomNode(
		repository: string,
		version?: string,
	): Promise<CustomNodeInstallOutcome> {
		const normalized = normalizeGitHubRepository(repository);
		if (normalized === null || normalized.url !== repository) {
			throw new Error("Enter a public GitHub repository URL.");
		}
		if (
			version !== undefined &&
			version !== "nightly" &&
			!isCustomNodeManagerVersion(version)
		) {
			throw new Error("Select a valid custom-node version.");
		}
		if (this.state.status !== "ready") {
			throw new Error("Custom nodes can only be installed while ComfyUI is ready.");
		}
		if (this.customNodeMutationActive) {
			throw new Error("Another custom-node change is in progress.");
		}
		if (this.startPromise !== null) {
			throw new Error(
				"Custom nodes cannot be installed while ComfyUI is starting or restarting.",
			);
		}

		this.customNodeMutationActive = true;
		const controller = new AbortController();
		this.customNodeInstallController = controller;
		const installation = this.installCustomNodeOnce(normalized, version, controller);
		this.customNodeInstallPromise = installation;
		try {
			return await installation;
		} finally {
			if (this.customNodeInstallController === controller) {
				this.customNodeInstallController = null;
			}
			if (this.customNodeInstallPromise === installation) {
				this.customNodeInstallPromise = null;
			}
			this.customNodeMutationActive = false;
		}
	}

	private async installCustomNodeOnce(
		repository: { id: string; url: string },
		version: string | undefined,
		controller: AbortController,
	): Promise<CustomNodeInstallOutcome> {
		let before: InstalledCustomNode[];
		try {
			before = await this.listCustomNodes(controller.signal);
		} catch (error) {
			if (controller.signal.aborted) {
				throw new Error("Custom-node installation was canceled.");
			}
			throw error;
		}
		const existing = before.find(
			(node) =>
				node.repository !== undefined &&
				normalizeGitHubRepository(node.repository)?.id === repository.id,
		);
		if (existing !== undefined) {
			throw new Error(`${existing.name} already uses this GitHub repository.`);
		}
		let packageSpec = repository.url;
		let managerId: string | null = null;
		if (version !== undefined) {
			let options: CustomNodeInstallOptions | null;
			try {
				options = await this.resolveCustomNodeInstallOptions(
					repository.url,
					controller.signal,
				);
				controller.signal.throwIfAborted();
			} catch (error) {
				if (controller.signal.aborted) {
					throw new Error("Custom-node installation was canceled.");
				}
				throw error;
			}
			if (options === null) {
				throw new Error("This GitHub repository is not registered with ComfyUI.");
			}
			if (version !== "nightly" && !options.versions.includes(version)) {
				throw new Error("The selected custom-node version is no longer available.");
			}
			managerId = options.managerId;
			packageSpec = `${options.managerId}@${version}`;
		}

		const root = this.options.dataDirectory;
		const dataDirectory = join(root, "data");
		const customNodesDirectory = join(dataDirectory, "custom_nodes");
		const managerDirectory = join(dataDirectory, "user", "__manager");
		const environmentDirectory = join(root, "environment");
		const python = environmentPython(environmentDirectory, this.platform);
		const backendDirectory =
			(await this.options.selectedBackendDirectory?.()) ??
			this.bundledBackendDirectory();
		await Promise.all([
			access(python),
			prepareManagerDirectory(dataDirectory, managerDirectory),
			mkdir(customNodesDirectory, { recursive: true }),
		]);
		const initialEntries = await customNodeEntryNames(customNodesDirectory);
		let output = "";
		let timedOut = false;
		let preserveNewEntries = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, CUSTOM_NODE_INSTALL_TIMEOUT_MS);
		timeout.unref();
		try {
			let commandError: unknown;
			try {
				await this.runCommand(
					python,
					[
						"-m",
						"cm_cli",
						"install",
						packageSpec,
						"--mode",
						"cache",
						"--user-directory",
						managerDirectory,
						"--exit-on-fail",
					],
					{
						cwd: backendDirectory,
						env: customNodeInstallEnvironment(
							process.env,
							backendDirectory,
							dataDirectory,
							managerDirectory,
							join(root, "python"),
							join(root, "cache"),
							this.platform,
						),
						onOutput: (text) => {
							output = `${output}${text}`.slice(-LOG_TAIL_LENGTH);
						},
						signal: controller.signal,
						terminationTimeoutMs: this.terminationTimeoutMs,
					},
				);
			} catch (error) {
				commandError = error;
			}
			controller.signal.throwIfAborted();
			const failures = managerCommandFailureLines(output);
			if (commandError === undefined && failures.length === 0) {
				preserveNewEntries = true;
			}
			const installed = await this.listCustomNodes(controller.signal);
			controller.signal.throwIfAborted();
			const matches = installed.filter(
				(node) =>
					!before.some((previous) => previous.name === node.name) &&
					((node.repository !== undefined &&
						normalizeGitHubRepository(node.repository)?.id === repository.id &&
						(version === undefined ||
							version === "nightly" ||
							node.version === version)) ||
						(managerId !== null &&
							version !== undefined &&
							version !== "nightly" &&
							node.managerId === managerId &&
							node.version === version)),
			);
			const node = matches.length === 1 ? matches[0] : undefined;
			if (node !== undefined) preserveNewEntries = true;
			if (failures.length > 0) {
				throw new Error(
					`ComfyUI Manager reported installation errors. ${failures.slice(0, 3).join(" ")}`,
				);
			}
			if (commandError !== undefined) {
				throw new Error(managerInstallCommandError(commandError));
			}
			if (node !== undefined) {
				return { node, nodes: installed, restartRequired: true };
			}
			throw new Error(
				"ComfyUI Manager completed, but the installed custom node could not be identified.",
			);
		} catch (error) {
			const cleanupError = preserveNewEntries
				? undefined
				: await trashNewCustomNode(
						customNodesDirectory,
						initialEntries,
						repository.id,
						managerId,
						this.options.trashItem,
					).catch((cause: unknown) => errorMessage(cause));
			if (controller.signal.aborted) {
				throw new Error(
					timedOut
						? "Custom-node installation timed out."
						: "Custom-node installation was canceled.",
				);
			}
			const message = errorMessage(error);
			throw new Error(
				typeof cleanupError === "string"
					? `${message} The incomplete installation could not be moved to Trash: ${cleanupError}`
					: message,
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	async resolveCustomNodeInstallOptions(
		repository: string,
		signal?: AbortSignal,
	): Promise<CustomNodeInstallOptions | null> {
		const normalized = normalizeGitHubRepository(repository);
		if (normalized === null || normalized.url !== repository) {
			throw new Error("Enter a public GitHub repository URL.");
		}
		if (this.options.registryApiUrl === undefined) {
			throw new Error("The ComfyUI Registry is unavailable.");
		}

		const apiUrl = new URL(this.options.registryApiUrl);
		if (apiUrl.protocol !== "https:") {
			throw new Error("The ComfyUI Registry is unavailable.");
		}
		const searchUrl = new URL(
			"nodes/search",
			`${apiUrl.toString().replace(/\/$/u, "")}/`,
		);
		searchUrl.searchParams.set("repository_url_search", normalized.url);
		searchUrl.searchParams.set("limit", "64");
		searchUrl.searchParams.set("page", "1");
		const searchResponse = await this.fetchRegistry(searchUrl, signal);
		if (!searchResponse.ok) {
			throw new Error(`ComfyUI Registry returned HTTP ${searchResponse.status}.`);
		}
		const matches = registryRepositoryMatches(
			await searchResponse.json(),
			normalized.id,
		);
		if (matches.length === 0) return null;
		if (matches.length > 1) {
			throw new Error("The ComfyUI Registry returned duplicate repository matches.");
		}

		const match = matches[0];
		if (match === undefined) return null;
		const versionsUrl = new URL(
			`nodes/${encodeURIComponent(match.managerId)}/versions`,
			`${apiUrl.toString().replace(/\/$/u, "")}/`,
		);
		versionsUrl.searchParams.append("statuses", "NodeVersionStatusActive");
		versionsUrl.searchParams.append("statuses", "NodeVersionStatusPending");
		const versionsResponse = await this.fetchRegistry(versionsUrl, signal);
		if (!versionsResponse.ok) {
			throw new Error(`ComfyUI Registry returned HTTP ${versionsResponse.status}.`);
		}
		const versions = registryVersions(await versionsResponse.json());
		if (!versions.includes(match.latestVersion)) versions.unshift(match.latestVersion);
		return {
			managerId: match.managerId,
			latestVersion: match.latestVersion,
			versions,
		};
	}

	private async fetchRegistry(url: URL, signal?: AbortSignal): Promise<Response> {
		const requestSignal =
			signal === undefined
				? AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS)
				: AbortSignal.any([signal, AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS)]);
		try {
			return await this.requestFetch(url, { signal: requestSignal });
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new Error("ComfyUI Registry could not be reached.");
		}
	}

	async removeCustomNode(name: string): Promise<{ restartRequired: boolean }> {
		if (!isCustomNodeName(name)) throw new Error("Invalid custom-node package name.");
		const state = this.state;
		const recovery = state.status === "error" && state.reason === "custom-node";
		if (state.status !== "ready" && !recovery) {
			throw new Error("Custom nodes can only be removed while ComfyUI is ready.");
		}
		if (this.customNodeMutationActive) {
			throw new Error("Another custom-node change is in progress.");
		}
		if (this.startPromise !== null) {
			throw new Error(
				"Custom nodes cannot be removed while ComfyUI is starting or restarting.",
			);
		}

		this.customNodeMutationActive = true;
		try {
			const matches = (await this.listCustomNodes()).filter(
				(node) => node.name === name,
			);
			if (matches.length === 0) throw new Error(`Custom node not found: ${name}.`);
			if (matches.length > 1) throw new Error(`Duplicate custom node: ${name}.`);
			const node = matches[0];
			if (node === undefined) throw new Error(`Custom node not found: ${name}.`);
			if (isComfyUiManagerNode(node)) {
				throw new Error("ComfyUI Manager cannot be removed from Kastard.");
			}

			if (
				state.status === "ready" &&
				(node.managerId !== null || node.repository !== undefined)
			) {
				await this.uninstallWithManager(state.url, node);
			} else {
				const trashItem = this.options.trashItem;
				if (trashItem === undefined) {
					throw new Error("The operating-system Trash is unavailable.");
				}
				const directory = join(this.options.dataDirectory, "data", "custom_nodes");
				await trashItem(await customNodePath(directory, name));
			}
			return { restartRequired: state.status === "ready" };
		} finally {
			this.customNodeMutationActive = false;
		}
	}

	private async uninstallWithManager(
		url: string,
		node: InstalledCustomNode,
	): Promise<void> {
		const taskId = `kastard-${randomUUID()}`;
		await expectManagerResponse(
			await this.requestFetch(new URL("v2/manager/queue/task", url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					ui_id: taskId,
					client_id: taskId,
					kind: "uninstall",
					params: {
						node_name: node.managerId ?? node.name,
						is_unknown: node.managerId === null,
					},
				}),
			}),
			"queue the uninstall",
		);
		await expectManagerResponse(
			await this.requestFetch(new URL("v2/manager/queue/start", url), {
				method: "POST",
			}),
			"start the uninstall",
			[200, 201],
		);

		const deadline = Date.now() + MANAGER_OPERATION_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const history = await this.requestFetch(
				new URL(`v2/manager/queue/history?ui_id=${encodeURIComponent(taskId)}`, url),
			);
			await expectManagerResponse(history, "read the uninstall result");
			const result = managerTaskResult(await history.json(), taskId);
			if (result?.status === "success") return;
			if (result !== null && result !== undefined) {
				throw new Error(
					`ComfyUI Manager could not uninstall ${node.name}. ${result.message}`,
				);
			}
			await delay(MANAGER_OPERATION_POLL_MS);
		}
		throw new Error(`ComfyUI Manager timed out while uninstalling ${node.name}.`);
	}

	async getManagerVersion(): Promise<string> {
		// Custom-node planning calls this, so it must never trigger a release download.
		const selected = (await this.options.selectedBackendDirectory?.()) ?? null;
		const backendDirectory = selected ?? this.bundledBackendDirectory();
		return (
			(await this.options.resolveManagerVersion?.(backendDirectory)) ??
			readManagerVersion(backendDirectory)
		);
	}

	async start(): Promise<string> {
		if (this.customNodeMutationActive) {
			throw new Error(
				"ComfyUI cannot start while a custom-node change is in progress.",
			);
		}
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
		const installing = this.customNodeInstallPromise;
		this.stopping = true;
		this.prepareController?.abort();
		this.customNodeInstallController?.abort();
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
		await installing?.catch(() => undefined);
	}

	/** Restarts on the currently selected ComfyUI frontend and backend. */
	async restart(): Promise<string> {
		if (this.customNodeMutationActive) {
			throw new Error(
				"ComfyUI cannot restart while a custom-node change is in progress.",
			);
		}
		await this.stop();
		return this.start();
	}

	private async startOnce(signal: AbortSignal): Promise<string> {
		this.resetOutput();
		try {
			const manifest = await this.readManifest();
			const backend = await this.resolveBackendSource(manifest);
			const frontendDirectory =
				(await this.options.resolveFrontend?.()) ?? this.options.frontendDirectory;
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
	): Promise<BackendSource> {
		const selected = (await this.options.resolveBackend?.()) ?? null;
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
		await this.syncModels(this.options.getModels?.() ?? []);
		signal.throwIfAborted();
		const dataDirectory = join(this.options.dataDirectory, "data");
		const userDirectory = join(dataDirectory, "user");
		const virtualModelsDirectory = join(this.options.dataDirectory, "virtual-models");
		const backendDirectory = backend.directory;
		const databasePath = join(userDirectory, "comfyui.db").replaceAll("\\", "/");
		let childError: Error | null = null;
		const child = await this.queueModelOperation(async () => {
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

	private async replaceVirtualModels(paths: readonly string[]): Promise<void> {
		const directory = join(this.options.dataDirectory, "virtual-models");
		const localDirectory = join(this.options.dataDirectory, "data", "models");
		const staging = `${directory}.next`;
		const previous = `${directory}.previous`;
		if (!(await pathExists(directory)) && (await pathExists(previous))) {
			await rename(previous, directory);
		}
		const categories = new Set<string>(MODEL_PATH_CATEGORIES);
		for (const modelDirectory of [directory, localDirectory]) {
			try {
				const entries = await readdir(modelDirectory, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory() && !RESERVED_MODEL_PATH_KEYS.has(entry.name)) {
						categories.add(entry.name);
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		await rm(staging, { recursive: true, force: true });
		await mkdir(staging, { recursive: true });
		await Promise.all(
			[...categories].map((category) =>
				mkdir(join(staging, category), { recursive: true }),
			),
		);
		for (const path of paths) {
			const segments = virtualModelSegments(path);
			categories.add(segments[0]);
			const target = join(staging, ...segments);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, "");
		}
		await preserveUserModelFiles(previous, staging);
		await preserveUserModelFiles(directory, staging);
		await rm(previous, { recursive: true, force: true });
		let movedCurrent = false;
		try {
			await rename(directory, previous);
			movedCurrent = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(staging, directory);
		} catch (error) {
			if (movedCurrent) {
				try {
					await rename(previous, directory);
				} catch (restoreError) {
					throw new AggregateError(
						[error, restoreError],
						"Virtual model directory replacement and recovery failed.",
					);
				}
			}
			throw error;
		}
		const virtualModelPaths: Record<string, string> = Object.create(null);
		virtualModelPaths.base_path = directory;
		for (const category of categories) virtualModelPaths[category] = category;
		const localModelPaths: Record<string, string | boolean> = Object.create(null);
		localModelPaths.base_path = localDirectory;
		localModelPaths.is_default = true;
		for (const category of categories) localModelPaths[category] = category;
		Object.assign(localModelPaths, {
			configs: "configs",
			controlnet: "controlnet\nt2i_adapter",
			diffusion_models: "unet\ndiffusion_models",
			text_encoders: "text_encoders\nclip",
		});
		await writeFile(
			join(this.options.dataDirectory, "editor-model-paths.json"),
			`${JSON.stringify(
				{ kastard_virtual: virtualModelPaths, kastard_local: localModelPaths },
				null,
				2,
			)}\n`,
			"utf8",
		);
		await rm(previous, { recursive: true, force: true });
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

async function customNodeEntryNames(directory: string): Promise<Set<string>> {
	try {
		return new Set((await readdir(directory)).filter((name) => name !== "__pycache__"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw error;
	}
}

async function trashNewCustomNode(
	directory: string,
	initialEntries: ReadonlySet<string>,
	repositoryId: string,
	managerId: string | null,
	trashItem: RuntimeOptions["trashItem"],
): Promise<void> {
	if (trashItem === undefined) return;
	const entries = await readdir(directory, { withFileTypes: true });
	const candidates = entries.filter(
		(entry) =>
			!initialEntries.has(entry.name) &&
			entry.name !== "__pycache__" &&
			entry.name !== ".disabled" &&
			!entry.name.startsWith(".") &&
			isCustomNodeName(entry.name) &&
			(entry.isDirectory() ||
				entry.isSymbolicLink() ||
				(entry.isFile() && entry.name.endsWith(".py"))),
	);
	const matches = (
		await Promise.all(
			candidates.map(async (candidate) => {
				const path = join(directory, candidate.name);
				return (await customNodePathMatchesInstall(path, repositoryId, managerId))
					? path
					: null;
			}),
		)
	).filter((path): path is string => path !== null);
	if (matches.length === 1) await trashItem(matches[0] as string);
}

async function customNodePathMatchesInstall(
	path: string,
	repositoryId: string,
	managerId: string | null,
): Promise<boolean> {
	const metadata = await inspectCnrPackage(path);
	if (metadata !== null) {
		if (managerId !== null && metadata.name === managerId) return true;
		return (
			metadata.repository !== undefined &&
			normalizeGitHubRepository(metadata.repository)?.id === repositoryId
		);
	}
	const github = await inspectGitHubRepository(path);
	return (
		github?.repository !== undefined &&
		normalizeGitHubRepository(github.repository)?.id === repositoryId
	);
}

async function customNodePath(directory: string, name: string): Promise<string> {
	const candidates = [
		join(directory, name),
		join(directory, ".disabled", name),
		join(directory, `${name}.disabled`),
	];
	const matches: string[] = [];
	for (const path of candidates) {
		try {
			const metadata = await lstat(path);
			if (
				metadata.isDirectory() ||
				metadata.isSymbolicLink() ||
				(metadata.isFile() && (name.endsWith(".py") || path.endsWith(".py.disabled")))
			) {
				matches.push(path);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (matches.length === 0) throw new Error(`Custom node not found: ${name}.`);
	if (matches.length > 1) throw new Error(`Duplicate custom node paths: ${name}.`);
	const path = matches[0];
	if (path === undefined) throw new Error(`Custom node not found: ${name}.`);
	return path;
}

async function expectManagerResponse(
	response: Response,
	action: string,
	acceptedStatuses: readonly number[] = [200],
): Promise<void> {
	if (acceptedStatuses.includes(response.status)) return;
	const detail = (await response.text()).trim();
	throw new Error(
		detail.length === 0
			? `ComfyUI Manager returned HTTP ${response.status} while trying to ${action}.`
			: `ComfyUI Manager returned HTTP ${response.status} while trying to ${action}. ${detail}`,
	);
}

function managerTaskResult(
	value: unknown,
	taskId: string,
): { status: string; message: string } | null | undefined {
	if (!isRecord(value) || !isRecord(value.history)) {
		throw new Error("ComfyUI Manager returned invalid uninstall history.");
	}
	const task = value.history.ui_id === taskId ? value.history : value.history[taskId];
	if (task === undefined) return undefined;
	if (!isRecord(task) || !isRecord(task.status)) {
		throw new Error("ComfyUI Manager returned invalid uninstall history.");
	}
	if (task.status.completed !== true) return null;
	if (typeof task.status.status_str !== "string") {
		throw new Error("ComfyUI Manager returned invalid uninstall history.");
	}
	const messages = Array.isArray(task.status.messages)
		? task.status.messages.filter(
				(message): message is string => typeof message === "string",
			)
		: [];
	const fallback = typeof task.result === "string" ? task.result : "Uninstall failed.";
	return {
		status: task.status.status_str,
		message: messages.join(" ").trim() || fallback,
	};
}

function customNodeStartupFailed(output: string): boolean {
	return output
		.split(/\r\n|[\r\n]/u)
		.some(
			(line) =>
				line.includes("(IMPORT FAILED):") || line.includes("(PRESTARTUP FAILED):"),
		);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registryRepositoryMatches(
	value: unknown,
	repositoryId: string,
): Array<{ managerId: string; latestVersion: string }> {
	if (!isRecord(value) || !Array.isArray(value.nodes)) {
		throw new Error("ComfyUI Registry returned an invalid package search result.");
	}
	const matches: Array<{ managerId: string; latestVersion: string }> = [];
	for (const valueNode of value.nodes) {
		if (!isRecord(valueNode) || typeof valueNode.repository !== "string") continue;
		if (normalizeGitHubRepository(valueNode.repository)?.id !== repositoryId) continue;
		if (
			!isCustomNodeManagerId(valueNode.id) ||
			!isRecord(valueNode.latest_version) ||
			!isCustomNodeManagerVersion(valueNode.latest_version.version)
		) {
			throw new Error("ComfyUI Registry returned invalid package metadata.");
		}
		matches.push({
			managerId: valueNode.id,
			latestVersion: valueNode.latest_version.version,
		});
	}
	return matches;
}

function registryVersions(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new Error("ComfyUI Registry returned an invalid version list.");
	}
	const versions: string[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !isCustomNodeManagerVersion(entry.version)) continue;
		if (
			entry.status !== undefined &&
			![
				"active",
				"pending",
				"NodeVersionStatusActive",
				"NodeVersionStatusPending",
			].includes(String(entry.status))
		) {
			continue;
		}
		if (!versions.includes(entry.version)) versions.push(entry.version);
	}
	return versions;
}

async function preserveUserModelFiles(
	source: string,
	destination: string,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(source, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await mkdir(destination, { recursive: true });
	for (const entry of entries) {
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isDirectory()) {
			await preserveUserModelFiles(sourcePath, destinationPath);
			continue;
		}
		if (entry.isSymbolicLink()) {
			await rm(destinationPath, { recursive: true, force: true });
			await cp(sourcePath, destinationPath, { verbatimSymlinks: true });
			continue;
		}
		if (entry.isFile() && (await stat(sourcePath)).size > 0) {
			await rm(destinationPath, { recursive: true, force: true });
			await link(sourcePath, destinationPath);
		}
	}
}

function installedCustomNodes(value: unknown): InstalledCustomNode[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("ComfyUI Manager returned an invalid custom-nodes list.");
	}

	const nodes: InstalledCustomNode[] = [];
	for (const [name, metadata] of Object.entries(value)) {
		if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
			throw new Error("ComfyUI Manager returned an invalid custom-nodes list.");
		}
		const candidate = metadata as { ver?: unknown; cnr_id?: unknown };
		if (!isCustomNodeName(name) || typeof candidate.ver !== "string") {
			throw new Error("ComfyUI Manager returned an invalid custom-nodes list.");
		}
		const managerId =
			isCustomNodeManagerId(candidate.cnr_id) &&
			isCustomNodeManagerVersion(candidate.ver)
				? candidate.cnr_id
				: null;
		nodes.push(
			managerId === null
				? {
						name,
						version: candidate.ver,
						managerId,
						workerSyncIssue: NO_SUPPORTED_CUSTOM_NODE_SOURCE,
					}
				: { name, version: candidate.ver, managerId },
		);
	}

	return nodes.sort((left, right) =>
		left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
	);
}

async function localInstalledCustomNodes(
	directory: string,
): Promise<InstalledCustomNode[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const active = entries.filter(
		(entry) =>
			entry.name !== "__pycache__" &&
			entry.name !== ".disabled" &&
			!entry.name.endsWith(".disabled") &&
			(entry.isDirectory() ||
				entry.isSymbolicLink() ||
				(entry.isFile() && entry.name.endsWith(".py"))),
	);
	const suffixedDisabled = entries.filter(
		(entry) =>
			entry.name !== ".disabled" &&
			entry.name.endsWith(".disabled") &&
			(entry.isDirectory() ||
				entry.isSymbolicLink() ||
				(entry.isFile() && entry.name.endsWith(".py.disabled"))),
	);
	const disabledDirectory = join(directory, ".disabled");
	let nestedDisabled: Dirent[] = [];
	try {
		nestedDisabled = (await readdir(disabledDirectory, { withFileTypes: true })).filter(
			(entry) =>
				entry.name !== "__pycache__" &&
				(entry.isDirectory() ||
					entry.isSymbolicLink() ||
					(entry.isFile() && entry.name.endsWith(".py"))),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const nodes = await Promise.all([
		...active.map((entry) => localInstalledCustomNode(directory, entry.name)),
		...suffixedDisabled.map(async (entry) => ({
			...(await localInstalledCustomNode(directory, entry.name)),
			name: entry.name.slice(0, -".disabled".length),
		})),
		...nestedDisabled.map((entry) =>
			localInstalledCustomNode(disabledDirectory, entry.name),
		),
	]);
	return nodes.sort((left, right) =>
		left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
	);
}

async function localInstalledCustomNode(
	directory: string,
	name: string,
): Promise<InstalledCustomNode> {
	const path = join(directory, name);
	const metadata = await inspectCnrPackage(path);
	if (metadata !== null) {
		return {
			name,
			version: metadata.version,
			managerId: metadata.name,
			...(metadata.repository === undefined ? {} : { repository: metadata.repository }),
		};
	}
	const github = await inspectGitHubRepository(path);
	return github === null
		? {
				name,
				version: "unknown",
				managerId: null,
				workerSyncIssue: NO_SUPPORTED_CUSTOM_NODE_SOURCE,
			}
		: { name, managerId: null, ...github };
}

async function addRepositoryMetadata(
	directory: string,
	nodes: InstalledCustomNode[],
): Promise<InstalledCustomNode[]> {
	return Promise.all(
		nodes.map(async (node) => {
			for (const path of [
				join(directory, node.name),
				join(directory, ".disabled", node.name),
				join(directory, `${node.name}.disabled`),
			]) {
				if (node.managerId !== null) {
					const metadata = await inspectCnrPackage(path);
					if (metadata?.name === node.managerId && metadata.repository !== undefined) {
						return { ...node, repository: metadata.repository };
					}
					continue;
				}
				const github = await inspectGitHubRepository(path);
				if (github !== null) {
					return { name: node.name, managerId: null, ...github };
				}
			}
			return node;
		}),
	);
}

async function inspectCnrPackage(
	directory: string,
): Promise<ReturnType<typeof cnrProjectMetadata>> {
	if (!(await pathExists(join(directory, ".tracking")))) return null;
	try {
		return cnrProjectMetadata(
			await readFile(join(directory, "pyproject.toml"), "utf8"),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function inspectGitHubRepository(
	directory: string,
): Promise<GitCustomNodeInspection | null> {
	let entry: Stats;
	try {
		entry = await lstat(directory);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? null
			: { version: "unknown", workerSyncIssue: GIT_METADATA_ISSUE };
	}
	if (entry.isSymbolicLink()) {
		return { version: "unknown", workerSyncIssue: SYMLINK_CUSTOM_NODE_ISSUE };
	}
	if (!entry.isDirectory()) {
		return { version: "unknown", workerSyncIssue: NO_SUPPORTED_CUSTOM_NODE_SOURCE };
	}
	let topLevel: string;
	try {
		topLevel = await gitOutput(directory, ["rev-parse", "--show-toplevel"]);
	} catch {
		return { version: "unknown", workerSyncIssue: NO_SUPPORTED_CUSTOM_NODE_SOURCE };
	}
	const [actualDirectory, repositoryRoot] = await Promise.all([
		realpath(directory),
		realpath(topLevel.trim()),
	]);
	if (actualDirectory !== repositoryRoot) {
		return { version: "unknown", workerSyncIssue: REPOSITORY_ROOT_ISSUE };
	}
	const [originResult, commitResult, statusResult] = await Promise.allSettled([
		gitOutput(directory, ["config", "--get", "remote.origin.url"]),
		gitOutput(directory, ["rev-parse", "--verify", "HEAD"]),
		gitOutput(directory, [...ROOT_GIT_STATUS_ARGS]),
	]);
	if (originResult.status === "rejected") {
		return { version: "unknown", workerSyncIssue: GITHUB_ORIGIN_ISSUE };
	}
	const repository = normalizeGitHubRepository(originResult.value.trim());
	if (repository === null) {
		return { version: "unknown", workerSyncIssue: GITHUB_ORIGIN_ISSUE };
	}
	if (commitResult.status === "rejected" || !isGitCommit(commitResult.value.trim())) {
		return {
			version: "unknown",
			repository: repository.url,
			workerSyncIssue: HEAD_COMMIT_ISSUE,
		};
	}
	if (statusResult.status === "rejected") {
		return {
			version: commitResult.value.trim().toLowerCase(),
			repository: repository.url,
			workerSyncIssue: GIT_METADATA_ISSUE,
		};
	}
	const state = gitCustomNodeState({
		origin: originResult.value,
		commit: commitResult.value,
		status: statusResult.value,
		directory: actualDirectory,
		repositoryRoot,
	});
	if (state === null) {
		return { version: "unknown", workerSyncIssue: GIT_METADATA_ISSUE };
	}
	return {
		version: state.commit,
		repository: state.repository,
		...(state.hasRootChanges ? { workerSyncIssue: LOCAL_CHANGES_ISSUE } : {}),
	};
}

function gitOutput(
	directory: string,
	args: string[],
	timeoutMs = 5_000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["--no-optional-locks", "-C", directory, ...args],
			{
				env: gitEnvironment(process.env),
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
				timeout: timeoutMs,
			},
			(error, stdout) => {
				if (error === null) resolve(stdout);
				else reject(error);
			},
		);
	});
}

function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
	};
	for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP"]) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

function cnrProjectMetadata(
	contents: string,
): { name: string; version: string; repository?: string } | null {
	let currentSection: string | null = null;
	let name: string | null = null;
	let version: string | null = null;
	let repository: string | undefined;
	for (const line of contents.split(/\r?\n/u)) {
		const section = line.match(/^\s*\[(.+?)\]\s*(?:#.*)?$/u);
		if (section !== null) {
			currentSection = section[1]?.trim() ?? null;
			continue;
		}
		if (currentSection === "project") {
			const assignment = line.match(
				/^\s*(name|version)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*(?:#.*)?$/u,
			);
			if (assignment === null) continue;
			const value = tomlString(assignment[2], assignment[3]);
			if (value === null) return null;
			if (assignment[1] === "name") name = value;
			else version = value;
			continue;
		}
		if (currentSection !== "project.urls") continue;
		const assignment = line.match(
			/^\s*(?:Repository|"Repository"|'Repository')\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*(?:#.*)?$/u,
		);
		if (assignment === null) continue;
		const value = tomlString(assignment[1], assignment[2]);
		if (value !== null && isCustomNodeRepositoryUrl(value)) repository = value;
	}
	return isCustomNodeManagerId(name) && isCustomNodeManagerVersion(version)
		? { name, version, ...(repository === undefined ? {} : { repository }) }
		: null;
}

function tomlString(
	basic: string | undefined,
	literal: string | undefined,
): string | null {
	if (literal !== undefined) return literal;
	if (basic === undefined) return null;
	try {
		const value: unknown = JSON.parse(`"${basic}"`);
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function virtualModelSegments(path: string): [string, ...string[]] {
	const segments = path.split("/");
	if (
		path.includes("\\") ||
		segments.length < 2 ||
		segments.some(
			(segment) =>
				segment.length === 0 ||
				segment === "." ||
				segment === ".." ||
				segment.includes(":"),
		) ||
		RESERVED_MODEL_PATH_KEYS.has(segments[0] ?? "")
	) {
		throw new Error(`Invalid virtual model path: ${path}`);
	}
	return segments as [string, ...string[]];
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

const CUSTOM_NODE_ENVIRONMENT_KEYS = [
	"PATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"TMP",
	"TEMP",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"UV_CONSTRAINT",
	"UV_LINK_MODE",
	"CC",
	"CXX",
	"CFLAGS",
	"CXXFLAGS",
	"LDFLAGS",
	"CMAKE_PREFIX_PATH",
	"CPATH",
	"LIBRARY_PATH",
	"LD_LIBRARY_PATH",
	"SystemRoot",
	"WINDIR",
	"PATHEXT",
	"COMSPEC",
] as const;

function customNodeInstallEnvironment(
	source: NodeJS.ProcessEnv,
	backendDirectory: string,
	dataDirectory: string,
	managerDirectory: string,
	pythonDirectory: string,
	cacheDirectory: string,
	platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of CUSTOM_NODE_ENVIRONMENT_KEYS) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return {
		...environment,
		HOME: managerDirectory,
		XDG_CACHE_HOME: join(managerDirectory, "cache"),
		PYTHONPYCACHEPREFIX: join(managerDirectory, "cache", "python-bytecode"),
		COMFYUI_PATH: backendDirectory,
		COMFYUI_FOLDERS_BASE_PATH: dataDirectory,
		GIT_TERMINAL_PROMPT: "0",
		PIP_NO_INPUT: "1",
		UV_CACHE_DIR: cacheDirectory,
		UV_MANAGED_PYTHON: "1",
		UV_NO_PROGRESS: "1",
		UV_PYTHON_INSTALL_DIR: pythonDirectory,
		...(platform === "darwin" ? {} : { UV_TORCH_BACKEND: "cpu" }),
	};
}

async function prepareManagerDirectory(
	dataDirectory: string,
	managerDirectory: string,
): Promise<void> {
	await mkdir(managerDirectory, { recursive: true });
	await writeFile(
		join(managerDirectory, "extra_model_paths.yaml"),
		[
			"kastard:",
			`  base_path: ${JSON.stringify(dataDirectory)}`,
			"  is_default: true",
			"  custom_nodes: custom_nodes",
			"",
		].join("\n"),
		"utf8",
	);
}

function managerCommandFailureLines(output: string): string[] {
	return output
		.split(/[\r\n]+/u)
		.map((line) => line.trim())
		.filter((line) => line.includes("ERROR:") || /\[\s*FAIL\s*\]/u.test(line))
		.map((line) => {
			const errorOffset = line.indexOf("ERROR:");
			const detail = errorOffset < 0 ? line : line.slice(errorOffset);
			return detail.length > 400 ? `${detail.slice(0, 397)}...` : detail;
		});
}

function managerInstallCommandError(error: unknown): string {
	const reason = /exited with (code \d+|signal [^.]+)\./u.exec(
		errorMessage(error),
	)?.[1];
	return reason === undefined
		? "ComfyUI Manager could not install the custom node."
		: `ComfyUI Manager exited with ${reason}.`;
}

function environmentPython(
	environmentDirectory: string,
	platform: NodeJS.Platform,
): string {
	return platform === "win32"
		? join(environmentDirectory, "Scripts", "python.exe")
		: join(environmentDirectory, "bin", "python");
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

function runCommand(
	command: string,
	args: string[],
	options: CommandOptions,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			// A separate process group lets cancellation include Git and package installer descendants.
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let processError: Error | null = null;
		let forceTimer: NodeJS.Timeout | undefined;
		const abort = (): void => {
			const reason = options.signal?.reason;
			processError ??=
				reason instanceof Error ? reason : new Error("Command was aborted.");
			terminateCommandTree(child, "SIGTERM");
			forceTimer = setTimeout(() => {
				terminateCommandTree(child, "SIGKILL");
			}, options.terminationTimeoutMs ?? 10_000);
			forceTimer.unref();
		};
		const record = (text: string): void => {
			output = `${output}${text}`.slice(-LOG_TAIL_LENGTH);
			options.onOutput(text);
		};
		child.stdout?.on("data", (chunk: Buffer | string) => {
			record(chunk.toString());
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			record(chunk.toString());
		});
		child.once("error", (error) => {
			processError ??= error;
		});
		child.once("close", (code, signal) => {
			if (forceTimer !== undefined) clearTimeout(forceTimer);
			options.signal?.removeEventListener("abort", abort);
			if (processError !== null) reject(processError);
			else if (code === 0) resolve();
			else reject(new Error(exitMessage(basename(command), code, signal, output)));
		});
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
	});
}

function terminateCommandTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {}
		}
		return;
	}
	const args = ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
	const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
	const fallback = (): void => {
		try {
			child.kill(signal);
		} catch {}
	};
	killer.once("error", fallback);
	killer.once("close", (code) => {
		if (code !== 0) fallback();
	});
	killer.unref();
}

function exitMessage(
	name: string,
	code: number | null,
	signal: NodeJS.Signals | null,
	output: string,
): string {
	const reason = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
	const details = output.trim();
	return details
		? `${name} exited with ${reason}. ${details}`
		: `${name} exited with ${reason}.`;
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
