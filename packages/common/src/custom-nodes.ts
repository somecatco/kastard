const MANAGER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MANAGER_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u;
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export const ROOT_GIT_STATUS_ARGS = [
	"status",
	"--porcelain=v1",
	"--untracked-files=all",
	"--ignore-submodules=all",
] as const;

export type CustomNodeSyncTarget = {
	id: string;
	version: string;
	repository?: string;
};

export type CustomNodeInventoryEntry = {
	name: string;
	managerId: string | null;
	version: string | null;
	repository?: string;
};

export type CustomNodeSyncRequest = {
	managerVersion: string;
	nodes: CustomNodeSyncTarget[];
};

export type CustomNodeRemovalRequest = CustomNodeSyncRequest & {
	node: CustomNodeInventoryEntry;
};

export type CustomNodeSyncNodeStatus =
	| "installed"
	| "installing"
	| "not-installed"
	| "failed"
	| "version-mismatch";

export type CustomNodeSyncNodeState = {
	id: string;
	status: CustomNodeSyncNodeStatus;
	workerVersion: string | null;
	error?: string;
};

export type CustomNodeSyncNodeSnapshot = {
	targetNodes: CustomNodeSyncNodeState[];
	activeNodes: CustomNodeInventoryEntry[] | null;
};

export const CUSTOM_NODE_SYNC_CONTRACT_VERSION = 2 as const;

export type CustomNodeSyncCapabilities = {
	forceReinstall?: boolean;
	remove?: boolean;
};

export type CustomNodeSyncOperationKind = "sync" | "reinstall" | "remove";
export type CustomNodeReinstallPhase = "prepare" | "remove" | "install";
export type CustomNodeRemovalPhase = "prepare" | "remove";

type CustomNodeSyncCapabilitiesField = {
	capabilities?: CustomNodeSyncCapabilities;
};

type CustomNodeSyncNodeSnapshotField = {
	nodeSnapshot?: CustomNodeSyncNodeSnapshot;
};

type CustomNodeSyncOperation = {
	contractVersion: typeof CUSTOM_NODE_SYNC_CONTRACT_VERSION;
	target: CustomNodeSyncRequest;
	operationId: string;
	operationKind?: CustomNodeSyncOperationKind;
	removalNode?: CustomNodeInventoryEntry;
} & CustomNodeSyncCapabilitiesField &
	CustomNodeSyncNodeSnapshotField;

export type CustomNodeSyncState =
	| ({
			contractVersion: typeof CUSTOM_NODE_SYNC_CONTRACT_VERSION;
			target: CustomNodeSyncRequest | null;
			operationId: null;
			operationKind?: undefined;
			status: "idle";
			nodes: CustomNodeInventoryEntry[] | null;
	  } & CustomNodeSyncCapabilitiesField &
			CustomNodeSyncNodeSnapshotField)
	| (CustomNodeSyncOperation & {
			status: "syncing";
			phase: "install" | "validate" | "remove";
			reinstallPhase?: CustomNodeReinstallPhase;
			removalPhase?: CustomNodeRemovalPhase;
			current: number;
			total: number;
			currentNode: string | null;
	  })
	| (CustomNodeSyncOperation & { status: "canceling" })
	| (CustomNodeSyncOperation & {
			status: "canceled";
			nodes: CustomNodeInventoryEntry[] | null;
	  })
	| (CustomNodeSyncOperation & {
			status: "ready";
			nodes: CustomNodeSyncTarget[];
	  })
	| (CustomNodeSyncOperation & {
			status: "failed";
			nodes: CustomNodeInventoryEntry[] | null;
			error: string;
	  });

export type GitCustomNodeState = {
	id: string;
	repository: string;
	commit: string;
	isRepositoryRoot: boolean;
	hasRootChanges: boolean;
};

