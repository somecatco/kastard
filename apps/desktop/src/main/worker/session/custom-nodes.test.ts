// @vitest-environment node

import { expect, test, vi } from "vitest";
import type { CustomNodeSyncState } from "../../../shared/api";
import type { CustomNodeSyncPlan } from "../sync-plan";
import {
	CUSTOM_NODE_TARGET,
	createHarness,
	currentCustomNodeState,
	deferred,
	initializeAndConnect,
	type SessionOptions,
	STALE_CUSTOM_NODE_TARGET,
	verification,
	WORKER_ADDRESS,
} from "./test-harness";

test("invalidates Worker verification after the Editor Manager selection changes", async () => {
	let managerVersion = "4.2.2";
	const { session, options } = createHarness(
		{},
		{
			buildCustomNodeSyncPlan: async () => ({
				managerVersion,
				nodes: CUSTOM_NODE_TARGET.nodes,
				unsupportedNodes: [],
			}),
		},
	);
	await initializeAndConnect(session);
	await session.syncCustomNodes();
	await session.verify();
	expect(session.getState().customNodes.status).toBe("ready");
	expect(session.getState().verification).toEqual(verification);

	managerVersion = "4.3.0";
	session.refreshEditorCustomNodeTarget();

	expect(session.getState().verification).toBeNull();
	await vi.waitFor(() =>
		expect(session.getState().customNodes).toMatchObject({
			status: "ready",
			targetStatus: "stale",
		}),
	);
	expect(options.cancelCustomNodes).not.toHaveBeenCalled();
	session.stop();
});

test("restores the target relation from Worker state after reconnecting", async () => {
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: currentCustomNodeState({
			status: "ready" as const,
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		}),
	});
	const first = createHarness({ readCustomNodes });
	await initializeAndConnect(first.session);
	await first.session.syncCustomNodes();
	expect(first.session.getState().customNodes.status).toBe("ready");
	first.session.stop();

	const restarted = createHarness({ readCustomNodes });
	await initializeAndConnect(restarted.session);
	await vi.waitFor(() => expect(readCustomNodes).toHaveBeenCalledTimes(2));
	expect(restarted.session.getState().customNodes).toMatchObject({
		status: "ready",
		targetStatus: "current",
	});

	await restarted.session.syncCustomNodes();
	expect(restarted.session.getState().customNodes.status).toBe("ready");
	restarted.session.stop();
});

test("projects selected and unselected Worker custom nodes", async () => {
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: currentCustomNodeState({
			status: "syncing" as const,
			phase: "install" as const,
			current: 0,
			total: 1,
			currentNode: "comfyui-kjnodes@1.5.0",
			nodeSnapshot: {
				targetNodes: [
					{
						id: "comfyui-kjnodes",
						status: "version-mismatch" as const,
						workerVersion: "1.4.0",
					},
				],
				activeNodes: [
					{
						name: "comfyui-kjnodes",
						managerId: "comfyui-kjnodes",
						version: "1.4.0",
					},
					{ name: "manual-node", managerId: null, version: null },
				],
			},
		}),
	});
	const { session } = createHarness({ readCustomNodes });

	await initializeAndConnect(session);

	expect(session.getState().customNodes).toMatchObject({
		status: "syncing",
		targetStatus: "current",
		targetNodes: [
			{
				id: "comfyui-kjnodes",
				editorVersion: "1.5.0",
				workerVersion: "1.4.0",
				status: "version-mismatch",
			},
		],
		unselectedNodes: [{ name: "manual-node", managerId: null, version: null }],
	});
	session.stop();
});

test("projects the failure reason for an individual custom node", async () => {
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: currentCustomNodeState({
			status: "failed" as const,
			nodes: [],
			error: "Custom node synchronization did not complete.",
			nodeSnapshot: {
				targetNodes: [
					{
						id: "comfyui-kjnodes",
						status: "failed" as const,
						workerVersion: null,
						error: "Dependency installation failed.",
					},
				],
				activeNodes: [],
			},
		}),
	});
	const { session } = createHarness({ readCustomNodes });

	await initializeAndConnect(session);

	expect(session.getState().customNodes).toMatchObject({
		status: "failed",
		targetNodes: [
			{
				id: "comfyui-kjnodes",
				status: "failed",
				error: "Dependency installation failed.",
			},
		],
	});
	session.stop();
});

