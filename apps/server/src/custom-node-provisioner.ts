import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	CUSTOM_NODE_SYNC_CONTRACT_VERSION,
	type CustomNodeInventoryEntry,
	type CustomNodeRemovalRequest,
	type CustomNodeSyncNodeSnapshot,
	type CustomNodeSyncOperationKind,
	type CustomNodeSyncRequest,
	type CustomNodeSyncState,
	type CustomNodeSyncTarget,
	customNodeInventoryId,
	customNodeSyncNodeSnapshot,
	gitCustomNodeState,
	gitCustomNodeVersion,
	isCustomNodeManagerId,
	isCustomNodeManagerVersion,
	parseCustomNodeRemovalRequest,
	parseCustomNodeSyncRequest,
	ROOT_GIT_STATUS_ARGS,
	sameCustomNodeInventoryEntry,
} from "@kastard/common";
import type { BackendProvisionerApi } from "./backend-provisioner";
import { ProcessOutputLineBuffer, type ProcessOutputStream } from "./process-output";
import type { ServerLogStore } from "./server-log";
import type { CollectionVerification, VerificationProblem } from "./sync-verification";
import { workerChildEnvironment } from "./worker-child-environment";

const INSTALL_TIMEOUT_MS = 15 * 60 * 1_000;
const INSTALLATION_RECORD_NAME = "custom-node-installations.json";
// ComfyUI Manager 4.2.2 does not expose --user-directory on its uninstall
// command, so cleanup must use the same Python context and purge as reinstall.
const MANAGER_UNINSTALL_SCRIPT = [
	"import sys",
	"from cm_cli.__main__ import cmd_ctx, uninstall_node, unified_manager",
	"cmd_ctx.set_user_directory(sys.argv[1])",
	"cmd_ctx.set_channel_mode(None, 'cache')",
	"for target in sys.argv[2:]:",
	"    node_name = target.split('@', 1)[0]",
	"    uninstall_node(target)",
	"    unified_manager.purge_node_state(node_name)",
].join("\n");

type ConfirmedInstallations = {
	managerVersion: string;
	confirmedNodes: CustomNodeSyncTarget[];
};

export type { CustomNodeSyncState } from "@kastard/common";

export interface CustomNodeProvisionerApi {
	getState(): CustomNodeSyncState;
	verify(request: unknown): Promise<CollectionVerification>;
	sync(request: unknown): CustomNodeSyncState;
	reinstall(request: unknown): CustomNodeSyncState;
	remove(request: unknown): CustomNodeSyncState;
	cancel(operationId?: string): CustomNodeSyncState;
}

type CommandOutput = (stream: ProcessOutputStream, line: string) => void;

type RunCommandOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	onOutput?: CommandOutput;
	returnOutput?: "combined" | "stdout";
	signal?: AbortSignal;
};

type RunCommand = (
	command: string[],
	options: RunCommandOptions & { signal: AbortSignal },
) => Promise<string>;

type PrepareManagerDirectory = (
	rootDirectory: string,
	managerDirectory: string,
) => Promise<void>;

type RunManagerBatch = (
	action: "disable" | "enable" | "install" | "fix" | "uninstall",
	targets: string[],
	extraArguments?: string[],
) => Promise<Error | null>;

type CustomNodeProvisionerOptions = {
	rootDirectory: string;
	runtimePython: string;
	backend: BackendProvisionerApi;
	logs: ServerLogStore;
	runCommand?: RunCommand;
	prepareManagerDirectory?: PrepareManagerDirectory;
	sourceEnvironment?: NodeJS.ProcessEnv;
};

type ActiveCustomNodeOperation = {
	id: string;
	kind: CustomNodeSyncOperationKind;
	target: CustomNodeSyncRequest;
	removalNode?: CustomNodeInventoryEntry;
	controller: AbortController;
};

function createCustomNodeOperation(
	target: CustomNodeSyncRequest,
	kind: CustomNodeSyncOperationKind,
	removalNode?: CustomNodeInventoryEntry,
): ActiveCustomNodeOperation {
	return {
		id: randomUUID(),
		kind,
		target,
		...(removalNode === undefined ? {} : { removalNode }),
		controller: new AbortController(),
	};
}

function operationState(operation: ActiveCustomNodeOperation): {
	contractVersion: typeof CUSTOM_NODE_SYNC_CONTRACT_VERSION;
	capabilities: { forceReinstall: true; remove: true };
	target: CustomNodeSyncRequest;
	operationId: string;
	operationKind: CustomNodeSyncOperationKind;
	removalNode?: CustomNodeInventoryEntry;
} {
	return {
		contractVersion: CUSTOM_NODE_SYNC_CONTRACT_VERSION,
		capabilities: { forceReinstall: true, remove: true },
		target: operation.target,
		operationId: operation.id,
		operationKind: operation.kind,
		...(operation.removalNode === undefined
			? {}
			: { removalNode: operation.removalNode }),
	};
}

export class CustomNodeSyncError extends Error {
	constructor(
		message: string,
		readonly statusCode: 400 | 409,
	) {
		super(message);
	}
}

export class CustomNodeProvisionerUnavailableError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

export class CustomNodeProvisionerController implements CustomNodeProvisionerApi {
	private provisioner: CustomNodeProvisionerApi | null = null;
	private error = "Custom node synchronization is initializing.";
	private retryable = true;

	attach(provisioner: CustomNodeProvisionerApi): void {
		this.provisioner = provisioner;
	}

	fail(error: string): void {
		this.provisioner = null;
		this.error = error;
		this.retryable = false;
	}

	getState(): CustomNodeSyncState {
		return this.current().getState();
	}

	verify(request: unknown): Promise<CollectionVerification> {
		return this.current().verify(request);
	}

	sync(request: unknown): CustomNodeSyncState {
		return this.current().sync(request);
	}

	reinstall(request: unknown): CustomNodeSyncState {
		return this.current().reinstall(request);
	}

	remove(request: unknown): CustomNodeSyncState {
		return this.current().remove(request);
	}

	cancel(operationId?: string): CustomNodeSyncState {
		return this.current().cancel(operationId);
	}

	private current(): CustomNodeProvisionerApi {
		if (this.provisioner === null) {
			throw new CustomNodeProvisionerUnavailableError(this.error, this.retryable);
		}
		return this.provisioner;
	}
}

export class CustomNodeProvisioner implements CustomNodeProvisionerApi {
	private state: CustomNodeSyncState = {
		contractVersion: CUSTOM_NODE_SYNC_CONTRACT_VERSION,
		capabilities: { forceReinstall: true, remove: true },
		target: null,
		operationId: null,
		status: "idle",
		nodes: null,
	};
	private readonly rootDirectory: string;
	private readonly runtimePython: string;
	private readonly backend: BackendProvisionerApi;
	private readonly logs: ServerLogStore;
	private readonly runCommand: RunCommand;
	private readonly prepareManagerDirectory: PrepareManagerDirectory;
	private readonly sourceEnvironment: NodeJS.ProcessEnv;
	private activeOperation: ActiveCustomNodeOperation | null = null;
	private activeInventory: CustomNodeInventoryEntry[] | null = null;