export function gitCustomNodeState(input: {
	origin: string;
	commit: string;
	status: string;
	directory: string;
	repositoryRoot: string;
}): GitCustomNodeState | null {
	const repository = normalizeGitHubRepository(input.origin.trim());
	const commit = input.commit.trim().toLowerCase();
	if (repository === null || !isGitCommit(commit)) return null;
	return {
		id: repository.id,
		repository: repository.url,
		commit,
		isRepositoryRoot: input.directory === input.repositoryRoot,
		hasRootChanges: input.status.trim() !== "",
	};
}

export function gitCustomNodeVersion(state: GitCustomNodeState): string | null {
	return state.isRepositoryRoot && !state.hasRootChanges ? state.commit : null;
}

export function parseCustomNodeSyncRequest(
	value: unknown,
): CustomNodeSyncRequest | null {
	if (
		!isRecord(value) ||
		!isCustomNodeManagerVersion(value.managerVersion) ||
		!Array.isArray(value.nodes) ||
		value.nodes.length > 250
	) {
		return null;
	}
	const nodes: CustomNodeSyncTarget[] = [];
	const ids = new Set<string>();
	const githubDirectoryNames = new Set<string>();
	for (const valueNode of value.nodes) {
		if (!isCustomNodeSyncTarget(valueNode) || ids.has(valueNode.id)) return null;
		if (valueNode.repository !== undefined) {
			const directoryName = valueNode.id.split("/")[1];
			if (directoryName === undefined || githubDirectoryNames.has(directoryName)) {
				return null;
			}
			githubDirectoryNames.add(directoryName);
		}
		ids.add(valueNode.id);
		nodes.push({
			id: valueNode.id,
			version: valueNode.version,
			...(valueNode.repository === undefined
				? {}
				: { repository: valueNode.repository }),
		});
	}
	return { managerVersion: value.managerVersion, nodes };
}

export function parseCustomNodeRemovalRequest(
	value: unknown,
): CustomNodeRemovalRequest | null {
	const target = parseCustomNodeSyncRequest(value);
	if (target === null || !isRecord(value) || !isCustomNodeInventoryEntry(value.node)) {
		return null;
	}
	return {
		...target,
		node: {
			name: value.node.name,
			managerId: value.node.managerId,
			version: value.node.version,
			...(value.node.repository === undefined
				? {}
				: { repository: value.node.repository }),
		},
	};
}

export function parseCustomNodeSyncState(value: unknown): CustomNodeSyncState | null {
	if (!isRecord(value) || value.contractVersion !== CUSTOM_NODE_SYNC_CONTRACT_VERSION) {
		return null;
	}
	if (!isOptionalCustomNodeSyncCapabilities(value.capabilities)) return null;
	if (value.status === "idle") {
		const idleTarget =
			value.target === null ? null : parseCustomNodeSyncRequest(value.target);
		if (
			value.operationId !== null ||
			value.operationKind !== undefined ||
			value.removalNode !== undefined ||
			(value.target !== null && idleTarget === null) ||
			!isInventory(value.nodes) ||
			!isOptionalCustomNodeSyncNodeSnapshot(value.nodeSnapshot, idleTarget)
		) {
			return null;
		}
		return { ...value, target: idleTarget } as CustomNodeSyncState;
	}
	const target = parseCustomNodeSyncRequest(value.target);
	if (
		target === null ||
		!isCustomNodeSyncOperationId(value.operationId) ||
		!isOptionalCustomNodeSyncOperationKind(value.operationKind) ||
		!isCustomNodeOperationMetadata(value.operationKind, value.removalNode) ||
		!isOptionalCustomNodeSyncNodeSnapshot(value.nodeSnapshot, target)
	) {
		return null;
	}
	if (value.status === "syncing") {
		const reinstallPhase = value.reinstallPhase;
		const removalPhase = value.removalPhase;
		const operationKind = value.operationKind;
		return isCustomNodeProgress(value) &&
			isOptionalCustomNodeReinstallPhase(reinstallPhase) &&
			isOptionalCustomNodeRemovalPhase(removalPhase) &&
			(reinstallPhase === undefined || operationKind === "reinstall") &&
			(removalPhase === undefined || operationKind === "remove") &&
			(operationKind === "remove"
				? value.phase === "remove" && removalPhase !== undefined
				: value.phase !== "remove" && removalPhase === undefined)
			? ({ ...value, target } as CustomNodeSyncState)
			: null;
	}
	if (value.status === "canceling") {
		return { ...value, target } as CustomNodeSyncState;
	}
	if (value.status === "canceled") {
		return isInventory(value.nodes)
			? ({ ...value, target } as CustomNodeSyncState)
			: null;
	}
	if (value.status === "ready") {
		return Array.isArray(value.nodes) &&
			value.nodes.every(isCustomNodeSyncTarget) &&
			sameCustomNodeSyncTargets(target.nodes, value.nodes)
			? ({ ...value, target } as CustomNodeSyncState)
			: null;
	}
	return value.status === "failed" &&
		isInventory(value.nodes) &&
		typeof value.error === "string"
		? ({ ...value, target } as CustomNodeSyncState)
		: null;
}

