import { describe, expect, test } from "bun:test";
import {
	customNodeSyncNodeSnapshot,
	gitCustomNodeState,
	gitCustomNodeVersion,
	isCustomNodeInventoryEntry,
	isCustomNodeName,
	isCustomNodeSyncTarget,
	normalizeGitHubRepository,
	parseCustomNodeRemovalRequest,
	parseCustomNodeSyncRequest,
	parseCustomNodeSyncServerState,
	ROOT_GIT_STATUS_ARGS,
	sameCustomNodeSyncRequest,
} from "./custom-nodes";

const COMMIT = "a".repeat(40);
const REPOSITORY = "https://github.com/owner/repository.git";

describe("custom node common semantics", () => {
	test("normalizes supported GitHub repository URLs", () => {
		expect(normalizeGitHubRepository("git@github.com:Owner/Repository.git")).toEqual({
			id: "owner/repository",
			url: REPOSITORY,
		});
		expect(normalizeGitHubRepository("ssh://git@github.com/Owner/Repository")).toEqual({
			id: "owner/repository",
			url: REPOSITORY,
		});
		expect(
			normalizeGitHubRepository("https://token@github.com/owner/repository.git"),
		).toBeNull();
		expect(
			normalizeGitHubRepository("https://example.com/owner/repository.git"),
		).toBeNull();
		expect(normalizeGitHubRepository("https://github.com/owner/..git")).toBeNull();
	});

	test("accepts only canonical custom node targets and inventory", () => {
		const target = { id: "owner/repository", version: COMMIT, repository: REPOSITORY };
		expect(isCustomNodeSyncTarget(target)).toBe(true);
		expect(isCustomNodeSyncTarget({ ...target, version: "main" })).toBe(false);
		expect(
			isCustomNodeSyncTarget({
				...target,
				repository: "git@github.com:owner/repository.git",
			}),
		).toBe(false);
		expect(
			isCustomNodeInventoryEntry({
				name: "repository",
				managerId: null,
				version: COMMIT,
				repository: REPOSITORY,
			}),
		).toBe(true);
		expect(
			isCustomNodeInventoryEntry({
				name: "repository",
				managerId: "repository",
				version: COMMIT,
				repository: REPOSITORY,
			}),
		).toBe(false);
	});

	test("accepts only custom node basename values", () => {
		expect(isCustomNodeName("comfyui-kjnodes")).toBe(true);
		expect(isCustomNodeName("manual.py")).toBe(true);
		expect(isCustomNodeName(".")).toBe(false);
		expect(isCustomNodeName("..")).toBe(false);
		expect(isCustomNodeName("../other-repo")).toBe(false);
		expect(isCustomNodeName("nested/node")).toBe(false);
		expect(isCustomNodeName("nested\\node")).toBe(false);
	});

	test("parses one unambiguous synchronization request", () => {
		expect(
			parseCustomNodeSyncRequest({
				managerVersion: "4.2.2",
				nodes: [
					{ id: "comfyui-kjnodes", version: "1.5.0" },
					{ id: "owner/repository", version: COMMIT, repository: REPOSITORY },
				],
			}),
		).toEqual({
			managerVersion: "4.2.2",
			nodes: [
				{ id: "comfyui-kjnodes", version: "1.5.0" },
				{ id: "owner/repository", version: COMMIT, repository: REPOSITORY },
			],
		});
		expect(
			parseCustomNodeSyncRequest({
				managerVersion: "4.2.2",
				nodes: [
					{ id: "owner/repository", version: COMMIT, repository: REPOSITORY },
					{
						id: "other/repository",
						version: COMMIT,
						repository: "https://github.com/other/repository.git",
					},
				],
			}),
		).toBeNull();
	});

	test("parses removal requests for managed and manual Worker nodes", () => {
		const target = {
			managerVersion: "4.2.2",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		};
		expect(
			parseCustomNodeRemovalRequest({
				...target,
				node: {
					name: "manual.py",
					managerId: null,
					version: null,
					ignored: true,
				},
			}),
		).toEqual({
			...target,
			node: { name: "manual.py", managerId: null, version: null },
		});
		expect(
			parseCustomNodeRemovalRequest({
				...target,
				node: { name: "../manual.py", managerId: null, version: null },
			}),
		).toBeNull();
	});

	test("associates synchronization state with its target and operation", () => {
		const target = {
			managerVersion: "4.2.2",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		};
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 2,
				capabilities: { forceReinstall: true },
				target,
				operationId: "118a6ec2-62fa-4f5c-95e8-cdbe68602ec3",
				operationKind: "reinstall",
				status: "syncing",
				phase: "install",
				reinstallPhase: "remove",
				current: 0,
				total: 1,
				currentNode: null,
			}),
		).toMatchObject({
			contractVersion: 2,
			capabilities: { forceReinstall: true },
			operationKind: "reinstall",
			reinstallPhase: "remove",
			target,
		});
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 2,
				target,
				operationId: "118a6ec2-62fa-4f5c-95e8-cdbe68602ec3",
				operationKind: "reinstall",
				status: "syncing",
				phase: "install",
				reinstallPhase: "unknown",
				current: 0,
				total: 1,
				currentNode: null,
			}),
		).toBeNull();
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 2,
				target,
				operationId: null,
				status: "canceling",
			}),
		).toBeNull();
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 2,
				capabilities: { forceReinstall: false },
				target,
				operationId: "118a6ec2-62fa-4f5c-95e8-cdbe68602ec3",
				operationKind: "reinstall",
				status: "canceling",
			}),
		).toMatchObject({ capabilities: { forceReinstall: false } });
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 2,
				capabilities: { forceReinstall: "yes" },
				target,
				operationId: "118a6ec2-62fa-4f5c-95e8-cdbe68602ec3",
				operationKind: "reinstall",
				status: "canceling",
			}),
		).toBeNull();
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 2,
				capabilities: { remove: true },
				target,
				operationId: "118a6ec2-62fa-4f5c-95e8-cdbe68602ec3",
				operationKind: "remove",
				removalNode: { name: "manual.py", managerId: null, version: null },
				status: "syncing",
				phase: "remove",
				removalPhase: "remove",
				current: 0,
				total: 1,
				currentNode: "manual.py",
			}),
		).toMatchObject({
			operationKind: "remove",
			removalNode: { name: "manual.py" },
			removalPhase: "remove",
		});
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 2,
				target,
				operationId: "118a6ec2-62fa-4f5c-95e8-cdbe68602ec3",
				operationKind: "remove",
				status: "canceling",
			}),
		).toBeNull();
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 2,
				target: null,
				operationId: null,
				status: "idle",
				nodes: [],
				removalNode: { name: "manual.py", managerId: null, version: null },
			}),
		).toBeNull();
	});

	test("parses additive per-node synchronization snapshots", () => {
		const target = {
			managerVersion: "4.2.2",
			nodes: [
				{ id: "comfyui-kjnodes", version: "1.5.0" },
				{ id: "comfyui-impact-pack", version: "8.24" },
			],
		};
		const state: unknown = {
			contractVersion: 2,
			target,
			operationId: "118a6ec2-62fa-4f5c-95e8-cdbe68602ec3",
			status: "syncing",
			phase: "install",
			current: 1,
			total: 2,
			currentNode: "comfyui-impact-pack",
			nodeSnapshot: {
				targetNodes: [
					{ id: "comfyui-kjnodes", status: "installed", workerVersion: "1.5.0" },
					{
						id: "comfyui-impact-pack",
						status: "installing",
						workerVersion: "8.19.1",
					},
				],
				activeNodes: [
					{
						name: "comfyui-impact-pack",
						managerId: "comfyui-impact-pack",
						version: "8.19.1",
					},
				],
			},
		};
		const parsed = parseCustomNodeSyncServerState(state);
		expect(parsed).not.toBeNull();
		if (parsed === null || parsed.contractVersion !== 2) {
			throw new Error("Expected a current custom node sync state.");
		}
		expect(parsed.nodeSnapshot).toEqual({
			targetNodes: [
				{ id: "comfyui-kjnodes", status: "installed", workerVersion: "1.5.0" },
				{
					id: "comfyui-impact-pack",
					status: "installing",
					workerVersion: "8.19.1",
				},
			],
			activeNodes: [
				{
					name: "comfyui-impact-pack",
					managerId: "comfyui-impact-pack",
					version: "8.19.1",
				},
			],
		});
	});

	test("keeps an exact installed node failed when its install command failed", () => {
		const target = { id: "comfyui-kjnodes", version: "1.5.0" };
		expect(
			customNodeSyncNodeSnapshot(
				[target],
				[
					{
						name: target.id,
						managerId: target.id,
						version: target.version,
					},
				],
				new Set([target.id]),
			),
		).toEqual({
			targetNodes: [{ id: target.id, status: "failed", workerVersion: target.version }],
			activeNodes: [
				{
					name: target.id,
					managerId: target.id,
					version: target.version,
				},
			],
		});
	});

	test("rejects snapshots that disagree with the synchronization target", () => {
		const target = {
			managerVersion: "4.2.2",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		};
		const base = {
			contractVersion: 2,
			target,
			operationId: "118a6ec2-62fa-4f5c-95e8-cdbe68602ec3",
			status: "syncing",
			phase: "install",
			current: 0,
			total: 1,
			currentNode: null,
		};
		expect(
			parseCustomNodeSyncServerState({
				...base,
				nodeSnapshot: {
					targetNodes: [
						{
							id: "comfyui-kjnodes",
							status: "failed",
							workerVersion: "1.5.0",
						},
					],
					activeNodes: [],
				},
			}),
		).not.toBeNull();
		expect(
			parseCustomNodeSyncServerState({
				...base,
				nodeSnapshot: {
					targetNodes: [
						{ id: "other-node", status: "not-installed", workerVersion: null },
					],
					activeNodes: [],
				},
			}),
		).toBeNull();
		expect(
			parseCustomNodeSyncServerState({
				...base,
				nodeSnapshot: {
					targetNodes: [
						{
							id: "comfyui-kjnodes",
							status: "version-mismatch",
							workerVersion: "1.5.0",
						},
					],
					activeNodes: [],
				},
			}),
		).toBeNull();
	});

	test("rejects states outside the current contract", () => {
		expect(parseCustomNodeSyncServerState({ status: "ready", nodes: [] })).toBeNull();
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 3,
				status: "ready",
				nodes: [],
			}),
		).toBeNull();
		expect(
			parseCustomNodeSyncServerState({
				contractVersion: 1,
				target: null,
				operationId: null,
				status: "ready",
				nodes: [],
			}),
		).toBeNull();
	});

	test("compares synchronization targets independently of node order", () => {
		const left = {
			managerVersion: "4.2.2",
			nodes: [
				{ id: "comfyui-kjnodes", version: "1.5.0" },
				{ id: "owner/repository", version: COMMIT, repository: REPOSITORY },
			],
		};
		expect(
			sameCustomNodeSyncRequest(left, {
				...left,
				nodes: [...left.nodes].reverse(),
			}),
		).toBe(true);
		expect(sameCustomNodeSyncRequest(left, { ...left, managerVersion: "4.3.0" })).toBe(
			false,
		);
	});

	test("derives version only from a clean root repository", () => {
		const clean = gitCustomNodeState({
			origin: "git@github.com:Owner/Repository.git",
			commit: COMMIT.toUpperCase(),
			status: "",
			directory: "/custom_nodes/repository",
			repositoryRoot: "/custom_nodes/repository",
		});
		expect(clean).toEqual({
			id: "owner/repository",
			repository: REPOSITORY,
			commit: COMMIT,
			isRepositoryRoot: true,
			hasRootChanges: false,
		});
		if (clean === null) throw new Error("Expected a Git custom node state.");
		expect(gitCustomNodeVersion(clean)).toBe(COMMIT);
		expect(gitCustomNodeVersion({ ...clean, isRepositoryRoot: false })).toBeNull();
		expect(gitCustomNodeVersion({ ...clean, hasRootChanges: true })).toBeNull();
	});

	test("collects root status without inspecting submodules", () => {
		expect(ROOT_GIT_STATUS_ARGS).toEqual([
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
			"--ignore-submodules=all",
		]);
	});
});
