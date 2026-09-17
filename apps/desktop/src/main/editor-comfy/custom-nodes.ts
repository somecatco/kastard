import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	isCustomNodeManagerId,
	isCustomNodeManagerVersion,
	isCustomNodeName,
	normalizeGitHubRepository,
} from "@kastard/common";
import {
	type ComfyRuntimeState,
	type CustomNodeEntry,
	type CustomNodeInstallOptions,
	isComfyUiManagerNode,
	isCustomNodeRepositoryUrl,
} from "../../shared/api";

import {
	inspectGitHubRepository,
	NO_SUPPORTED_CUSTOM_NODE_SOURCE,
} from "./custom-node-git";
import { environmentPython, type RunCommand, runCommand } from "./process";
import { readManagerVersion } from "./runtime";

const LOG_TAIL_LENGTH = 12_000;
export type InstalledCustomNode = Omit<CustomNodeEntry, "sync">;

export type CustomNodeInstallOutcome = {
	node: InstalledCustomNode;
	nodes: InstalledCustomNode[];
	restartRequired: boolean;
};

const MANAGER_OPERATION_TIMEOUT_MS = 120_000;
const MANAGER_OPERATION_POLL_MS = 250;
const CUSTOM_NODE_INVENTORY_TIMEOUT_MS = 10_000;
const REGISTRY_REQUEST_TIMEOUT_MS = 10_000;
const CUSTOM_NODE_INSTALL_TIMEOUT_MS = 15 * 60 * 1_000;
type InspectRepository = (
	directory: string,
) => ReturnType<typeof inspectGitHubRepository>;