test("reinstalls one selected custom node while preserving the full projection", async () => {
	const primaryNode = { id: "comfyui-kjnodes", version: "1.5.0" };
	const otherNode = { id: "comfyui-easy-use", version: "1.3.6" };
	const nodes = [primaryNode, otherNode];
	const target = { managerVersion: "4.2.2", nodes };
	const inventory = [
		{ name: primaryNode.id, managerId: primaryNode.id, version: primaryNode.version },
		{ name: otherNode.id, managerId: otherNode.id, version: otherNode.version },
		{ name: "manual-node", managerId: null, version: null },
	];
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: {
			contractVersion: 2 as const,
			capabilities: { forceReinstall: true as const },
			target,
			operationId: "previous-operation",
			operationKind: "sync" as const,
			status: "ready" as const,
			nodes,
			nodeSnapshot: {
				targetNodes: nodes.map((node) => ({
					id: node.id,
					status: "installed" as const,
					workerVersion: node.version,
				})),
				activeNodes: inventory,
			},
		},
	});
	const reinstallCustomNode = vi.fn().mockResolvedValue({
		ok: true,
		state: {
			contractVersion: 2 as const,
			capabilities: { forceReinstall: true as const },
			target: { managerVersion: "4.2.2", nodes: [primaryNode] },
			operationId: "reinstall-operation",
			operationKind: "reinstall" as const,
			status: "syncing" as const,
			phase: "install" as const,
			reinstallPhase: "remove" as const,
			current: 0,
			total: 1,
			currentNode: primaryNode.id,
			nodeSnapshot: {
				targetNodes: [
					{
						id: primaryNode.id,
						status: "installing" as const,
						workerVersion: primaryNode.version,
					},
				],
				activeNodes: inventory,
			},
		},
	});
	const { session, options } = createHarness(
		{ readCustomNodes, reinstallCustomNode, pollMs: 60_000 },
		{
			buildCustomNodeSyncPlan: async () => ({
				...target,
				unsupportedNodes: [],
			}),
		},
	);
	await initializeAndConnect(session);
	await vi.waitFor(() =>
		expect(session.getState().customNodes).toMatchObject({ targetStatus: "current" }),
	);

	expect(await session.reinstallCustomNode(primaryNode.id)).toMatchObject({
		ok: true,
		state: { status: "syncing", reinstallNodeId: primaryNode.id },
	});
	expect(reinstallCustomNode).toHaveBeenCalledWith(
		expect.anything(),
		"4.2.2",
		primaryNode,
		expect.any(Function),
	);
	expect(session.getState().customNodes).toMatchObject({
		status: "syncing",
		reinstallPhase: "remove",
		targetStatus: "current",
		reinstallNodeId: primaryNode.id,
		targetNodes: [
			{ id: primaryNode.id, status: "installing" },
			{ id: otherNode.id, status: "installed" },
		],
		unselectedNodes: [{ name: "manual-node" }],
	});

	session.refreshEditorCustomNodeTarget();
	await vi.waitFor(() =>
		expect(session.getState().customNodes).toMatchObject({ targetStatus: "current" }),
	);
	expect(options.cancelCustomNodes).not.toHaveBeenCalled();
	session.stop();
});

test("removes one unselected Worker custom node and preserves the selected target", async () => {
	const selectedNode = { id: "comfyui-kjnodes", version: "1.5.0" };
	const target = { managerVersion: "4.2.2", nodes: [selectedNode] };
	const removedNode = { name: "manual.py", managerId: null, version: null };
	const otherNode = { name: "other.py", managerId: null, version: null };
	const selectedInventory = {
		name: selectedNode.id,
		managerId: selectedNode.id,
		version: selectedNode.version,
	};
	const initialState = {
		contractVersion: 2 as const,
		capabilities: { forceReinstall: true as const, remove: true as const },
		target,
		operationId: "previous-operation",
		operationKind: "sync" as const,
		status: "ready" as const,
		nodes: [selectedNode],
		nodeSnapshot: {
			targetNodes: [
				{
					id: selectedNode.id,
					status: "installed" as const,
					workerVersion: selectedNode.version,
				},
			],
			activeNodes: [selectedInventory, removedNode, otherNode],
		},
	};
	const completedState = {
		...initialState,
		operationId: "removal-operation",
		operationKind: "remove" as const,
		removalNode: removedNode,
		nodeSnapshot: {
			...initialState.nodeSnapshot,
			activeNodes: [selectedInventory, otherNode],
		},
	};
	const readCustomNodes = vi
		.fn()
		.mockResolvedValueOnce({ ok: true, state: initialState })
		.mockResolvedValue({ ok: true, state: completedState });
	const removeCustomNode = vi.fn().mockResolvedValue({
		ok: true,
		state: {
			...initialState,
			operationId: "removal-operation",
			operationKind: "remove" as const,
			removalNode: removedNode,
			status: "syncing" as const,
			phase: "remove" as const,
			removalPhase: "remove" as const,
			current: 0,
			total: 1,
			currentNode: removedNode.name,
		},
	});
	const removalPlan = deferred<CustomNodeSyncPlan>();
	const buildCustomNodeSyncPlan = vi
		.fn()
		.mockResolvedValueOnce({ ...target, unsupportedNodes: [] })
		.mockReturnValueOnce(removalPlan.promise);
	const { session } = createHarness(
		{ readCustomNodes, removeCustomNode, pollMs: 1 },
		{ buildCustomNodeSyncPlan },
	);
	await initializeAndConnect(session);
	await vi.waitFor(() =>
		expect(session.getState().customNodes).toMatchObject({
			targetStatus: "current",
			unselectedNodes: [{ name: removedNode.name }, { name: otherNode.name }],
		}),
	);

	const removal = session.removeCustomNode(removedNode);
	await vi.waitFor(() => expect(buildCustomNodeSyncPlan).toHaveBeenCalledTimes(2));
	expect(session.getState().customNodes).toEqual({ status: "loading" });
	removalPlan.resolve({ ...target, unsupportedNodes: [] });
	expect(await removal).toMatchObject({
		ok: true,
		state: { status: "syncing", operationKind: "remove", removalNode: removedNode },
	});
	expect(removeCustomNode).toHaveBeenCalledWith(
		expect.anything(),
		target,
		removedNode,
		expect.any(Function),
	);
	await vi.waitFor(() =>
		expect(session.getState().customNodes).toMatchObject({
			status: "ready",
			targetStatus: "current",
			targetNodes: [{ id: selectedNode.id, status: "installed" }],
			unselectedNodes: [{ name: otherNode.name }],
		}),
	);
	session.stop();
});