	static async create(
		options: CustomNodeProvisionerOptions,
	): Promise<CustomNodeProvisioner> {
		const provisioner = new CustomNodeProvisioner(options);
		const activeInventory = await readActiveInventory(provisioner.rootDirectory).catch(
			() => null,
		);
		provisioner.activeInventory = activeInventory;
		provisioner.state = {
			contractVersion: CUSTOM_NODE_SYNC_CONTRACT_VERSION,
			capabilities: { forceReinstall: true, remove: true },
			target: null,
			operationId: null,
			status: "idle",
			nodes: activeInventory,
		};
		return provisioner;
	}

	constructor(options: CustomNodeProvisionerOptions) {
		this.rootDirectory = validateRootDirectory(options.rootDirectory);
		this.runtimePython = options.runtimePython;
		this.backend = options.backend;
		this.logs = options.logs;
		this.runCommand = options.runCommand ?? runCommand;
		this.prepareManagerDirectory =
			options.prepareManagerDirectory ?? prepareManagerDirectory;
		this.sourceEnvironment = options.sourceEnvironment ?? process.env;
	}

	getState(): CustomNodeSyncState {
		return this.state;
	}

	async verify(value: unknown): Promise<CollectionVerification> {
		const request = validateRequest(value);
		if (this.state.status === "syncing" || this.state.status === "canceling") {
			return { status: "syncing" };
		}
		try {
			const managerDirectory = join(this.rootDirectory, ".kastard", "comfyui-manager");
			const installations = await readConfirmedInstallations(managerDirectory);
			return await this.verifyInstallations(request, installations);
		} catch {
			return {
				status: "unavailable",
				error: "Could not inspect active Worker custom nodes.",
			};
		}
	}

	private async verifyInstallations(
		request: CustomNodeSyncRequest,
		installations: ConfirmedInstallations | null,
	): Promise<CollectionVerification> {
		const inventory = await readActiveInventory(this.rootDirectory);
		const problems: VerificationProblem[] = [];
		if (this.state.status === "failed" || this.state.status === "canceled") {
			problems.push({
				reason: "conflict",
				name: "Custom node synchronization",
				expected: "Successful synchronization",
				actual:
					this.state.status === "failed"
						? this.state.error
						: "Synchronization was canceled before completion.",
			});
		}
		if (installations?.managerVersion !== request.managerVersion) {
			problems.push({
				reason: "version-mismatch",
				name: "ComfyUI Manager",
				expected: request.managerVersion,
				actual: installations?.managerVersion ?? null,
			});
		}
		const confirmed = new Map(
			(installations?.confirmedNodes ?? []).map((node) => [node.id, node] as const),
		);
		const active = activeInventoryById(inventory);
		for (const node of request.nodes) {
			const entries = active.get(node.id);
			if (entries !== undefined && entries.length > 1) {
				problems.push({
					reason: "conflict",
					name: node.id,
					expected: "One active package",
					actual: `${entries.length} active packages`,
				});
			}
			const confirmedNode = confirmed.get(node.id);
			if (confirmedNode === undefined || !sameTarget(confirmedNode, node)) {
				problems.push({
					reason: "stale",
					name: node.id,
					expected: node.version,
					actual: confirmedNode?.version ?? null,
				});
			}
			const installed = entries?.[0];
			if (installed === undefined) {
				problems.push({
					reason: "missing",
					name: node.id,
					expected: node.version,
					actual: null,
				});
			} else if (installed.version !== node.version) {
				problems.push({
					reason: "version-mismatch",
					name: node.id,
					expected: node.version,
					actual: installed.version,
				});
			}
		}
		return problems.length === 0
			? { status: "synced", total: request.nodes.length }
			: { status: "out-of-sync", total: request.nodes.length, problems };
	}

	sync(request: unknown): CustomNodeSyncState {
		const target = validateRequest(request);
		return this.start(target, "sync");
	}

	reinstall(request: unknown): CustomNodeSyncState {
		const target = validateRequest(request);
		if (target.nodes.length !== 1) {
			throw new CustomNodeSyncError(
				"Force reinstall requires exactly one custom node.",
				400,
			);
		}
		return this.start(target, "reinstall");
	}

	remove(request: unknown): CustomNodeSyncState {
		const removal = validateRemovalRequest(request);
		const removalId = customNodeInventoryId(removal.node);
		if (removal.nodes.some((node) => node.id === removalId)) {
			throw new CustomNodeSyncError(
				"Selected custom nodes cannot be removed from the Worker.",
				409,
			);
		}
		if (this.state.status === "syncing" || this.state.status === "canceling") {
			throw new CustomNodeSyncError("Custom nodes are already synchronizing.", 409);
		}
		if (this.backend.getState().status !== "ready") {
			throw new CustomNodeSyncError(
				"Prepare the Worker ComfyUI backend before removing custom nodes.",
				409,
			);
		}
		const operation = createCustomNodeOperation(removal, "remove", removal.node);
		this.activeOperation = operation;
		const nodeSnapshot = customNodeSyncNodeSnapshot(
			removal.nodes,
			this.activeInventory,
		);
		this.state = {
			...operationState(operation),
			status: "syncing",
			phase: "remove",
			removalPhase: "prepare",
			current: 0,
			total: 1,
			currentNode: removal.node.name,
			...(nodeSnapshot === undefined ? {} : { nodeSnapshot }),
		};
		void this.runRemoval(operation).finally(() => {
			if (this.activeOperation === operation) this.activeOperation = null;
		});
		return this.state;
	}

	private start(
		target: CustomNodeSyncRequest,
		kind: CustomNodeSyncOperationKind,
	): CustomNodeSyncState {
		if (this.state.status === "syncing" || this.state.status === "canceling") {
			throw new CustomNodeSyncError("Custom nodes are already synchronizing.", 409);
		}
		if (this.backend.getState().status !== "ready") {
			throw new CustomNodeSyncError(
				"Prepare the Worker ComfyUI backend before synchronizing custom nodes.",
				409,
			);
		}
		const operation = createCustomNodeOperation(target, kind);
		this.activeOperation = operation;
		const nodeSnapshot = customNodeSyncNodeSnapshot(
			target.nodes,
			this.activeInventory,
			new Set(),
			null,
		);
		this.state = {
			...operationState(operation),
			status: "syncing",
			phase: "install",
			...(kind === "reinstall" ? { reinstallPhase: "prepare" as const } : {}),
			current: 0,
			total: target.nodes.length,
			currentNode: null,
			...(nodeSnapshot === undefined ? {} : { nodeSnapshot }),
		};
		void this.run(operation).finally(() => {
			if (this.activeOperation === operation) this.activeOperation = null;
		});
		return this.state;
	}