type CustomNodesOptions = {
	dataDirectory: string;
	resourcesDirectory: string;
	getRuntimeState: () => ComfyRuntimeState;
	selectedBackendDirectory?: () => Promise<string | null>;
	resolveManagerVersion?: (directory: string) => Promise<string> | string;
	platform?: NodeJS.Platform;
	fetch?: typeof fetch;
	runCommand?: RunCommand;
	terminationTimeoutMs?: number;
	customNodeInventoryTimeoutMs?: number;
	trashItem?: (path: string) => Promise<void>;
	registryApiUrl?: string;
};
export class EditorCustomNodes {
	private readonly platform: NodeJS.Platform;
	private readonly runCommand: RunCommand;
	private readonly requestFetch: typeof fetch;
	private readonly terminationTimeoutMs: number;
	private readonly customNodeInventoryTimeoutMs: number;
	private customNodeInstallController: AbortController | null = null;
	private customNodeInstallPromise: Promise<CustomNodeInstallOutcome> | null = null;
	constructor(private readonly options: CustomNodesOptions) {
		this.platform = options.platform ?? process.platform;
		this.runCommand = options.runCommand ?? runCommand;
		this.requestFetch = options.fetch ?? fetch;
		this.terminationTimeoutMs = options.terminationTimeoutMs ?? 10_000;
		this.customNodeInventoryTimeoutMs =
			options.customNodeInventoryTimeoutMs ?? CUSTOM_NODE_INVENTORY_TIMEOUT_MS;
	}
	cancelInstallation(): Promise<unknown> {
		this.customNodeInstallController?.abort();
		return this.customNodeInstallPromise?.catch(() => undefined) ?? Promise.resolve();
	}
	private bundledBackendDirectory(): string {
		return join(this.options.resourcesDirectory, "backend");
	}
	private inspectRepository(directory: string, signal?: AbortSignal) {
		const python = environmentPython(
			join(this.options.dataDirectory, "environment"),
			this.platform,
		);
		return inspectGitHubRepository(directory, python, signal);
	}
	async listCustomNodes(signal?: AbortSignal): Promise<InstalledCustomNode[]> {
		const directory = join(this.options.dataDirectory, "data", "custom_nodes");
		const inspect = (path: string) => this.inspectRepository(path, signal);
		const state = this.options.getRuntimeState();
		const url = state.status === "ready" ? state.url : null;
		if (url === null) {
			return localInstalledCustomNodes(directory, inspect);
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
				inspect,
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
		const failures: string[] = [];
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
							const nextOutput = `${output}${text}`;
							for (const failure of managerCommandFailureLines(nextOutput)) {
								if (failures.length >= 3) break;
								if (!failures.includes(failure)) failures.push(failure);
							}
							output = nextOutput.slice(-LOG_TAIL_LENGTH);
						},
						signal: controller.signal,
						terminationTimeoutMs: this.terminationTimeoutMs,
					},
				);
			} catch (error) {
				commandError = error;
			}
			controller.signal.throwIfAborted();
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
						(path) => this.inspectRepository(path),
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

	async removeCustomNode(
		name: string,
		signal?: AbortSignal,
	): Promise<{ restartRequired: boolean }> {
		if (!isCustomNodeName(name)) throw new Error("Invalid custom-node package name.");
		const state = this.options.getRuntimeState();
		const matches = (await this.listCustomNodes(signal)).filter(
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
			await this.uninstallWithManager(state.url, node, signal);
		} else {
			const trashItem = this.options.trashItem;
			if (trashItem === undefined) {
				throw new Error("The operating-system Trash is unavailable.");
			}
			const directory = join(this.options.dataDirectory, "data", "custom_nodes");
			const path = await customNodePath(directory, name);
			signal?.throwIfAborted();
			await trashItem(path);
		}
		return { restartRequired: state.status === "ready" };
	}

	private async uninstallWithManager(
		url: string,
		node: InstalledCustomNode,
		signal?: AbortSignal,
	): Promise<void> {
		const timeout = AbortSignal.timeout(MANAGER_OPERATION_TIMEOUT_MS);
		const requestSignal =
			signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
		try {
			const taskId = `kastard-${randomUUID()}`;
			await expectManagerResponse(
				await this.requestFetch(new URL("v2/manager/queue/task", url), {
					method: "POST",
					signal: requestSignal,
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
					signal: requestSignal,
				}),
				"start the uninstall",
				[200, 201],
			);

			const deadline = Date.now() + MANAGER_OPERATION_TIMEOUT_MS;
			while (Date.now() < deadline) {
				requestSignal.throwIfAborted();
				const history = await this.requestFetch(
					new URL(`v2/manager/queue/history?ui_id=${encodeURIComponent(taskId)}`, url),
					{ signal: requestSignal },
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
		} catch (error) {
			if (!timeout.aborted || signal?.aborted) throw error;
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
	trashItem: CustomNodesOptions["trashItem"],
	inspect: InspectRepository,
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
				return (await customNodePathMatchesInstall(
					path,
					repositoryId,
					managerId,
					inspect,
				))
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
	inspect: InspectRepository,
): Promise<boolean> {
	const metadata = await inspectCnrPackage(path);
	if (metadata !== null) {
		if (managerId !== null && metadata.name === managerId) return true;
		return (
			metadata.repository !== undefined &&
			normalizeGitHubRepository(metadata.repository)?.id === repositoryId
		);
	}
	const github = await inspect(path);
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
	inspect: InspectRepository,
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
		...active.map((entry) => localInstalledCustomNode(directory, entry.name, inspect)),
		...suffixedDisabled.map(async (entry) => ({
			...(await localInstalledCustomNode(directory, entry.name, inspect)),
			name: entry.name.slice(0, -".disabled".length),
		})),
		...nestedDisabled.map((entry) =>
			localInstalledCustomNode(disabledDirectory, entry.name, inspect),
		),
	]);
	return nodes.sort((left, right) =>
		left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
	);
}

async function localInstalledCustomNode(
	directory: string,
	name: string,
	inspect: InspectRepository,
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
	const github = await inspect(path);
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
	inspect: InspectRepository,
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
				const github = await inspect(path);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
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