test("projects the current selection after a completed reinstall target is deselected", async () => {
	const reinstalledNode = { id: "comfyui-kjnodes", version: "1.5.0" };
	const selectedNode = { id: "comfyui-easy-use", version: "1.3.6" };
	const inventory = [
		{
			name: reinstalledNode.id,
			managerId: reinstalledNode.id,
			version: reinstalledNode.version,
		},
		{
			name: selectedNode.id,
			managerId: selectedNode.id,
			version: selectedNode.version,
		},
		{ name: "manual-node", managerId: null, version: null },
	];
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: {
			contractVersion: 2 as const,
			capabilities: { forceReinstall: true as const },
			target: { managerVersion: "4.2.2", nodes: [reinstalledNode] },
			operationId: "completed-reinstall",
			operationKind: "reinstall" as const,
			status: "ready" as const,
			nodes: [reinstalledNode],
			nodeSnapshot: {
				targetNodes: [
					{
						id: reinstalledNode.id,
						status: "installed" as const,
						workerVersion: reinstalledNode.version,
					},
				],
				activeNodes: inventory,
			},
		},
	});
	const { session } = createHarness(
		{ readCustomNodes },
		{
			buildCustomNodeSyncPlan: async () => ({
				managerVersion: "4.2.2",
				nodes: [selectedNode],
				unsupportedNodes: [],
			}),
		},
	);

	await initializeAndConnect(session);
	expect(session.getState().customNodes).toMatchObject({
		targetStatus: "stale",
		targetNodes: [{ id: selectedNode.id, status: "installed" }],
		unselectedNodes: [{ name: reinstalledNode.id }, { name: "manual-node" }],
	});
	session.stop();
});

test("does not apply an obsolete reinstall result to a newer selected version", async () => {
	const reinstalledNode = { id: "comfyui-kjnodes", version: "1.5.0" };
	const selectedNode = { id: reinstalledNode.id, version: "1.6.0" };
	const inventory = [
		{
			name: reinstalledNode.id,
			managerId: reinstalledNode.id,
			version: reinstalledNode.version,
		},
	];
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: {
			contractVersion: 2 as const,
			capabilities: { forceReinstall: true as const },
			target: { managerVersion: "4.2.2", nodes: [reinstalledNode] },
			operationId: "completed-reinstall",
			operationKind: "reinstall" as const,
			status: "ready" as const,
			nodes: [reinstalledNode],
			nodeSnapshot: {
				targetNodes: [
					{
						id: reinstalledNode.id,
						status: "installed" as const,
						workerVersion: reinstalledNode.version,
					},
				],
				activeNodes: inventory,
			},
		},
	});
	const { session } = createHarness(
		{ readCustomNodes },
		{
			buildCustomNodeSyncPlan: async () => ({
				managerVersion: "4.2.2",
				nodes: [selectedNode],
				unsupportedNodes: [],
			}),
		},
	);

	await initializeAndConnect(session);
	expect(session.getState().customNodes).toMatchObject({
		targetStatus: "stale",
		targetNodes: [
			{
				id: selectedNode.id,
				editorVersion: selectedNode.version,
				workerVersion: reinstalledNode.version,
				status: "version-mismatch",
			},
		],
	});
	session.stop();
});

test("resumes custom node polling when a reinstall request finds another operation", async () => {
	const node = { id: "comfyui-kjnodes", version: "1.5.0" };
	const readyState = {
		contractVersion: 2 as const,
		capabilities: { forceReinstall: true as const },
		target: { managerVersion: "4.2.2", nodes: [node] },
		operationId: "existing-operation",
		operationKind: "sync" as const,
		status: "ready" as const,
		nodes: [node],
	};
	const readCustomNodes = vi.fn().mockResolvedValue({ ok: true, state: readyState });
	const reinstallCustomNode = vi.fn().mockResolvedValue({
		ok: false,
		error: "Custom nodes are already synchronizing.",
	});
	const { session } = createHarness({
		readCustomNodes,
		reinstallCustomNode,
		pollMs: 1,
	});

	await initializeAndConnect(session);
	await expect(session.reinstallCustomNode(node.id)).resolves.toEqual({
		ok: false,
		error: "Custom nodes are already synchronizing.",
	});
	expect(session.getState().customNodes).toMatchObject({
		status: "unavailable",
		retryable: true,
	});
	await vi.waitFor(() => expect(readCustomNodes).toHaveBeenCalledTimes(2));
	expect(session.getState().customNodes).toMatchObject({ status: "ready" });
	session.stop();
});