	cancel(operationId?: string): CustomNodeSyncState {
		if (operationId !== undefined && this.state.operationId !== operationId) {
			throw new CustomNodeSyncError(
				"The custom node synchronization operation is no longer current.",
				409,
			);
		}
		if (this.state.status === "canceling") return this.state;
		if (this.state.status !== "syncing") return this.state;
		const active = this.activeOperation;
		if (active === null || active.id !== this.state.operationId) {
			throw new CustomNodeSyncError(
				"The custom node synchronization operation is unavailable.",
				409,
			);
		}
		if (active.kind === "remove") return this.state;
		this.state = {
			...operationState(active),
			status: "canceling",
			...(this.state.nodeSnapshot === undefined
				? {}
				: { nodeSnapshot: this.state.nodeSnapshot }),
		};
		const action = active.kind === "reinstall" ? "reinstall" : "synchronization";
		this.logs.write("info", `Canceling custom node ${action}.`);
		active.controller.abort(new Error(`Custom node ${action} was canceled.`));
		return this.state;
	}

	private async runRemoval(operation: ActiveCustomNodeOperation): Promise<void> {
		const node = operation.removalNode;
		if (node === undefined) throw new Error("Custom node removal target is missing.");
		const { signal } = operation.controller;
		let activeInventory = this.activeInventory;
		const updateActiveInventory = (inventory: CustomNodeInventoryEntry[]): void => {
			activeInventory = inventory;
			this.activeInventory = inventory;
		};
		const nodeSnapshot = (): CustomNodeSyncNodeSnapshot | undefined =>
			customNodeSyncNodeSnapshot(operation.target.nodes, activeInventory);
		const setProgress = (removalPhase: "prepare" | "remove"): void => {
			const snapshot = nodeSnapshot();
			this.state = {
				...operationState(operation),
				status: "syncing",
				phase: "remove",
				removalPhase,
				current: 0,
				total: 1,
				currentNode: node.name,
				...(snapshot === undefined ? {} : { nodeSnapshot: snapshot }),
			};
		};

		try {
			const [freshInventory, inactiveInventory] = await Promise.all([
				readActiveInventory(this.rootDirectory),
				readInactiveInventory(this.rootDirectory),
			]);
			updateActiveInventory(freshInventory);
			const matches = freshInventory.filter((entry) =>
				sameCustomNodeInventoryEntry(entry, node),
			);
			if (matches.length !== 1) {
				throw new Error(
					`Worker custom node ${node.name} no longer matches the requested installation. Refresh and try again.`,
				);
			}
			const installedInventory = freshInventory.concat(inactiveInventory);
			assertNoGitHubDirectoryConflicts(operation.target.nodes, installedInventory);
			assertRequestedInventory(
				activeInventoryById(freshInventory),
				operation.target.nodes,
			);
			const removalId = customNodeInventoryId(node);
			const installedMatches = installedInventory.filter(
				(entry) => customNodeInventoryId(entry) === removalId,
			);
			if (installedMatches.length !== 1) {
				throw new Error(
					`Worker custom node ${node.name} has duplicate installations. Remove the duplicate before deleting it from the Worker.`,
				);
			}
			setProgress("prepare");

			const customNodesDirectory = resolve(this.rootDirectory, "custom_nodes");
			const removalPath = resolve(customNodesDirectory, node.name);
			if (dirname(removalPath) !== customNodesDirectory) {
				throw new Error("Worker custom node removal path is invalid.");
			}

			setProgress("remove");
			if (node.managerId !== null || node.repository !== undefined) {
				const backendDirectory = join(this.rootDirectory, "backend");
				const managerDirectory = join(
					this.rootDirectory,
					".kastard",
					"comfyui-manager",
				);
				const environment = customNodeEnvironment(
					this.sourceEnvironment,
					backendDirectory,
					this.rootDirectory,
					managerDirectory,
				);
				const commandOptions = {
					cwd: backendDirectory,
					env: environment,
					timeoutMs: INSTALL_TIMEOUT_MS,
					onOutput: (stream: ProcessOutputStream, line: string) =>
						this.logCommandOutput(stream, line),
					signal,
				};
				await this.prepareManagerDirectory(this.rootDirectory, managerDirectory);
				this.logs.write(
					"info",
					`Installing ComfyUI Manager ${operation.target.managerVersion} with uv.`,
				);
				await this.runCommand(
					[
						"uv",
						"pip",
						"install",
						"--python",
						this.runtimePython,
						`comfyui_manager==${operation.target.managerVersion}`,
					],
					commandOptions,
				);
				const output = await this.runCommand(
					[
						this.runtimePython,
						"-c",
						MANAGER_UNINSTALL_SCRIPT,
						managerDirectory,
						inventoryNodeSpec(node),
					],
					commandOptions,
				);
				const failures = commandFailureLines(output);
				if (failures.length > 0) {
					throw new Error(
						`ComfyUI Manager reported uninstall errors. ${failures.slice(0, 3).join(" ")}`,
					);
				}
			} else {
				await rm(removalPath, { recursive: true, force: false });
			}

			const [refreshedInventory, refreshedInactiveInventory] = await Promise.all([
				readActiveInventory(this.rootDirectory),
				readInactiveInventory(this.rootDirectory),
			]);
			updateActiveInventory(refreshedInventory);
			const remainingInventory = refreshedInventory.concat(refreshedInactiveInventory);
			if (
				remainingInventory.some(
					(entry) =>
						entry.name === node.name || customNodeInventoryId(entry) === removalId,
				)
			) {
				throw new Error(`Could not remove ${node.name} from the Worker.`);
			}
			const managerDirectory = join(this.rootDirectory, ".kastard", "comfyui-manager");
			const installations = await readConfirmedInstallations(managerDirectory);
			if (installations !== null) {
				await writeConfirmedInstallations(
					managerDirectory,
					installations.managerVersion,
					installations.confirmedNodes.filter((target) => target.id !== removalId),
				);
			}
			try {
				assertRequestedInventory(
					activeInventoryById(refreshedInventory),
					operation.target.nodes,
				);
			} catch (error) {
				throw new Error(
					`${node.name} was removed, but the selected custom nodes are not synchronized. ${userFacingError(error)}`,
				);
			}
			const readySnapshot = nodeSnapshot();
			this.state = {
				...operationState(operation),
				status: "ready",
				nodes: operation.target.nodes,
				...(readySnapshot === undefined ? {} : { nodeSnapshot: readySnapshot }),
			};
			this.logs.write("info", `${node.name} was removed from the Worker.`);
		} catch (error) {
			let activeNodes = activeInventory;
			try {
				activeNodes = await readActiveInventory(this.rootDirectory);
				updateActiveInventory(activeNodes);
			} catch {}
			const terminalSnapshot = nodeSnapshot();
			const message = userFacingError(error);
			this.state = {
				...operationState(operation),
				status: "failed",
				nodes: activeNodes,
				error: message,
				...(terminalSnapshot === undefined ? {} : { nodeSnapshot: terminalSnapshot }),
			};
			this.logs.write("error", `Custom node removal failed: ${message}`);
		}
	}