function isOptionalCustomNodeSyncCapabilities(
	value: unknown,
): value is CustomNodeSyncCapabilities | undefined {
	return (
		value === undefined ||
		(isRecord(value) &&
			(!("forceReinstall" in value) || typeof value.forceReinstall === "boolean") &&
			(!("remove" in value) || typeof value.remove === "boolean"))
	);
}

function isCustomNodeOperationMetadata(
	operationKind: unknown,
	removalNode: unknown,
): boolean {
	return operationKind === "remove"
		? isCustomNodeInventoryEntry(removalNode)
		: removalNode === undefined;
}

function isOptionalCustomNodeSyncOperationKind(
	value: unknown,
): value is CustomNodeSyncOperationKind | undefined {
	return (
		value === undefined ||
		value === "sync" ||
		value === "reinstall" ||
		value === "remove"
	);
}

export function isCustomNodeSyncState(value: unknown): value is CustomNodeSyncState {
	return (
		isRecord(value) &&
		value.contractVersion === CUSTOM_NODE_SYNC_CONTRACT_VERSION &&
		parseCustomNodeSyncState(value) !== null
	);
}

export function sameCustomNodeSyncRequest(
	left: CustomNodeSyncRequest,
	right: CustomNodeSyncRequest,
): boolean {
	return (
		left.managerVersion === right.managerVersion &&
		sameCustomNodeSyncTargets(left.nodes, right.nodes)
	);
}

export function isCustomNodeSyncTarget(value: unknown): value is CustomNodeSyncTarget {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.version !== "string"
	) {
		return false;
	}
	if (value.repository === undefined) {
		return isCustomNodeManagerId(value.id) && isCustomNodeManagerVersion(value.version);
	}
	return (
		isGitHubRepositoryId(value.id) &&
		value.repository === `https://github.com/${value.id}.git` &&
		isGitCommit(value.version)
	);
}

export function isCustomNodeInventoryEntry(
	value: unknown,
): value is CustomNodeInventoryEntry {
	if (
		!isRecord(value) ||
		!isCustomNodeName(value.name) ||
		(value.managerId !== null && !isCustomNodeManagerId(value.managerId)) ||
		(value.version !== null && typeof value.version !== "string")
	) {
		return false;
	}
	if (value.repository === undefined) {
		return value.version === null || isCustomNodeManagerVersion(value.version);
	}
	if (value.managerId !== null || typeof value.repository !== "string") return false;
	const repository = normalizeGitHubRepository(value.repository);
	return (
		repository !== null &&
		repository.url === value.repository &&
		(value.version === null || isGitCommit(value.version))
	);
}