test("does not publish a stale reinstall plan failure after disconnecting", async () => {
	let rejectPlan = (_error: Error): void => undefined;
	const pendingPlan = new Promise<CustomNodeSyncPlan>((_resolve, reject) => {
		rejectPlan = reject;
	});
	const buildCustomNodeSyncPlan = vi
		.fn()
		.mockResolvedValueOnce({
			managerVersion: CUSTOM_NODE_TARGET.managerVersion,
			nodes: CUSTOM_NODE_TARGET.nodes,
			unsupportedNodes: [],
		})
		.mockReturnValueOnce(pendingPlan);
	const { session } = createHarness(
		{
			readCustomNodes: vi.fn().mockResolvedValue({
				ok: true,
				state: {
					contractVersion: 2 as const,
					capabilities: { forceReinstall: true as const },
					target: CUSTOM_NODE_TARGET,
					operationId: "previous-operation",
					status: "ready" as const,
					nodes: CUSTOM_NODE_TARGET.nodes,
				},
			}),
		},
		{ buildCustomNodeSyncPlan },
	);
	await initializeAndConnect(session);

	const reinstall = session.reinstallCustomNode("comfyui-kjnodes");
	await vi.waitFor(() => expect(buildCustomNodeSyncPlan).toHaveBeenCalledTimes(2));
	expect(session.getState().customNodes).toEqual({ status: "loading" });
	await session.disconnect();
	rejectPlan(new Error("Could not read the Editor custom node target."));

	await expect(reinstall).resolves.toEqual({
		ok: false,
		error: "A newer Worker custom node request replaced this one.",
	});
	expect(session.getState().customNodes).toEqual({ status: "disconnected" });
	session.stop();
});

test("resumes polling after restoring a running state from an invalid reinstall plan", async () => {
	const pendingPlan = deferred<CustomNodeSyncPlan>();
	const buildCustomNodeSyncPlan = vi
		.fn()
		.mockResolvedValueOnce({
			managerVersion: CUSTOM_NODE_TARGET.managerVersion,
			nodes: CUSTOM_NODE_TARGET.nodes,
			unsupportedNodes: [],
		})
		.mockReturnValueOnce(pendingPlan.promise);
	const readCustomNodes = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			state: currentCustomNodeState({
				capabilities: { forceReinstall: true as const },
				status: "syncing" as const,
				phase: "install" as const,
				current: 0,
				total: 1,
				currentNode: "comfyui-kjnodes",
			}),
		})
		.mockResolvedValue({
			ok: true,
			state: currentCustomNodeState({
				capabilities: { forceReinstall: true as const },
				status: "ready" as const,
				nodes: CUSTOM_NODE_TARGET.nodes,
			}),
		});
	const { session } = createHarness(
		{ readCustomNodes, pollMs: 1 },
		{ buildCustomNodeSyncPlan },
	);
	await initializeAndConnect(session);

	const reinstall = session.reinstallCustomNode("comfyui-kjnodes");
	await vi.waitFor(() => expect(buildCustomNodeSyncPlan).toHaveBeenCalledTimes(2));
	pendingPlan.resolve({
		managerVersion: CUSTOM_NODE_TARGET.managerVersion,
		nodes: [],
		unsupportedNodes: [],
	});

	await expect(reinstall).resolves.toEqual({
		ok: false,
		error: "The selected custom node is no longer part of the Editor sync target.",
	});
	await vi.waitFor(() => expect(readCustomNodes).toHaveBeenCalledTimes(2));
	expect(session.getState().customNodes).toMatchObject({ status: "ready" });
	session.stop();
});

test("rejects individual reinstall from an older Worker or a stale selection", async () => {
	const reinstallCustomNode = vi.fn();
	const { session } = createHarness({ reinstallCustomNode });
	await initializeAndConnect(session);

	await expect(session.reinstallCustomNode("comfyui-kjnodes")).resolves.toEqual({
		ok: false,
		error: "This Worker does not support individual custom node reinstall.",
	});
	expect(reinstallCustomNode).not.toHaveBeenCalled();
	session.stop();

	const capable = createHarness({
		readCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: {
				contractVersion: 2 as const,
				capabilities: { forceReinstall: true as const },
				target: CUSTOM_NODE_TARGET,
				operationId: "previous-operation",
				status: "ready" as const,
				nodes: CUSTOM_NODE_TARGET.nodes,
			},
		}),
		reinstallCustomNode,
	});
	await initializeAndConnect(capable.session);
	await expect(capable.session.reinstallCustomNode("removed-node")).resolves.toEqual({
		ok: false,
		error: "The selected custom node is no longer part of the Editor sync target.",
	});
	expect(reinstallCustomNode).not.toHaveBeenCalled();
	capable.session.stop();
});