	private async run(operation: ActiveCustomNodeOperation): Promise<void> {
		const { managerVersion, nodes } = operation.target;
		const reinstallNode = operation.kind === "reinstall" ? nodes[0] : undefined;
		const action = reinstallNode === undefined ? "synchronization" : "reinstall";
		const { signal } = operation.controller;
		const failedNodeIds = new Set<string>();
		let activeInventory = this.activeInventory;
		const updateActiveInventory = (inventory: CustomNodeInventoryEntry[]): void => {
			activeInventory = inventory;
			this.activeInventory = inventory;
		};
		const nodeSnapshot = (
			currentNode: CustomNodeSyncTarget | null,
		): CustomNodeSyncNodeSnapshot | undefined =>
			customNodeSyncNodeSnapshot(
				nodes,
				activeInventory,
				failedNodeIds,
				currentNode?.id ?? null,
			);
		const backendDirectory = join(this.rootDirectory, "backend");
		const managerDirectory = join(this.rootDirectory, ".kastard", "comfyui-manager");
		const environment = customNodeEnvironment(
			this.sourceEnvironment,
			backendDirectory,
			this.rootDirectory,
			managerDirectory,
		);
		try {
			await this.prepareManagerDirectory(this.rootDirectory, managerDirectory);
			signal.throwIfAborted();
			const commandOptions = {
				cwd: backendDirectory,
				env: environment,
				timeoutMs: INSTALL_TIMEOUT_MS,
				onOutput: (stream: ProcessOutputStream, line: string) =>
					this.logCommandOutput(stream, line),
				signal,
			};
			this.logs.write("info", `Installing ComfyUI Manager ${managerVersion} with uv.`);
			await this.runCommand(
				[
					"uv",
					"pip",
					"install",
					"--python",
					this.runtimePython,
					`comfyui_manager==${managerVersion}`,
				],
				commandOptions,
			);
			signal.throwIfAborted();
			const initialActiveInventory = await readActiveInventory(this.rootDirectory);
			updateActiveInventory(initialActiveInventory);
			let inactiveInventory = await readInactiveInventory(this.rootDirectory);
			let activeById = activeInventoryById(initialActiveInventory);
			let inactiveById = activeInventoryById(inactiveInventory);
			const previousInstallations = await readConfirmedInstallations(managerDirectory);
			const confirmedNodes = new Map(
				(previousInstallations?.confirmedNodes ?? [])
					.filter((node) => hasExactActiveNode(activeById, node))
					.map((node) => [node.id, node] as const),
			);
			const recordInstallations = async (): Promise<void> =>
				writeConfirmedInstallations(managerDirectory, managerVersion, [
					...confirmedNodes.values(),
				]);
			const reusableIds =
				operation.kind === "reinstall"
					? new Set<string>()
					: new Set(
							nodes
								.filter(
									(node) =>
										hasExactActiveNode(activeById, node) &&
										sameTarget(confirmedNodes.get(node.id), node),
								)
								.map((node) => node.id),
						);
			const installNodes = nodes.filter((node) => !reusableIds.has(node.id));
			const total = nodes.length;
			this.logs.write(
				"info",
				reinstallNode === undefined
					? `Synchronizing ${nodes.length} custom nodes with local Manager ${managerVersion}; installing ${installNodes.length}.`
					: `Force reinstalling ${targetLabel(reinstallNode)} with local Manager ${managerVersion}.`,
			);
			const managerCommand = [this.runtimePython, "-m", "cm_cli"];
			const runManagerBatch = async (
				action: "disable" | "enable" | "install" | "fix" | "uninstall",
				targets: string[],
				extraArguments: string[] = [],
			): Promise<Error | null> => {
				try {
					const command =
						action === "uninstall"
							? [
									this.runtimePython,
									"-c",
									MANAGER_UNINSTALL_SCRIPT,
									managerDirectory,
									...targets,
								]
							: [
									...managerCommand,
									action,
									...targets,
									"--mode",
									"cache",
									"--user-directory",
									managerDirectory,
									...extraArguments,
								];
					const output = await this.runCommand(command, {
						...commandOptions,
						timeoutMs: INSTALL_TIMEOUT_MS * Math.max(1, targets.length),
					});
					const failures = commandFailureLines(output);
					return failures.length === 0
						? null
						: new Error(
								`ComfyUI Manager reported ${action} errors. ${failures.slice(0, 3).join(" ")}`,
							);
				} catch (error) {
					if (signal.aborted) throw error;
					return error instanceof Error ? error : new Error(String(error));
				}
			};
			let completed = reusableIds.size;
			const problems: string[] = [];
			const setProgress = (
				currentNode: CustomNodeSyncTarget | null,
				reinstallPhase: "remove" | "install" = "install",
			): void => {
				const snapshot = nodeSnapshot(currentNode);
				this.state = {
					...operationState(operation),
					status: "syncing",
					phase: "install",
					...(operation.kind === "reinstall" ? { reinstallPhase } : {}),
					current: completed,
					total,
					currentNode: currentNode === null ? null : targetLabel(currentNode),
					...(snapshot === undefined ? {} : { nodeSnapshot: snapshot }),
				};
			};
			for (const node of installNodes) confirmedNodes.delete(node.id);
			await recordInstallations();
			assertNoGitHubDirectoryConflicts(
				nodes,
				initialActiveInventory.concat(inactiveInventory),
			);
			const installCandidates: CustomNodeSyncTarget[] = [];
			if (reinstallNode !== undefined) {
				const activeEntries = activeById.get(reinstallNode.id) ?? [];
				const inactiveEntries = inactiveById.get(reinstallNode.id) ?? [];
				const installedEntries = activeEntries.concat(inactiveEntries);
				if (installedEntries.length > 1) {
					failedNodeIds.add(reinstallNode.id);
					problems.push(
						`Duplicate installed custom node ID: ${reinstallNode.id}. Remove the duplicate before reinstalling.`,
					);
					completed += 1;
				} else {
					const installedEntry = installedEntries[0];
					if (installedEntry !== undefined) {
						setProgress(reinstallNode, "remove");
						const uninstallTarget = installedNodeSpec(reinstallNode, installedEntry);
						this.logs.write("info", `Removing ${uninstallTarget} for reinstall.`);
						const error = await runManagerBatch("uninstall", [uninstallTarget]);
						signal.throwIfAborted();
						const [refreshedActiveInventory, refreshedInactiveInventory] =
							await Promise.all([
								readActiveInventory(this.rootDirectory),
								readInactiveInventory(this.rootDirectory),
							]);
						updateActiveInventory(refreshedActiveInventory);
						activeById = activeInventoryById(refreshedActiveInventory);
						inactiveInventory = refreshedInactiveInventory;
						inactiveById = activeInventoryById(refreshedInactiveInventory);
						if (
							error !== null ||
							activeById.has(reinstallNode.id) ||
							inactiveById.has(reinstallNode.id)
						) {
							failedNodeIds.add(reinstallNode.id);
							problems.push(
								`Could not remove ${reinstallNode.id} for reinstall.${
									error === null ? "" : ` ${userFacingError(error)}`
								}`,
							);
							completed += 1;
						} else {
							installCandidates.push(reinstallNode);
						}
					} else {
						installCandidates.push(reinstallNode);
					}
				}
			} else {
				const disabledNodes: CustomNodeSyncTarget[] = [];
				const disableErrors = new Map<string, Error>();
				for (const node of installNodes) {
					signal.throwIfAborted();
					setProgress(node);
					const existing = activeById.get(node.id);
					if (existing !== undefined && existing.length > 1) {
						failedNodeIds.add(node.id);
						problems.push(
							`Duplicate active custom node ID: ${node.id}. Disable the duplicate before synchronizing.`,
						);
						completed += 1;
						continue;
					}

					if (node.repository === undefined && existing !== undefined) {
						const disableTarget = installedNodeSpec(node, existing[0]);
						this.logs.write("info", `Preparing ${disableTarget} for reinstall.`);
						const error = await runManagerBatch("disable", [disableTarget]);
						if (error !== null) disableErrors.set(node.id, error);
						disabledNodes.push(node);
						continue;
					}
					installCandidates.push(node);
				}

				if (disabledNodes.length > 0) {
					signal.throwIfAborted();
					const refreshedInventory = await readActiveInventory(this.rootDirectory);
					updateActiveInventory(refreshedInventory);
					activeById = activeInventoryById(refreshedInventory);
					for (const node of disabledNodes) {
						const error = disableErrors.get(node.id);
						if (error !== undefined || activeById.has(node.id)) {
							failedNodeIds.add(node.id);
							problems.push(
								`Could not prepare ${node.id} for reinstall.${
									error === undefined ? "" : ` ${userFacingError(error)}`
								}`,
							);
							completed += 1;
						} else {
							installCandidates.push(node);
						}
					}
				}
			}

			const confirmInstalledNode = (
				node: CustomNodeSyncTarget,
				managerError: Error | null,
			): void => {
				if (managerError !== null) {
					failedNodeIds.add(node.id);
					problems.push(`${node.id}: ${userFacingError(managerError)}`);
				} else if (!hasExactActiveNode(activeById, node)) {
					failedNodeIds.add(node.id);
					const actual = activeById
						.get(node.id)
						?.map((entry) => entry.version ?? "unknown")
						.join(", ");
					problems.push(
						`${node.id} (expected ${node.version}, found ${actual ?? "missing"}).`,
					);
				} else {
					confirmedNodes.set(node.id, node);
				}
			};
			const installNode = async (node: CustomNodeSyncTarget): Promise<void> => {
				signal.throwIfAborted();
				setProgress(node);
				this.logs.write("info", `Installing ${targetLabel(node)}.`);
				let managerError: Error | null;
				if (node.repository === undefined) {
					managerError = await runManagerBatch(
						"install",
						[managerNodeSpec(node)],
						["--exit-on-fail"],
					);
				} else {
					try {
						managerError = await synchronizeGitHubNode(
							node,
							this.rootDirectory,
							activeById.get(node.id),
							inactiveById.get(node.id),
							commandOptions,
							runManagerBatch,
							this.runCommand,
						);
					} catch (error) {
						if (signal.aborted) throw error;
						managerError = error instanceof Error ? error : new Error(String(error));
					}
				}
				completed += 1;
				const refreshedInventory = await refreshActiveInventoryForNode(
					this.rootDirectory,
					node,
					[...activeById.values()].flat(),
				);
				updateActiveInventory(refreshedInventory);
				activeById = activeInventoryById(refreshedInventory);
				confirmInstalledNode(node, managerError);
				await recordInstallations();
				setProgress(null);
			};
			const managerInstallCandidates = installCandidates.filter(
				(node) => node.repository === undefined,
			);
			const githubInstallCandidates = installCandidates.filter(
				(node) => node.repository !== undefined,
			);
			for (const node of managerInstallCandidates) await installNode(node);
			if (githubInstallCandidates.length > 0) {
				assertNoGitHubDirectoryConflicts(
					githubInstallCandidates,
					[...activeById.values()].flat().concat(inactiveInventory),
				);
				for (const node of githubInstallCandidates) await installNode(node);
				signal.throwIfAborted();
			}

			signal.throwIfAborted();
			setProgress(null);
			if (problems.length > 0) {
				throw new Error(
					`Custom node ${action} did not complete: ${summarizeTargets(problems)}`,
				);
			}
			assertRequestedInventory(activeById, nodes);
			signal.throwIfAborted();
			const readySnapshot = nodeSnapshot(null);
			this.state = {
				...operationState(operation),
				status: "ready",
				nodes,
				...(readySnapshot === undefined ? {} : { nodeSnapshot: readySnapshot }),
			};
			this.logs.write(
				"info",
				reinstallNode === undefined
					? `${nodes.length} custom ${nodes.length === 1 ? "node is" : "nodes are"} synchronized.`
					: `${targetLabel(reinstallNode)} was reinstalled.`,
			);
		} catch (error) {
			const failure = error;
			let activeNodes = activeInventory;
			try {
				activeNodes = await readActiveInventory(this.rootDirectory);
				updateActiveInventory(activeNodes);
			} catch {}
			const terminalSnapshot = nodeSnapshot(null);
			if (signal.aborted) {
				this.state = {
					...operationState(operation),
					status: "canceled",
					nodes: activeNodes,
					...(terminalSnapshot === undefined ? {} : { nodeSnapshot: terminalSnapshot }),
				};
				this.logs.write(
					"info",
					operation.kind === "reinstall"
						? "Custom node reinstall was canceled."
						: "Custom node synchronization was canceled.",
				);
				return;
			}
			const message = userFacingError(failure);
			this.state = {
				...operationState(operation),
				status: "failed",
				nodes: activeNodes,
				error: message,
				...(terminalSnapshot === undefined ? {} : { nodeSnapshot: terminalSnapshot }),
			};
			this.logs.write(
				"error",
				`${operation.kind === "reinstall" ? "Custom node reinstall" : "Custom node synchronization"} failed: ${message}`,
			);
		}
	}

