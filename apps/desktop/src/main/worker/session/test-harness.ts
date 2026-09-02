// @vitest-environment node

import { expect, vi } from "vitest";
import type { ModelSyncTarget, SyncVerification } from "../../../shared/api";
import type { WorkerTunnel } from "../tunnel";
import type { WorkerWorkflowActorOptions } from "../workflow-actor";
import type { WorkerConnectionLifecycleOptions } from "./connection-lifecycle";
import type { WorkerCustomNodeSyncOptions } from "./custom-node-sync";
import type { WorkerModelSyncOptions } from "./model-sync";
import type { WorkerRuntimeStateOptions } from "./runtime-state";
import { WorkerSession } from "./worker-session";

export const SERVER_URL = "worker.example.com:22001";
export const SECOND_SERVER_URL = "worker-two.example.com:22002";
export const WORKER_ENDPOINT = "http://127.0.0.1:49152";
export const AUTHENTICATION_CODE = "ABCD-EFGH-JKLM-NPQR";
export const SESSION_CAPABILITY = "test-session-capability";
export const inputlessPrompt = {
	"1": { class_type: "KastardTestNode", inputs: {} },
};
export const runtime = {
	cudaVersion: "12.8",
	pythonVersion: "3.12.13",
	torchVersion: "2.11.0+cu128",
	torchvisionVersion: "0.26.0+cu128",
	torchaudioVersion: "2.11.0+cu128",
	uvVersion: "0.12.4",
};
export const systemMetrics = {
	sampledAt: "2026-08-18T00:00:00.000Z",
	cpu: { usagePercent: 12 },
	ram: { usedBytes: 4, totalBytes: 8, usagePercent: 50 },
	disk: { path: "/workspace", usedBytes: 3, totalBytes: 10, usagePercent: 30 },
	gpus: [],
};
export const verification = {
	status: "synced",
	backend: {
		status: "synced",
		expectedVersion: "0.33.1",
		actualVersion: "0.33.1",
	},
	models: { status: "synced", total: 1 },
	customNodes: { status: "synced", total: 1 },
} satisfies SyncVerification;
export const CUSTOM_NODE_TARGET = {
	managerVersion: "4.2.2",
	nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
};
export const STALE_CUSTOM_NODE_TARGET = {
	managerVersion: "4.1.0",
	nodes: CUSTOM_NODE_TARGET.nodes,
};
export const MODEL_TARGET: ModelSyncTarget = {
	name: "Model",
	path: "checkpoints/model.safetensors",
	artifact: {
		provider: "civitai",
		modelId: "1",
		versionId: "2",
		versionLabel: "v1",
		fileId: "3",
		fileName: "model.safetensors",
		sizeBytes: 1,
	},
};

export function workerTunnel(
	workerAddress: string,
): WorkerTunnel & { emitClose: () => void } {
	let closeListener: (() => void) | null = null;
	let closed = false;
	return {
		endpointUrl: WORKER_ENDPOINT,
		workerAddress,
		sessionCapability: SESSION_CAPABILITY,
		close: vi.fn(async () => undefined),
		onClose: vi.fn((listener) => {
			if (closed) {
				listener();
				return () => undefined;
			}
			closeListener = listener;
			return () => {
				if (closeListener === listener) closeListener = null;
			};
		}),
		emitClose: () => {
			closed = true;
			closeListener?.();
		},
	};
}

export function currentCustomNodeIdleState() {
	return {
		contractVersion: 2 as const,
		target: null,
		operationId: null,
		status: "idle" as const,
		nodes: [],
	};
}

export function currentModelIdleState(models: ModelSyncTarget[] | null = []) {
	return {
		contractVersion: 2 as const,
		target: null,
		operationId: null,
		status: "idle" as const,
		models,
	};
}

export function currentCustomNodeState<State extends { status: string }>(
	state: State,
	target = state.status === "ready" && "nodes" in state
		? { ...CUSTOM_NODE_TARGET, nodes: state.nodes as typeof CUSTOM_NODE_TARGET.nodes }
		: CUSTOM_NODE_TARGET,
): State & {
	contractVersion: 2;
	target: typeof CUSTOM_NODE_TARGET;
	operationId: string;
} {
	return {
		...state,
		contractVersion: 2,
		target,
		operationId: "custom-node-operation",
	};
}

export function currentModelState<State extends { status: string }>(state: State) {
	const models =
		"models" in state && Array.isArray(state.models) && state.models.length > 0
			? (state.models as ModelSyncTarget[])
			: [MODEL_TARGET];
	return {
		...state,
		contractVersion: 2 as const,
		target: { models },
		operationId: "model-operation",
		operationKind: "sync" as const,
	};
}