test("treats a selected node with an unknown Worker version as not installed", async () => {
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: {
			contractVersion: 2 as const,
			target: null,
			operationId: null,
			status: "idle" as const,
			nodes: [
				{
					name: "comfyui-kjnodes",
					managerId: "comfyui-kjnodes",
					version: null,
				},
			],
		},
	});
	const { session } = createHarness({ readCustomNodes });

	await initializeAndConnect(session);

	expect(session.getState().customNodes).toMatchObject({
		status: "idle",
		targetNodes: [
			{
				id: "comfyui-kjnodes",
				workerVersion: null,
				status: "not-installed",
			},
		],
	});
	session.stop();
});

test("projects an idle Worker inventory as the current Editor target", async () => {
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: {
			contractVersion: 2 as const,
			capabilities: { forceReinstall: true as const },
			target: null,
			operationId: null,
			status: "idle" as const,
			nodes: [
				{
					name: "comfyui-kjnodes",
					managerId: "comfyui-kjnodes",
					version: "1.5.0",
				},
			],
		},
	});
	const { session } = createHarness({ readCustomNodes });

	await initializeAndConnect(session);

	expect(session.getState().customNodes).toMatchObject({
		status: "idle",
		capabilities: { forceReinstall: true },
		targetStatus: "current",
		targetNodes: [
			{
				id: "comfyui-kjnodes",
				workerVersion: "1.5.0",
				status: "installed",
			},
		],
	});
	session.stop();
});

test("waits for Manager target cancellation before starting a new custom-node sync", async () => {
	const canceled = deferred<{
		ok: true;
		state: CustomNodeSyncState;
	}>();
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: currentCustomNodeState(
			{
				status: "syncing" as const,
				phase: "install" as const,
				current: 1,
				total: 2,
				currentNode: "comfyui-kjnodes",
			},
			STALE_CUSTOM_NODE_TARGET,
		),
	});
	const { session, options } = createHarness({
		readCustomNodes,
		cancelCustomNodes: vi.fn().mockReturnValue(canceled.promise),
		pollMs: 60_000,
	});
	await initializeAndConnect(session);

	session.refreshEditorCustomNodeTarget();
	await vi.waitFor(() => expect(options.cancelCustomNodes).toHaveBeenCalledOnce());
	const sync = session.syncCustomNodes();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(options.startCustomNodes).not.toHaveBeenCalled();

	canceled.resolve({
		ok: true,
		state: currentCustomNodeState(
			{ status: "canceled", nodes: [] },
			STALE_CUSTOM_NODE_TARGET,
		),
	});
	const result = await sync;
	if (!result.ok) throw new Error(result.error);
	expect(options.startCustomNodes).toHaveBeenCalledOnce();
	session.stop();
});

test("cancels a stale Worker custom-node sync before automatic setup", async () => {
	const canceled = deferred<{
		ok: true;
		state: CustomNodeSyncState;
	}>();
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: currentCustomNodeState(
			{
				status: "syncing" as const,
				phase: "install" as const,
				current: 1,
				total: 2,
				currentNode: "comfyui-kjnodes",
			},
			STALE_CUSTOM_NODE_TARGET,
		),
	});
	const { session, options } = createHarness({
		readCustomNodes,
		cancelCustomNodes: vi.fn().mockReturnValue(canceled.promise),
		pollMs: 60_000,
	});
	expect(await session.initialize()).toEqual({ ok: true });

	expect(
		await session.connect({
			provider: "other",
			workerAddress: WORKER_ADDRESS,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: true,
		}),
	).toEqual({ ok: true });
	await vi.waitFor(() => expect(options.cancelCustomNodes).toHaveBeenCalledOnce());
	expect(options.startCustomNodes).not.toHaveBeenCalled();

	canceled.resolve({
		ok: true,
		state: currentCustomNodeState(
			{ status: "canceled", nodes: [] },
			STALE_CUSTOM_NODE_TARGET,
		),
	});
	await vi.waitFor(() => expect(options.startCustomNodes).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	session.stop();
});