export function normalizeGitHubRepository(
	value: string,
): { id: string; url: string } | null {
	let path: string;
	const scp = /^git@github\.com:(.+)$/iu.exec(value);
	if (scp !== null) path = scp[1] ?? "";
	else {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return null;
		}
		if (
			url.hostname.toLowerCase() !== "github.com" ||
			!["https:", "ssh:", "git:"].includes(url.protocol) ||
			url.password !== "" ||
			(url.username !== "" && !(url.protocol === "ssh:" && url.username === "git")) ||
			url.search !== "" ||
			url.hash !== ""
		) {
			return null;
		}
		path = url.pathname;
	}
	const segments = path
		.replace(/^\/+|\/+$/gu, "")
		.replace(/\.git$/iu, "")
		.split("/");
	if (segments.length !== 2) return null;
	const [owner, repository] = segments;
	if (owner === undefined || repository === undefined) return null;
	const id = `${owner}/${repository}`.toLowerCase();
	return isGitHubRepositoryId(id) ? { id, url: `https://github.com/${id}.git` } : null;
}

export function customNodeInventoryId(entry: CustomNodeInventoryEntry): string {
	if (entry.repository === undefined) return entry.managerId ?? entry.name;
	return normalizeGitHubRepository(entry.repository)?.id ?? entry.name;
}

export function sameCustomNodeInventoryEntry(
	left: CustomNodeInventoryEntry,
	right: CustomNodeInventoryEntry,
): boolean {
	return (
		left.name === right.name &&
		left.managerId === right.managerId &&
		left.version === right.version &&
		left.repository === right.repository
	);
}

export function customNodeSyncNodeSnapshot(
	targets: CustomNodeSyncTarget[],
	activeNodes: CustomNodeInventoryEntry[],
	failures?: ReadonlyMap<string, string>,
	installingNodeId?: string | null,
): CustomNodeSyncNodeSnapshot;
export function customNodeSyncNodeSnapshot(
	targets: CustomNodeSyncTarget[],
	activeNodes: null,
	failures?: ReadonlyMap<string, string>,
	installingNodeId?: string | null,
): undefined;
export function customNodeSyncNodeSnapshot(
	targets: CustomNodeSyncTarget[],
	activeNodes: CustomNodeInventoryEntry[] | null,
	failures?: ReadonlyMap<string, string>,
	installingNodeId?: string | null,
): CustomNodeSyncNodeSnapshot | undefined;
export function customNodeSyncNodeSnapshot(
	targets: CustomNodeSyncTarget[],
	activeNodes: CustomNodeInventoryEntry[] | null,
	failures: ReadonlyMap<string, string> = new Map(),
	installingNodeId: string | null = null,
): CustomNodeSyncNodeSnapshot | undefined {
	if (activeNodes === null) return undefined;
	const activeById = new Map<string, CustomNodeInventoryEntry[]>();
	for (const entry of activeNodes) {
		const id = customNodeInventoryId(entry);
		const entries = activeById.get(id) ?? [];
		entries.push(entry);
		activeById.set(id, entries);
	}
	return {
		targetNodes: targets.map((target) => {
			const entries = activeById.get(target.id);
			const installed = entries?.length === 1 ? entries[0] : undefined;
			if (target.id === installingNodeId) {
				return {
					id: target.id,
					status: "installing",
					workerVersion: installed?.version ?? null,
				};
			}
			const error = failures.get(target.id);
			if (error !== undefined) {
				return {
					id: target.id,
					status: "failed",
					workerVersion: installed?.version ?? null,
					error,
				};
			}
			if (installed?.version === target.version) {
				return {
					id: target.id,
					status: "installed",
					workerVersion: target.version,
				};
			}
			if (installed?.version !== null && installed?.version !== undefined) {
				return {
					id: target.id,
					status: "version-mismatch",
					workerVersion: installed.version,
				};
			}
			return {
				id: target.id,
				status:
					entries !== undefined && entries.length > 1 ? "failed" : "not-installed",
				workerVersion: null,
			};
		}),
		activeNodes,
	};
}

export function isGitCommit(value: unknown): value is string {
	return typeof value === "string" && GIT_COMMIT_PATTERN.test(value);
}