	private logCommandOutput(stream: ProcessOutputStream, line: string): void {
		this.logs.write("info", `[${stream}] ${line}`);
	}
}

async function synchronizeGitHubNode(
	node: CustomNodeSyncTarget,
	rootDirectory: string,
	activeEntries: CustomNodeInventoryEntry[] | undefined,
	inactiveEntries: CustomNodeInventoryEntry[] | undefined,
	commandOptions: RunCommandOptions & { signal: AbortSignal },
	runManagerBatch: RunManagerBatch,
	runCommand: RunCommand,
): Promise<Error | null> {
	const expectedRepository = node.repository;
	if (expectedRepository === undefined) {
		return new Error(`Missing GitHub repository for ${node.id}.`);
	}
	try {
		let managerError: Error | null = null;
		let directoryName = activeEntries?.[0]?.name;
		if (activeEntries === undefined) {
			const inactiveEntry = inactiveEntries?.[0];
			if (inactiveEntries?.length === 1 && inactiveEntry !== undefined) {
				managerError = await runManagerBatch("enable", [
					managerNodeSpec(node, inactiveEntry),
				]);
				directoryName = inactiveEntry.name;
			} else if (inactiveEntries !== undefined) {
				throw new Error(`Duplicate inactive GitHub custom node: ${node.id}.`);
			}
		}
		if (directoryName === undefined) {
			const installError = await runManagerBatch(
				"install",
				[expectedRepository],
				["--no-deps", "--exit-on-fail"],
			);
			managerError ??= installError;
			directoryName = node.id.split("/")[1];
		}
		if (directoryName === undefined) {
			throw new Error(`GitHub custom node installation did not produce ${node.id}.`);
		}
		const directory = join(rootDirectory, "custom_nodes", directoryName);
		const entry = await lstat(directory);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`Worker GitHub custom node must be a directory: ${node.id}.`);
		}
		const runGit = (...args: string[]) =>
			runCommand(gitCommand(directory, args), {
				...commandOptions,
				env: {
					...commandOptions.env,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_OPTIONAL_LOCKS: "0",
					GIT_TERMINAL_PROMPT: "0",
				},
				returnOutput: "stdout",
			});
		const [origin, commit, status, topLevel] = await Promise.all([
			runGit("config", "--get", "remote.origin.url"),
			runGit("rev-parse", "--verify", "HEAD"),
			runGit(...ROOT_GIT_STATUS_ARGS),
			runGit("rev-parse", "--show-toplevel"),
		]);
		const state = gitCustomNodeState({
			origin,
			commit,
			status,
			directory: await realpath(directory),
			repositoryRoot: await realpath(topLevel),
		});
		if (state === null || state.repository !== expectedRepository) {
			throw new Error(`Worker GitHub custom node repository differs: ${node.id}.`);
		}
		if (!state.isRepositoryRoot) {
			throw new Error(
				`Worker GitHub custom node must be a repository root: ${node.id}.`,
			);
		}
		if (state.hasRootChanges) {
			throw new Error(
				`Worker GitHub custom node has local changes: ${node.id}. Restore or remove them before synchronizing.`,
			);
		}
		try {
			await runGit("cat-file", "-e", `${node.version}^{commit}`);
		} catch {
			const objectDirectory = resolve(
				directory,
				await runGit("rev-parse", "--git-path", "objects"),
			);
			try {
				await fetchGitHubCommit(
					objectDirectory,
					expectedRepository,
					node.version,
					commandOptions,
					runCommand,
				);
			} catch (error) {
				if (commandOptions.signal.aborted) throw error;
				throw new Error(
					`Worker could not fetch the requested GitHub commit: ${node.id}.`,
				);
			}
		}
		if (await hasIgnoredCheckoutConflict(runGit, node.version)) {
			throw new Error(
				`Worker GitHub custom node has ignored files that conflict with the requested version: ${node.id}. Remove the conflicting files before synchronizing.`,
			);
		}
		try {
			await runGit("checkout", "--no-overwrite-ignore", "--detach", node.version);
		} catch (error) {
			if (commandOptions.signal.aborted) throw error;
			throw new Error(
				`Worker could not check out the requested GitHub commit: ${node.id}.`,
			);
		}
		return (await runManagerBatch("fix", [`${directoryName}@unknown`])) ?? managerError;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