test("keeps Manager target cancellation active when setup starts", async () => {
	const canceled = deferred<{
		ok: true;
		state: CustomNodeSyncState;
	}>();
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: currentCustomNodeState(
			{
				status: "syncing" as const,
				phase: "install" as const,
				current: 1,
				total: 2,
				currentNode: "comfyui-kjnodes",
			},
			STALE_CUSTOM_NODE_TARGET,
		),
	});
	const { session, options } = createHarness({
		readCustomNodes,
		cancelCustomNodes: vi.fn().mockReturnValue(canceled.promise),
		pollMs: 60_000,
	});
	await initializeAndConnect(session);

	session.refreshEditorCustomNodeTarget();
	await vi.waitFor(() => expect(options.cancelCustomNodes).toHaveBeenCalledOnce());
	expect(session.startSetup()).toEqual({ ok: true });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(options.startCustomNodes).not.toHaveBeenCalled();

	canceled.resolve({
		ok: true,
		state: currentCustomNodeState(
			{ status: "canceled", nodes: [] },
			STALE_CUSTOM_NODE_TARGET,
		),
	});
	await vi.waitFor(() => expect(options.startCustomNodes).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	session.stop();
});

test("keeps Manager target cancellation active across repeated Manager changes", async () => {
	const canceled = deferred<{
		ok: true;
		state: CustomNodeSyncState;
	}>();
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: currentCustomNodeState(
			{
				status: "syncing" as const,
				phase: "install" as const,
				current: 1,
				total: 2,
				currentNode: "comfyui-kjnodes",
			},
			STALE_CUSTOM_NODE_TARGET,
		),
	});
	const { session, options } = createHarness({
		readCustomNodes,
		cancelCustomNodes: vi.fn().mockReturnValue(canceled.promise),
		pollMs: 60_000,
	});
	await initializeAndConnect(session);

	session.refreshEditorCustomNodeTarget();
	await vi.waitFor(() => expect(options.cancelCustomNodes).toHaveBeenCalledOnce());
	session.refreshEditorCustomNodeTarget();
	const sync = session.syncCustomNodes();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(options.cancelCustomNodes).toHaveBeenCalledOnce();
	expect(options.startCustomNodes).not.toHaveBeenCalled();

	canceled.resolve({
		ok: true,
		state: currentCustomNodeState(
			{ status: "canceled", nodes: [] },
			STALE_CUSTOM_NODE_TARGET,
		),
	});
	expect(await sync).toMatchObject({ ok: true });
	expect(options.startCustomNodes).toHaveBeenCalledOnce();
	session.stop();
});

test("keeps manual cancellation tied to its operation across a Manager change", async () => {
	let managerVersion = "4.2.2";
	const canceled = deferred<{
		ok: true;
		state: CustomNodeSyncState;
	}>();
	const cancelCustomNodes = vi.fn().mockReturnValue(canceled.promise);
	const { session, options } = createHarness(
		{
			readCustomNodes: vi.fn().mockResolvedValue({
				ok: true,
				state: currentCustomNodeState({
					status: "syncing" as const,
					phase: "install" as const,
					current: 1,
					total: 2,
					currentNode: "comfyui-kjnodes",
				}),
			}),
			cancelCustomNodes,
			pollMs: 60_000,
		},
		{
			buildCustomNodeSyncPlan: async () => ({
				managerVersion,
				nodes: CUSTOM_NODE_TARGET.nodes,
				unsupportedNodes: [],
			}),
		},
	);
	await initializeAndConnect(session);

	const cancellation = session.cancelCustomNodes();
	await vi.waitFor(() => expect(cancelCustomNodes).toHaveBeenCalledOnce());
	expect(cancelCustomNodes.mock.calls[0]?.[1]).toBe("custom-node-operation");
	managerVersion = "4.3.0";
	session.refreshEditorCustomNodeTarget();
	expect(cancelCustomNodes).toHaveBeenCalledOnce();

	canceled.resolve({
		ok: true,
		state: currentCustomNodeState({ status: "canceled", nodes: [] }),
	});
	expect(await cancellation).toMatchObject({
		ok: true,
		state: { status: "canceled", targetStatus: "stale" },
	});
	expect(options.startCustomNodes).not.toHaveBeenCalled();
	session.stop();
});

test("resynchronizes a stale custom-node target while Worker ComfyUI is ready", async () => {
	const { session, options } = createHarness({
		readComfy: vi.fn().mockResolvedValue({ ok: true, state: { status: "ready" } }),
		readCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: currentCustomNodeState(
				{ status: "ready", nodes: CUSTOM_NODE_TARGET.nodes },
				STALE_CUSTOM_NODE_TARGET,
			),
		}),
	});
	expect(await session.initialize()).toEqual({ ok: true });
	expect(
		await session.connect({
			provider: "other",
			workerAddress: WORKER_ADDRESS,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: true,
		}),
	).toEqual({ ok: true });

	await vi.waitFor(() =>
		expect(session.getState()).toMatchObject({
			customNodes: { status: "ready", targetStatus: "current" },
			comfy: { status: "ready" },
			setup: { status: "succeeded" },
		}),
	);
	expect(options.cancelCustomNodes).not.toHaveBeenCalled();
	expect(options.startCustomNodes).toHaveBeenCalledOnce();
	expect(options.verify).toHaveBeenCalledOnce();
	expect(options.startComfy).not.toHaveBeenCalled();
	session.stop();
});