export function isCustomNodeManagerId(value: unknown): value is string {
	return typeof value === "string" && MANAGER_ID_PATTERN.test(value);
}

export function isCustomNodeManagerVersion(value: unknown): value is string {
	return typeof value === "string" && MANAGER_VERSION_PATTERN.test(value);
}

export function isCustomNodeName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 512 &&
		value.trim() === value &&
		value !== "." &&
		value !== ".." &&
		!/[\\/]/u.test(value)
	);
}

function isCustomNodeProgress(value: Record<string, unknown>): value is {
	phase: "install" | "validate" | "remove";
	current: number;
	total: number;
	currentNode: string | null;
} {
	return (
		(value.phase === "install" ||
			value.phase === "validate" ||
			value.phase === "remove") &&
		typeof value.current === "number" &&
		Number.isSafeInteger(value.current) &&
		value.current >= 0 &&
		typeof value.total === "number" &&
		Number.isSafeInteger(value.total) &&
		value.total >= value.current &&
		(value.currentNode === null || typeof value.currentNode === "string")
	);
}

function isOptionalCustomNodeRemovalPhase(
	value: unknown,
): value is CustomNodeRemovalPhase | undefined {
	return value === undefined || value === "prepare" || value === "remove";
}

function isOptionalCustomNodeReinstallPhase(
	value: unknown,
): value is CustomNodeReinstallPhase | undefined {
	return (
		value === undefined ||
		value === "prepare" ||
		value === "remove" ||
		value === "install"
	);
}

function isInventory(value: unknown): value is CustomNodeInventoryEntry[] | null {
	return (
		value === null || (Array.isArray(value) && value.every(isCustomNodeInventoryEntry))
	);
}

function isOptionalCustomNodeSyncNodeSnapshot(
	value: unknown,
	target: CustomNodeSyncRequest | null,
): value is CustomNodeSyncNodeSnapshot | undefined {
	if (value === undefined) return true;
	if (
		!isRecord(value) ||
		!isInventory(value.activeNodes) ||
		!Array.isArray(value.targetNodes)
	) {
		return false;
	}
	const targetNodes = value.targetNodes;
	if (target === null) return targetNodes.length === 0;
	if (targetNodes.length !== target.nodes.length) return false;
	return target.nodes.every((node, index) => {
		const state = targetNodes[index];
		if (
			!isRecord(state) ||
			state.id !== node.id ||
			!isCustomNodeSyncNodeStatus(state.status) ||
			(state.workerVersion !== null && typeof state.workerVersion !== "string") ||
			(state.error !== undefined && typeof state.error !== "string")
		) {
			return false;
		}
		if (state.status === "installed") return state.workerVersion === node.version;
		if (state.status === "version-mismatch") {
			return state.workerVersion !== null && state.workerVersion !== node.version;
		}
		if (state.status === "not-installed") return state.workerVersion === null;
		return true;
	});
}

function isCustomNodeSyncNodeStatus(value: unknown): value is CustomNodeSyncNodeStatus {
	return (
		value === "installed" ||
		value === "installing" ||
		value === "not-installed" ||
		value === "failed" ||
		value === "version-mismatch"
	);
}

function isCustomNodeSyncOperationId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 128 &&
		/^[A-Za-z0-9._:-]+$/u.test(value)
	);
}

function sameCustomNodeSyncTargets(
	left: CustomNodeSyncTarget[],
	right: CustomNodeSyncTarget[],
): boolean {
	if (left.length !== right.length) return false;
	const rightById = new Map(right.map((node) => [node.id, node] as const));
	return left.every((node) => {
		const other = rightById.get(node.id);
		return (
			other !== undefined &&
			other.version === node.version &&
			other.repository === node.repository
		);
	});
}

export function isGitHubRepositoryId(value: unknown): value is string {
	if (typeof value !== "string" || !GITHUB_REPOSITORY_PATTERN.test(value)) {
		return false;
	}
	const repository = value.split("/")[1];
	return repository !== "." && repository !== "..";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