async function hasIgnoredCheckoutConflict(
	runGit: (...args: string[]) => Promise<string>,
	version: string,
): Promise<boolean> {
	const [ignored, target] = await Promise.all([
		runGit("ls-files", "--others", "--ignored", "--exclude-standard", "-z"),
		runGit("ls-tree", "-r", "--name-only", "-z", version),
	]);
	const targetFiles = new Set(target.split("\0"));
	return ignored.split("\0").some((path) => path !== "" && targetFiles.has(path));
}

async function fetchGitHubCommit(
	objectDirectory: string,
	repository: string,
	commit: string,
	commandOptions: RunCommandOptions & { signal: AbortSignal },
	runCommand: RunCommand,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "kastard-worker-git-fetch-"));
	const environment = {
		...commandOptions.env,
		HOME: directory,
		XDG_CONFIG_HOME: directory,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
	};
	try {
		await runCommand(gitCommand(directory, ["init", "--bare"]), {
			...commandOptions,
			env: environment,
			returnOutput: "stdout",
		});
		await runCommand(
			gitCommand(directory, [
				"fetch",
				"--force",
				"--no-write-fetch-head",
				repository,
				commit,
			]),
			{
				...commandOptions,
				env: { ...environment, GIT_OBJECT_DIRECTORY: objectDirectory },
				returnOutput: "stdout",
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function managerNodeSpec(
	node: CustomNodeSyncTarget,
	entry?: CustomNodeInventoryEntry,
): string {
	return node.repository === undefined
		? `${node.id}@${node.version}`
		: `${entry?.name ?? node.id.split("/")[1]}@unknown`;
}

function installedNodeSpec(
	node: CustomNodeSyncTarget,
	entry?: CustomNodeInventoryEntry,
): string {
	if (node.repository !== undefined) return managerNodeSpec(node, entry);
	return `${(entry?.managerId ?? node.id).toLowerCase()}@${entry?.version ?? node.version}`;
}

function inventoryNodeSpec(node: CustomNodeInventoryEntry): string {
	if (node.repository !== undefined) return `${node.name}@unknown`;
	return `${(node.managerId ?? node.name).toLowerCase()}@${node.version ?? "unknown"}`;
}

function targetLabel(node: CustomNodeSyncTarget): string {
	return node.repository === undefined
		? `${node.id}@${node.version}`
		: `${node.id}@${node.version.slice(0, 12)}`;
}

function customNodeEnvironment(
	source: NodeJS.ProcessEnv,
	backendDirectory: string,
	rootDirectory: string,
	managerDirectory: string,
): NodeJS.ProcessEnv {
	return workerChildEnvironment(source, {
		HOME: managerDirectory,
		XDG_CACHE_HOME: join(managerDirectory, "cache"),
		PYTHONPYCACHEPREFIX: join(managerDirectory, "cache", "python-bytecode"),
		COMFYUI_PATH: backendDirectory,
		COMFYUI_FOLDERS_BASE_PATH: rootDirectory,
	});
}

async function prepareManagerDirectory(
	rootDirectory: string,
	managerDirectory: string,
): Promise<void> {
	await mkdir(managerDirectory, { recursive: true });
	await writeFile(
		join(managerDirectory, "extra_model_paths.yaml"),
		[
			"kastard:",
			`  base_path: ${JSON.stringify(rootDirectory)}`,
			"  is_default: true",
			"  custom_nodes: custom_nodes",
			"",
		].join("\n"),
		"utf8",
	);
}

async function readConfirmedInstallations(
	managerDirectory: string,
): Promise<ConfirmedInstallations | null> {
	const current = await readJsonRecord(
		join(managerDirectory, INSTALLATION_RECORD_NAME),
	);
	if (current === null) return null;
	try {
		if (!isRecord(current) || !("confirmedNodes" in current)) throw new Error();
		const manager = validateRequest({
			managerVersion: current.managerVersion,
			nodes: [],
		});
		return {
			managerVersion: manager.managerVersion,
			confirmedNodes: validateStoredTargets(
				manager.managerVersion,
				current.confirmedNodes,
			),
		};
	} catch {
		throw new Error("Stored custom node installations are invalid.");
	}
}

function validateStoredTargets(
	managerVersion: string,
	value: unknown,
): CustomNodeSyncTarget[] {
	if (!Array.isArray(value)) throw new Error();
	const targets: CustomNodeSyncTarget[] = [];
	const ids = new Set<string>();
	const githubDirectoryNames = new Set<string>();
	for (const storedTarget of value) {
		const target = validateRequest({ managerVersion, nodes: [storedTarget] }).nodes[0];
		if (target === undefined || ids.has(target.id)) throw new Error();
		if (target.repository !== undefined) {
			const directoryName = target.id.split("/")[1];
			if (directoryName === undefined || githubDirectoryNames.has(directoryName)) {
				throw new Error();
			}
			githubDirectoryNames.add(directoryName);
		}
		ids.add(target.id);
		targets.push(target);
	}
	return targets;
}

async function readJsonRecord(path: string): Promise<unknown | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error("Stored custom node installations are invalid.");
	}
}

async function writeConfirmedInstallations(
	managerDirectory: string,
	managerVersion: string,
	confirmedNodes: CustomNodeSyncTarget[],
): Promise<void> {
	const path = join(managerDirectory, INSTALLATION_RECORD_NAME);
	const temporaryPath = `${path}.tmp`;
	await writeFile(
		temporaryPath,
		`${JSON.stringify({ managerVersion, confirmedNodes })}\n`,
		"utf8",
	);
	await rename(temporaryPath, path);
}

function assertRequestedInventory(
	active: Map<string, CustomNodeInventoryEntry[]>,
	nodes: CustomNodeSyncTarget[],
): void {
	const duplicate = nodes.find((node) => (active.get(node.id)?.length ?? 0) > 1);
	if (duplicate !== undefined) {
		throw new Error(
			`Duplicate active custom node ID: ${duplicate.id}. Disable the duplicate before synchronizing.`,
		);
	}
	const missing = nodes.filter((node) => !active.has(node.id));
	if (missing.length > 0) {
		throw new Error(
			`Requested custom nodes are missing: ${missing
				.slice(0, 5)
				.map((node) => node.id)
				.join(", ")}.`,
		);
	}
	const versionMismatches = nodes.filter((node) => {
		const installed = active.get(node.id)?.[0];
		return installed !== undefined && installed.version !== node.version;
	});
	if (versionMismatches.length > 0) {
		throw new Error(
			`Custom node versions do not match the request: ${versionMismatches
				.slice(0, 5)
				.map((node) => {
					const installed = active.get(node.id)?.[0];
					return `${node.id} (expected ${node.version}, found ${installed?.version ?? "unknown"})`;
				})
				.join(", ")}.`,
		);
	}
}

function activeInventoryById(
	inventory: CustomNodeInventoryEntry[],
): Map<string, CustomNodeInventoryEntry[]> {
	const active = new Map<string, CustomNodeInventoryEntry[]>();
	for (const entry of inventory) {
		const id = customNodeInventoryId(entry);
		const entries = active.get(id) ?? [];
		entries.push(entry);
		active.set(id, entries);
	}
	return active;
}

function hasExactActiveNode(
	inventory: Map<string, CustomNodeInventoryEntry[]>,
	node: CustomNodeSyncTarget,
): boolean {
	const entries = inventory.get(node.id);
	return entries?.length === 1 && entries[0]?.version === node.version;
}

function sameTarget(
	left: CustomNodeSyncTarget | undefined,
	right: CustomNodeSyncTarget,
): boolean {
	return (
		left?.id === right.id &&
		left.version === right.version &&
		left.repository === right.repository
	);
}

function summarizeTargets(targets: string[]): string {
	const visible = targets.slice(0, 5).join(", ");
	const remaining = targets.length - 5;
	return remaining > 0 ? `${visible}, and ${remaining} more` : visible;
}

async function readActiveInventory(
	rootDirectory: string,
): Promise<CustomNodeInventoryEntry[]> {
	const customNodesDirectory = join(rootDirectory, "custom_nodes");
	const active = await readActiveNodeDirectoryEntries(customNodesDirectory);
	const inventory = await Promise.all(
		active.map(async (entry) => ({
			name: entry.name,
			...(await installedNodeMetadata(customNodesDirectory, entry)),
		})),
	);
	return inventory.sort((left, right) => left.name.localeCompare(right.name));
}

async function refreshActiveInventoryForNode(
	rootDirectory: string,
	node: CustomNodeSyncTarget,
	previousInventory: CustomNodeInventoryEntry[],
): Promise<CustomNodeInventoryEntry[]> {
	const customNodesDirectory = join(rootDirectory, "custom_nodes");
	const activeEntries = await readActiveNodeDirectoryEntries(customNodesDirectory);
	const activeNames = new Set(activeEntries.map((entry) => entry.name));
	const previousNames = new Set(previousInventory.map((entry) => entry.name));
	const refreshNames = new Set<string>([
		node.repository === undefined ? node.id : (node.id.split("/")[1] ?? node.id),
	]);
	for (const entry of previousInventory) {
		if (customNodeInventoryId(entry) === node.id) refreshNames.add(entry.name);
	}
	for (const entry of activeEntries) {
		if (!previousNames.has(entry.name)) refreshNames.add(entry.name);
	}
	const refreshed = await Promise.all(
		activeEntries
			.filter((entry) => refreshNames.has(entry.name))
			.map(async (entry) => ({
				name: entry.name,
				...(await installedNodeMetadata(customNodesDirectory, entry)),
			})),
	);
	return previousInventory
		.filter((entry) => activeNames.has(entry.name) && !refreshNames.has(entry.name))
		.concat(refreshed)
		.sort((left, right) => left.name.localeCompare(right.name));
}

async function readActiveNodeDirectoryEntries(
	customNodesDirectory: string,
): Promise<Dirent[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(customNodesDirectory, {
			withFileTypes: true,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		entries = [];
	}
	return entries.filter(
		(entry) =>
			entry.name !== "__pycache__" &&
			entry.name !== ".disabled" &&
			!entry.name.endsWith(".disabled") &&
			(entry.isDirectory() ||
				entry.isSymbolicLink() ||
				(entry.isFile() && entry.name.endsWith(".py"))),
	);
}

async function readInactiveInventory(
	rootDirectory: string,
): Promise<CustomNodeInventoryEntry[]> {
	const customNodesDirectory = join(rootDirectory, "custom_nodes");
	let entries: Dirent[];
	try {
		entries = await readdir(customNodesDirectory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return [];
	}
	const disabledEntries = entries.filter(
		(entry) =>
			entry.isDirectory() &&
			entry.name !== ".disabled" &&
			entry.name.endsWith(".disabled"),
	);
	const disabledDirectory = entries.find(
		(entry) => entry.isDirectory() && entry.name === ".disabled",
	);
	const nestedEntries =
		disabledDirectory === undefined
			? []
			: await readdir(join(customNodesDirectory, ".disabled"), {
					withFileTypes: true,
				});
	const inventory = await Promise.all([
		...disabledEntries.map(async (entry) => ({
			name: entry.name.slice(0, -".disabled".length),
			...(await installedNodeMetadata(customNodesDirectory, entry)),
		})),
		...nestedEntries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => ({
				name: entry.name,
				...(await installedNodeMetadata(
					join(customNodesDirectory, ".disabled"),
					entry,
				)),
			})),
	]);
	return inventory.sort((left, right) => left.name.localeCompare(right.name));
}

function assertNoGitHubDirectoryConflicts(
	nodes: CustomNodeSyncTarget[],
	inventory: CustomNodeInventoryEntry[],
): void {
	for (const node of nodes) {
		if (node.repository === undefined) continue;
		const directoryName = node.id.split("/")[1];
		const conflict = inventory.find((entry) => {
			if (entry.name !== directoryName) return false;
			return entry.repository === undefined || customNodeInventoryId(entry) !== node.id;
		});
		if (conflict !== undefined) {
			const owner =
				conflict.repository === undefined
					? "an unsupported or unmanaged node"
					: customNodeInventoryId(conflict);
			throw new Error(
				`Worker GitHub custom node directory ${directoryName} is occupied by ${owner}, not ${node.id}. Remove it before synchronizing.`,
			);
		}
	}
}

async function installedNodeMetadata(
	directory: string,
	entry: Dirent,
): Promise<{
	managerId: string | null;
	version: string | null;
	repository?: string;
}> {
	if (!entry.isDirectory() && !entry.isSymbolicLink()) {
		return { managerId: null, version: null };
	}
	const nodeDirectory = join(directory, entry.name);
	try {
		await readFile(join(nodeDirectory, ".tracking"), "utf8");
		const metadata = cnrProjectMetadata(
			await readFile(join(nodeDirectory, "pyproject.toml"), "utf8"),
		);
		if (metadata !== null) return metadata;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return (await gitNodeMetadata(nodeDirectory)) ?? { managerId: null, version: null };
}

async function gitNodeMetadata(
	directory: string,
): Promise<{ managerId: null; version: string | null; repository: string } | null> {
	try {
		const entry = await lstat(directory);
		if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
		const [origin, commit, status, topLevel] = await Promise.all([
			gitOutput(directory, ["config", "--get", "remote.origin.url"]),
			gitOutput(directory, ["rev-parse", "--verify", "HEAD"]),
			gitOutput(directory, [...ROOT_GIT_STATUS_ARGS]),
			gitOutput(directory, ["rev-parse", "--show-toplevel"]),
		]);
		const state = gitCustomNodeState({
			origin,
			commit,
			status,
			directory: await realpath(directory),
			repositoryRoot: await realpath(topLevel),
		});
		if (state === null) return null;
		return {
			managerId: null,
			version: gitCustomNodeVersion(state),
			repository: state.repository,
		};
	} catch {
		return null;
	}
}

async function gitOutput(directory: string, args: string[]): Promise<string> {
	const child = Bun.spawn(gitCommand(directory, args), {
		env: workerChildEnvironment(process.env, {
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
		}),
		stdout: "pipe",
		stderr: "ignore",
	});
	const output = await new Response(child.stdout).text();
	if ((await child.exited) !== 0) throw new Error("Could not inspect Git metadata.");
	return output.trimEnd();
}

function gitCommand(directory: string, args: string[]): string[] {
	return ["git", "--no-optional-locks", "-C", directory, ...args];
}

function cnrProjectMetadata(
	contents: string,
): { managerId: string; version: string | null } | null {
	try {
		const parsed: unknown = Bun.TOML.parse(contents);
		if (!isRecord(parsed) || !isRecord(parsed.project)) return null;
		const name = parsed.project.name;
		if (!isCustomNodeManagerId(name)) return null;
		const version = parsed.project.version;
		return {
			managerId: name,
			version: isCustomNodeManagerVersion(version) ? version : null,
		};
	} catch {
		return null;
	}
}

function validateRequest(value: unknown): CustomNodeSyncRequest {
	const request = parseCustomNodeSyncRequest(value);
	if (request === null) {
		throw new CustomNodeSyncError("Invalid custom node sync request.", 400);
	}
	return request;
}

function validateRemovalRequest(value: unknown): CustomNodeRemovalRequest {
	const request = parseCustomNodeRemovalRequest(value);
	if (request === null) {
		throw new CustomNodeSyncError("Invalid custom node removal request.", 400);
	}
	return request;
}

function validateRootDirectory(value: string): string {
	if (!isAbsolute(value))
		throw new Error("KASTARD_COMFYUI_ROOT must be an absolute path.");
	const root = resolve(value);
	if (root === "/")
		throw new Error("KASTARD_COMFYUI_ROOT cannot be the filesystem root.");
	return root;
}

function commandFailureLines(output: string): string[] {
	return output
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.includes("ERROR:") || /\[\s*FAIL\s*\]/u.test(line));
}

export async function runCommand(
	command: string[],
	options: RunCommandOptions,
): Promise<string> {
	const signal = options.signal ?? new AbortController().signal;
	signal.throwIfAborted();
	const child = Bun.spawn(command, {
		cwd: options.cwd,
		env: options.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const outputAbortController = new AbortController();
	const stdout = readCommandOutput(
		child.stdout,
		"stdout",
		options.onOutput,
		outputAbortController.signal,
	);
	const stderr = readCommandOutput(
		child.stderr,
		"stderr",
		options.onOutput,
		outputAbortController.signal,
	);
	const abort = (): void => {
		child.kill(9);
		outputAbortController.abort();
	};
	signal.addEventListener("abort", abort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let exitCode: number;
	try {
		if (signal.aborted) abort();
		exitCode = await Promise.race([
			child.exited,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					child.kill(9);
					reject(
						new Error(`Custom node command timed out after ${options.timeoutMs}ms.`),
					);
				}, options.timeoutMs);
			}),
		]);
	} catch (error) {
		outputAbortController.abort();
		void Promise.allSettled([stdout, stderr]);
		throw error;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
	}
	signal.throwIfAborted();
	const [stdoutOutput, stderrOutput] = await Promise.all([stdout, stderr]);
	const combinedOutput = `${stdoutOutput}\n${stderrOutput}`.trim();
	if (exitCode !== 0) {
		throw new Error(
			`Custom node command exited with code ${exitCode}.${combinedOutput.length === 0 ? "" : ` ${combinedOutput.slice(-1_000)}`}`,
		);
	}
	return options.returnOutput === "stdout" ? stdoutOutput.trim() : combinedOutput;
}

async function readCommandOutput(
	stream: ReadableStream<Uint8Array>,
	source: ProcessOutputStream,
	onOutput: CommandOutput | undefined,
	signal: AbortSignal,
): Promise<string> {
	const reader = stream.getReader();
	const lineBuffer =
		onOutput === undefined
			? null
			: new ProcessOutputLineBuffer((line) => onOutput(source, line));
	const cancel = (): void => {
		void reader.cancel().catch(() => {});
	};
	if (signal.aborted) cancel();
	else signal.addEventListener("abort", cancel, { once: true });
	const decoder = new TextDecoder();
	let output = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			output += text;
			lineBuffer?.write(text);
		}
		const tail = decoder.decode();
		output += tail;
		lineBuffer?.write(tail);
		lineBuffer?.flush();
		return output;
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

function userFacingError(error: unknown): string {
	return error instanceof Error && error.message.length > 0
		? error.message
		: "Unknown custom node synchronization error.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