test("replaces an active custom-node sync after the Editor Manager selection changes", async () => {
	const fetchMock = vi.fn(
		(_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted.", "AbortError"));
				});
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const { session, options } = createHarness({
		startCustomNodes: vi.fn(
			async (_credential, _managerVersion, _nodes, requestFetch) => {
				await requestFetch("https://worker.example.com/custom-nodes");
				return {
					ok: true as const,
					state: currentCustomNodeState({ status: "ready" as const, nodes: [] }),
				};
			},
		),
	});

	try {
		await initializeAndConnect(session);
		const active = session.syncCustomNodes();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		session.refreshEditorCustomNodeTarget();

		expect(await active).toEqual({
			ok: false,
			error: "A newer Worker custom node request replaced this one.",
		});
		expect(options.cancelCustomNodes).not.toHaveBeenCalled();
		expect(session.getState().customNodes).toMatchObject({
			status: "idle",
			targetStatus: "current",
		});
	} finally {
		session.stop();
		vi.unstubAllGlobals();
	}
});

test("stops reconciliation when an aborted mutation was not accepted", async () => {
	const idleState = {
		contractVersion: 2 as const,
		capabilities: { forceReinstall: true as const },
		target: null,
		operationId: null,
		status: "idle" as const,
		nodes: [],
	};
	const readCustomNodes = vi.fn().mockResolvedValue({ ok: true, state: idleState });
	const fetchMock = vi.fn(
		(_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("The operation was aborted.", "AbortError")),
					{ once: true },
				);
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const { session } = createHarness({
		readCustomNodes,
		pollMs: 1,
		startCustomNodes: vi.fn(
			async (_credential, _managerVersion, _nodes, requestFetch) => {
				await requestFetch("https://worker.example.com/custom-nodes");
				return { ok: true as const, state: idleState };
			},
		),
	});

	try {
		await initializeAndConnect(session);
		const active = session.syncCustomNodes();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		session.refreshEditorCustomNodeTarget();

		expect(await active).toEqual({
			ok: false,
			error: "A newer Worker custom node request replaced this one.",
		});
		await vi.waitFor(() => expect(readCustomNodes).toHaveBeenCalledTimes(6));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(readCustomNodes).toHaveBeenCalledTimes(6);
	} finally {
		session.stop();
		vi.unstubAllGlobals();
	}
});

test("reconciles an accepted reinstall across rapid target refreshes", async () => {
	const node = { id: "comfyui-kjnodes", version: "1.5.0" };
	const operationId = "accepted-reinstall";
	let selectedNodes = [node];
	const blockedTargetRefresh = deferred<{
		managerVersion: string;
		nodes: Array<typeof node>;
		unsupportedNodes: [];
	}>();
	const fetchMock = vi.fn(
		(_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("The operation was aborted.", "AbortError")),
					{ once: true },
				);
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const reinstallingState = {
		contractVersion: 2 as const,
		capabilities: { forceReinstall: true as const },
		target: { managerVersion: "4.2.2", nodes: [node] },
		operationId,
		operationKind: "reinstall" as const,
		status: "syncing" as const,
		phase: "install" as const,
		current: 0,
		total: 1,
		currentNode: node.id,
	};
	const readCustomNodes = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			state: {
				...currentCustomNodeState({ status: "ready" as const, nodes: [node] }),
				capabilities: { forceReinstall: true as const },
			},
		})
		.mockResolvedValueOnce({
			ok: true,
			state: {
				...currentCustomNodeState({ status: "ready" as const, nodes: [node] }),
				capabilities: { forceReinstall: true as const },
			},
		})
		.mockResolvedValue({ ok: true, state: reinstallingState });
	const reinstallCustomNode = vi.fn(
		async (_credential, _managerVersion, _node, requestFetch) => {
			await requestFetch("https://worker.example.com/custom-nodes/reinstall");
			return { ok: true as const, state: reinstallingState };
		},
	);
	const cancelCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: {
			...reinstallingState,
			status: "canceled" as const,
			nodes: [],
		},
	});
	const buildCustomNodeSyncPlan = vi.fn(async () => ({
		managerVersion: "4.2.2",
		nodes: selectedNodes,
		unsupportedNodes: [],
	}));
	const { session } = createHarness(
		{
			readCustomNodes,
			reinstallCustomNode,
			cancelCustomNodes,
			pollMs: 1,
		},
		{
			buildCustomNodeSyncPlan,
		},
	);

	try {
		await initializeAndConnect(session);
		const reinstall = session.reinstallCustomNode(node.id);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		selectedNodes = [];
		buildCustomNodeSyncPlan.mockImplementationOnce(() => blockedTargetRefresh.promise);
		session.refreshEditorCustomNodeTarget();
		session.refreshEditorCustomNodeTarget();

		expect(await reinstall).toEqual({
			ok: false,
			error: "A newer Worker custom node request replaced this one.",
		});
		await vi.waitFor(() => expect(cancelCustomNodes).toHaveBeenCalledOnce());
		expect(readCustomNodes).toHaveBeenCalledTimes(3);
		expect(cancelCustomNodes).toHaveBeenCalledWith(
			expect.anything(),
			operationId,
			expect.any(Function),
		);
		expect(session.getState().customNodes).toMatchObject({
			status: "canceled",
			targetStatus: "stale",
			reinstallNodeId: node.id,
		});
	} finally {
		blockedTargetRefresh.resolve({
			managerVersion: "4.2.2",
			nodes: [],
			unsupportedNodes: [],
		});
		session.stop();
		vi.unstubAllGlobals();
	}
});