export function syncingCustomNodeState() {
	return currentCustomNodeState({
		status: "syncing" as const,
		phase: "install" as const,
		current: 0,
		total: 1,
		currentNode: "comfyui-kjnodes",
	});
}

export function syncingModelState() {
	return currentModelState({
		status: "syncing" as const,
		completed: 0,
		total: 1,
		completedBytes: 0,
		totalBytes: 1,
		present: 0,
		active: ["checkpoints/model.safetensors"],
	});
}

type WorkerSessionOptions = NonNullable<ConstructorParameters<typeof WorkerSession>[1]>;
export type SessionOptions = {
	workflow?: WorkerWorkflowActorOptions;
	connect?: WorkerConnectionLifecycleOptions["connect"];
	probe?: WorkerConnectionLifecycleOptions["probe"];
	readLogs?: WorkerConnectionLifecycleOptions["readLogs"];
	readBackend?: WorkerRuntimeStateOptions["readBackend"];
	prepareBackend?: WorkerRuntimeStateOptions["prepareBackend"];
	readComfy?: WorkerRuntimeStateOptions["readComfy"];
	startComfy?: WorkerRuntimeStateOptions["startComfy"];
	restartComfy?: WorkerRuntimeStateOptions["restartComfy"];
	freeComfyMemory?: WorkerRuntimeStateOptions["freeComfyMemory"];
	readSystemMetrics?: WorkerRuntimeStateOptions["readSystemMetrics"];
	readCustomNodes?: WorkerCustomNodeSyncOptions["read"];
	startCustomNodes?: WorkerCustomNodeSyncOptions["start"];
	reinstallCustomNode?: WorkerCustomNodeSyncOptions["reinstall"];
	removeCustomNode?: WorkerCustomNodeSyncOptions["remove"];
	cancelCustomNodes?: WorkerCustomNodeSyncOptions["cancel"];
	readModels?: WorkerModelSyncOptions["read"];
	startModels?: WorkerModelSyncOptions["start"];
	redownloadModel?: WorkerModelSyncOptions["redownload"];
	cancelModels?: WorkerModelSyncOptions["cancel"];
	verify?: NonNullable<WorkerSessionOptions["verification"]>["verify"];
	recheckMs?: number;
	pollMs?: number;
	systemMetricsPollMs?: number;
};
type SessionDependencies = ConstructorParameters<typeof WorkerSession>[0];

export function syncingSetupOptions(): SessionOptions {
	return {
		startCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: syncingCustomNodeState(),
		}),
		startModels: vi.fn().mockResolvedValue({ ok: true, state: syncingModelState() }),
		pollMs: 60_000,
	};
}