test("does not reconcile a status read aborted by a target refresh", async () => {
	const node = { id: "comfyui-kjnodes", version: "1.5.0" };
	const currentState = {
		...currentCustomNodeState({ status: "ready" as const, nodes: [node] }),
		capabilities: { forceReinstall: true as const },
	};
	const inFlightRead = deferred<{ ok: true; state: typeof currentState }>();
	const firstProbe = deferred<{ status: "connected" }>();
	const laterProbe = deferred<{ status: "connected" }>();
	const readCustomNodes = vi
		.fn()
		.mockResolvedValueOnce({ ok: true, state: currentState })
		.mockReturnValueOnce(inFlightRead.promise)
		.mockResolvedValue({ ok: true, state: currentState });
	const probe = vi
		.fn()
		.mockReturnValueOnce(firstProbe.promise)
		.mockReturnValue(laterProbe.promise);
	const { session } = createHarness({
		probe,
		readCustomNodes,
		recheckMs: 1,
		pollMs: 1,
	});

	await initializeAndConnect(session);
	await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
	firstProbe.resolve({ status: "connected" });
	await vi.waitFor(() => expect(readCustomNodes).toHaveBeenCalledTimes(2));

	session.refreshEditorCustomNodeTarget();
	inFlightRead.resolve({ ok: true, state: currentState });
	await new Promise((resolve) => setTimeout(resolve, 20));

	expect(readCustomNodes).toHaveBeenCalledTimes(2);
	session.stop();
	laterProbe.resolve({ status: "connected" });
});

test("refreshes raw custom-node state across connection rechecks", async () => {
	const probeResult =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const readCustomNodes = vi.fn().mockResolvedValue({
		ok: true,
		state: currentCustomNodeState(
			{ status: "ready" as const, nodes: [] },
			{ managerVersion: "4.2.2", nodes: [] },
		),
	});
	const { session, options } = createHarness({
		probe: vi.fn().mockReturnValue(probeResult.promise),
		readCustomNodes,
		recheckMs: 1,
	});
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(options.probe).toHaveBeenCalledOnce());
	expect(readCustomNodes).toHaveBeenCalledOnce();

	session.refreshEditorCustomNodeTarget();
	expect(options.cancelCustomNodes).not.toHaveBeenCalled();
	probeResult.resolve({ status: "connected" });
	await vi.waitFor(() => expect(readCustomNodes.mock.calls.length).toBeGreaterThan(1));

	expect(session.getState().customNodes).toMatchObject({
		status: "ready",
		targetStatus: "stale",
	});
	session.stop();
});

test("cancels active setup after the Editor Manager selection changes", async () => {
	const fetchMock = vi.fn(
		(_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted.", "AbortError"));
				});
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const { session } = createHarness({
		startCustomNodes: vi.fn(
			async (_credential, _managerVersion, _nodes, requestFetch) => {
				await requestFetch("https://worker.example.com/custom-nodes");
				return {
					ok: true as const,
					state: currentCustomNodeState({ status: "ready" as const, nodes: [] }),
				};
			},
		),
	});

	try {
		await initializeAndConnect(session);
		expect(session.startSetup()).toEqual({ ok: true });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		session.refreshEditorCustomNodeTarget();

		expect(session.getState().setup).toEqual({ status: "canceled" });
		expect(session.getState().customNodes.status).toBe("idle");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session.getState().setup).toEqual({ status: "canceled" });
	} finally {
		session.stop();
		vi.unstubAllGlobals();
	}
});

test("rejects a custom-node plan replaced while it is being built", async () => {
	const plan = deferred<CustomNodeSyncPlan>();
	const buildCustomNodeSyncPlan = vi.fn().mockReturnValue(plan.promise);
	const { session, options } = createHarness({}, { buildCustomNodeSyncPlan });
	await initializeAndConnect(session);

	const active = session.syncCustomNodes();
	await vi.waitFor(() => expect(buildCustomNodeSyncPlan).toHaveBeenCalled());
	session.refreshEditorCustomNodeTarget();
	plan.resolve({ managerVersion: "4.2.2", nodes: [], unsupportedNodes: [] });

	expect(await active).toEqual({
		ok: false,
		error: "A newer Worker custom node request replaced this one.",
	});
	expect(options.startCustomNodes).not.toHaveBeenCalled();
	expect(session.getState().customNodes.status).toBe("idle");
	session.stop();
});