export function createHarness(
	overrides: SessionOptions = {},
	dependencyOverrides: Partial<SessionDependencies> = {},
) {
	const store = {
		load: vi.fn().mockResolvedValue({
			recentProvider: null,
			recentServerUrl: null,
			syncAfterConnect: true,
			systemMetricsEnabled: true,
		}),
		save: vi.fn().mockResolvedValue(undefined),
	};
	const options: SessionOptions = {
		connect: vi.fn().mockImplementation(async (serverUrl: string) => ({
			ok: true,
			logCursor: "cursor-1",
			tunnel: workerTunnel(serverUrl),
		})),
		probe: vi.fn().mockResolvedValue({ status: "connected" }),
		readLogs: vi.fn().mockResolvedValue({
			ok: true,
			logs: [],
			cursor: "cursor-2",
			truncated: false,
		}),
		readBackend: vi.fn().mockResolvedValue({
			ok: true,
			state: { status: "ready", version: "0.33.1", runtime },
		}),
		prepareBackend: vi.fn().mockResolvedValue({
			ok: true,
			state: { status: "ready", version: "0.33.1", runtime },
		}),
		readComfy: vi.fn().mockResolvedValue({ ok: true, state: { status: "stopped" } }),
		startComfy: vi.fn().mockResolvedValue({ ok: true, state: { status: "ready" } }),
		restartComfy: vi
			.fn()
			.mockResolvedValue({ ok: true, state: { status: "starting" } }),
		freeComfyMemory: vi.fn().mockResolvedValue({ ok: true, state: true }),
		readCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: currentCustomNodeIdleState(),
		}),
		startCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: currentCustomNodeState({
				status: "ready",
				nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
			}),
		}),
		cancelCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: currentCustomNodeState({ status: "canceled", nodes: [] }),
		}),
		readModels: vi.fn().mockResolvedValue({
			ok: true,
			state: currentModelIdleState(),
		}),
		startModels: vi.fn().mockResolvedValue({
			ok: true,
			state: currentModelState({ status: "synced", models: [] }),
		}),
		redownloadModel: vi.fn().mockResolvedValue({
			ok: true,
			state: currentModelState({ status: "synced", models: [] }),
		}),
		cancelModels: vi.fn().mockResolvedValue({
			ok: true,
			state: currentModelState({ status: "canceled", models: [] }),
		}),
		verify: vi.fn().mockResolvedValue({ ok: true, state: verification }),
		readSystemMetrics: vi.fn().mockResolvedValue({
			ok: true,
			state: systemMetrics,
		}),
		recheckMs: 60_000,
		pollMs: 1,
		systemMetricsPollMs: 60_000,
		...overrides,
	};
	const dependencies: SessionDependencies = {
		store,
		getBackendTarget: () => ({
			version: "0.33.1",
			archiveUrl: "https://example.com/comfyui.zip",
			sha256: "a".repeat(64),
		}),
		getBackendTargetError: () => undefined,
		buildCustomNodeSyncPlan: async () => ({
			managerVersion: "4.2.2",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
			unsupportedNodes: [],
		}),
		buildModelSyncPlan: async () => ({ models: [], credentials: {} }),
		buildSyncVerificationRequest: async () => ({
			backendVersion: "0.33.1",
			models: [],
			customNodes: {
				managerVersion: "4.2.2",
				nodes: [],
				unsupportedNodes: [],
			},
		}),
		shouldSyncModels: () => true,
		...dependencyOverrides,
	};
	const session = new WorkerSession(dependencies, {
		...(options.workflow === undefined ? {} : { workflow: options.workflow }),
		connection: {
			...(options.connect === undefined ? {} : { connect: options.connect }),
			...(options.probe === undefined ? {} : { probe: options.probe }),
			...(options.readLogs === undefined ? {} : { readLogs: options.readLogs }),
			...(options.recheckMs === undefined ? {} : { recheckMs: options.recheckMs }),
		},
		runtime: {
			...(options.readBackend === undefined
				? {}
				: { readBackend: options.readBackend }),
			...(options.prepareBackend === undefined
				? {}
				: { prepareBackend: options.prepareBackend }),
			...(options.readComfy === undefined ? {} : { readComfy: options.readComfy }),
			...(options.startComfy === undefined ? {} : { startComfy: options.startComfy }),
			...(options.restartComfy === undefined
				? {}
				: { restartComfy: options.restartComfy }),
			...(options.freeComfyMemory === undefined
				? {}
				: { freeComfyMemory: options.freeComfyMemory }),
			...(options.readSystemMetrics === undefined
				? {}
				: { readSystemMetrics: options.readSystemMetrics }),
			...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
			...(options.systemMetricsPollMs === undefined
				? {}
				: { systemMetricsPollMs: options.systemMetricsPollMs }),
		},
		customNodes: {
			...(options.readCustomNodes === undefined
				? {}
				: { read: options.readCustomNodes }),
			...(options.startCustomNodes === undefined
				? {}
				: { start: options.startCustomNodes }),
			...(options.reinstallCustomNode === undefined
				? {}
				: { reinstall: options.reinstallCustomNode }),
			...(options.removeCustomNode === undefined
				? {}
				: { remove: options.removeCustomNode }),
			...(options.cancelCustomNodes === undefined
				? {}
				: { cancel: options.cancelCustomNodes }),
			...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
		},
		models: {
			...(options.readModels === undefined ? {} : { read: options.readModels }),
			...(options.startModels === undefined ? {} : { start: options.startModels }),
			...(options.redownloadModel === undefined
				? {}
				: { redownload: options.redownloadModel }),
			...(options.cancelModels === undefined ? {} : { cancel: options.cancelModels }),
			...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
		},
		verification: {
			...(options.verify === undefined ? {} : { verify: options.verify }),
		},
	});
	return { session, store, options, dependencies };
}

export async function initializeAndConnect(session: WorkerSession): Promise<void> {
	expect(await session.initialize()).toEqual({ ok: true });
	expect(
		await session.connect({
			provider: "other",
			serverUrl: SERVER_URL,
			authenticationCode: AUTHENTICATION_CODE,
			syncAfterConnect: false,
		}),
	).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().backend.status).toBe("ready"));
}

export function deferred<Value>(): {
	promise: Promise<Value>;
	resolve: (value: Value) => void;
} {
	let resolve = (_value: Value): void => undefined;
	const promise = new Promise<Value>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}
