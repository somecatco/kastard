import { expect, test } from "vitest";
import {
	isComfyRuntimeState,
	isComfyStartResult,
	isComfyUiManagerNode,
	isConnectionRequest,
	isConnectionState,
	isCustomNodeEntry,
	isCustomNodeRemoveRequest,
	isCustomNodeRemoveResult,
	isDesktopAppInfo,
	isEditorDirectory,
	isEditorDirectoryResult,
	isWorkerBackendResult,
	isWorkerCustomNodeReinstallRequest,
	isWorkerCustomNodeSyncState,
	isWorkerModelRedownloadRequest,
	isWorkerModelSyncState,
	isWorkerSessionSnapshot,
	isWorkerSessionState,
	isWorkerSessionStateChange,
} from "./api";

test("validates custom-node startup recovery and removal messages", () => {
	expect(
		isComfyRuntimeState({
			status: "error",
			message: "A custom node failed to load.",
			reason: "custom-node",
		}),
	).toBe(true);
	expect(
		isComfyRuntimeState({ status: "error", message: "Failed.", reason: "backend" }),
	).toBe(false);
	expect(
		isComfyStartResult({
			ok: false,
			error: "A custom node failed to load.",
			reason: "custom-node",
		}),
	).toBe(true);
	expect(isCustomNodeRemoveRequest({ name: "comfyui-kjnodes" })).toBe(true);
	expect(isCustomNodeRemoveRequest({ name: "../outside" })).toBe(false);
	expect(isCustomNodeRemoveResult({ ok: true, restartRequired: true })).toBe(true);
	expect(isCustomNodeRemoveResult({ ok: true })).toBe(false);
	expect(isCustomNodeRemoveResult({ ok: false, error: "Could not remove node." })).toBe(
		true,
	);
	expect(isComfyUiManagerNode({ name: "ComfyUI-Manager", managerId: null })).toBe(true);
	expect(
		isComfyUiManagerNode({ name: "manager-folder", managerId: "comfyui_manager" }),
	).toBe(true);
	expect(isComfyUiManagerNode({ name: "manager-tools", managerId: null })).toBe(false);
});

test("validates individual custom node reinstall requests", () => {
	expect(isWorkerCustomNodeReinstallRequest({ id: "comfyui-kjnodes" })).toBe(true);
	expect(isWorkerCustomNodeReinstallRequest({ id: "owner/repository" })).toBe(true);
	expect(isWorkerCustomNodeReinstallRequest({ id: "../outside" })).toBe(false);
	expect(isWorkerCustomNodeReinstallRequest({ id: "" })).toBe(false);
});

test("validates individual model redownload requests", () => {
	expect(
		isWorkerModelRedownloadRequest({ path: "checkpoints/model.safetensors" }),
	).toBe(true);
	expect(isWorkerModelRedownloadRequest({ path: "../outside.safetensors" })).toBe(
		false,
	);
	expect(isWorkerModelRedownloadRequest({ path: "/model.safetensors" })).toBe(false);
	expect(isWorkerModelRedownloadRequest({ path: "checkpoints/model.txt" })).toBe(false);
});

test("requires a provider in Worker connection requests and states", () => {
	expect(
		isConnectionRequest({
			provider: "runpod",
			serverUrl: "203.0.113.10:22001",
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: true,
		}),
	).toBe(true);
	expect(
		isConnectionRequest({
			serverUrl: "203.0.113.10:22001",
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: true,
		}),
	).toBe(false);
	expect(
		isConnectionState({
			status: "disconnected",
			recentProvider: "vastai",
			recentServerUrl: "http://203.0.113.10:34220",
		}),
	).toBe(true);
	expect(
		isConnectionState({
			status: "disconnected",
			recentProvider: null,
			recentServerUrl: "https://worker.example.com",
		}),
	).toBe(false);
	expect(
		isConnectionState({
			status: "connected",
			provider: "unsupported",
			serverUrl: "https://worker.example.com",
			connectedAt: 1,
		}),
	).toBe(false);
	expect(
		isConnectionState({
			status: "connected",
			provider: "other",
			serverUrl: "https://worker.example.com",
			connectedAt: 1,
			worker: {
				buildNumber: "15",
				channel: "production",
				productVersion: "0.1.0",
				sourceRevision: "a".repeat(40),
			},
		}),
	).toBe(true);
	expect(
		isConnectionState({
			status: "connected",
			provider: "other",
			serverUrl: "https://worker.example.com",
			connectedAt: 1,
			worker: {
				buildNumber: "15",
				channel: "preview",
				productVersion: "0.1.0",
				sourceRevision: "a".repeat(40),
			},
		}),
	).toBe(false);
});

test("validates Editor application information", () => {
	const info = {
		buildNumber: "1",
		channel: "production",
		productVersion: "0.1.0",
		sourceRevision: "a".repeat(40),
		environment: {
			os: "darwin",
			osVersion: "25.0.0",
			arch: "arm64",
			electronVersion: "43.4.0",
			chromeVersion: "144.0.7559.220",
			nodeVersion: "24.13.0",
		},
	};
	expect(isDesktopAppInfo(info)).toBe(true);
	expect(isDesktopAppInfo({ ...info, productVersion: "" })).toBe(false);
	expect(isDesktopAppInfo({ ...info, buildNumber: "0" })).toBe(false);
	expect(isDesktopAppInfo({ ...info, buildNumber: 1 })).toBe(false);
	expect(isDesktopAppInfo({ ...info, channel: "preview", productVersion: null })).toBe(
		true,
	);
	expect(
		isDesktopAppInfo({
			...info,
			environment: { ...info.environment, electronVersion: "" },
		}),
	).toBe(false);
	expect(isDesktopAppInfo({ ...info, environment: undefined })).toBe(false);
});

test("accepts only supported Editor directories", () => {
	expect(isEditorDirectory("comfy")).toBe(true);
	expect(isEditorDirectory("custom-nodes")).toBe(true);
	expect(isEditorDirectory("model-library")).toBe(true);
	expect(isEditorDirectory("worker")).toBe(false);
});

test("validates Editor directory results", () => {
	expect(isEditorDirectoryResult({ ok: true, path: "/tmp/custom_nodes" })).toBe(true);
	expect(isEditorDirectoryResult({ ok: true, path: null })).toBe(false);
	expect(isEditorDirectoryResult({ ok: false, error: "Directory unavailable." })).toBe(
		true,
	);
	expect(isEditorDirectoryResult({ ok: false })).toBe(false);
});

test("accepts an unavailable backend without a retryable field", () => {
	expect(
		isWorkerSessionState({
			connection: {
				status: "connected",
				provider: "other",
				serverUrl: "https://kastard.example.com",
				connectedAt: 1_787_073_600_000,
			},
			systemMetrics: { status: "unavailable", error: "Metrics unavailable." },
			backend: {
				status: "unavailable",
				editorComfyVersion: "0.33.1",
				error: "Worker authentication failed.",
			},
			comfy: { status: "disconnected" },
			customNodes: { status: "disconnected" },
			models: { status: "disconnected" },
			verification: null,
			setup: { status: "idle" },
			workflow: {
				id: "019d2a56-3c30-7000-8000-000000000001",
				phase: "reconciling",
				cancellation: "unconfirmed",
				workerUrl: "https://kastard.example.com",
				lastConfirmedStatus: "running",
				lastConfirmedAt: 1_787_073_600_000,
			},
		}),
	).toBe(true);
});

test("validates revisioned Worker session snapshots and changes", () => {
	const state = {
		connection: {
			status: "disconnected" as const,
			recentProvider: null,
			recentServerUrl: null,
		},
		systemMetrics: { status: "disconnected" as const },
		backend: {
			status: "disconnected" as const,
			editorComfyVersion: "0.33.1",
		},
		comfy: { status: "disconnected" as const },
		customNodes: { status: "disconnected" as const },
		models: { status: "disconnected" as const },
		verification: null,
		setup: { status: "idle" as const },
	};

	expect(isWorkerSessionSnapshot({ revision: 0, state })).toBe(true);
	expect(isWorkerSessionSnapshot({ revision: -1, state })).toBe(false);
	expect(
		isWorkerSessionStateChange({
			revision: 1,
			type: "connection.changed",
			connection: state.connection,
		}),
	).toBe(true);
	expect(
		isWorkerSessionStateChange({
			revision: 0,
			type: "connection.changed",
			connection: state.connection,
		}),
	).toBe(false);
	expect(isWorkerSessionStateChange({ revision: 1, type: "unknown" })).toBe(false);
});

test("requires a valid connection timestamp for connected sessions", () => {
	const session = {
		connection: {
			status: "connected",
			provider: "other",
			serverUrl: "https://kastard.example.com",
			connectedAt: 1_787_073_600_000,
		},
		systemMetrics: { status: "disconnected" },
		backend: { status: "disconnected", editorComfyVersion: "0.33.1" },
		comfy: { status: "disconnected" },
		customNodes: { status: "disconnected" },
		models: { status: "disconnected" },
		verification: null,
		setup: { status: "idle" },
	};

	expect(isWorkerSessionState(session)).toBe(true);
	expect(
		isWorkerSessionState({
			...session,
			connection: { ...session.connection, connectedAt: Number.NaN },
		}),
	).toBe(false);
	expect(
		isWorkerSessionState({
			...session,
			connection: { ...session.connection, connectedAt: -1 },
		}),
	).toBe(false);
	expect(
		isWorkerSessionState({
			...session,
			connection: {
				status: session.connection.status,
				serverUrl: session.connection.serverUrl,
			},
		}),
	).toBe(false);
});

test("requires system metrics as an independent Worker session state", () => {
	const session = {
		connection: {
			status: "disconnected",
			recentProvider: null,
			recentServerUrl: null,
		},
		backend: { status: "disconnected", editorComfyVersion: "0.33.1" },
		comfy: { status: "disconnected" },
		customNodes: { status: "disconnected" },
		models: { status: "disconnected" },
		verification: null,
		setup: { status: "idle" },
	};

	expect(isWorkerSessionState(session)).toBe(false);
	expect(
		isWorkerSessionState({ ...session, systemMetrics: { status: "disabled" } }),
	).toBe(true);
	expect(
		isWorkerSessionState({
			...session,
			systemMetrics: { status: "disconnected" },
			backend: { status: "disabled", editorComfyVersion: "0.33.1" },
		}),
	).toBe(false);
});

test("requires retryability for unavailable synchronization targets", () => {
	const unavailable = { status: "unavailable", error: "Worker unavailable." };

	expect(isWorkerCustomNodeSyncState(unavailable)).toBe(false);
	expect(isWorkerModelSyncState(unavailable)).toBe(false);
	expect(isWorkerCustomNodeSyncState({ ...unavailable, retryable: false })).toBe(true);
	expect(isWorkerModelSyncState({ ...unavailable, retryable: true })).toBe(true);
});

test("requires current contract metadata for model states", () => {
	expect(isWorkerModelSyncState({ status: "synced", models: [] })).toBe(false);
	expect(
		isWorkerModelSyncState({
			status: "idle",
			models: [],
			contractVersion: 2,
			target: null,
			operationId: null,
		}),
	).toBe(true);
});

test("validates Manager custom nodes with repository metadata", () => {
	const node = {
		name: "comfyui-kjnodes",
		managerId: "comfyui-kjnodes",
		version: "1.5.0",
		repository: "https://github.com/kijai/ComfyUI-KJNodes",
		sync: true,
	};

	expect(isCustomNodeEntry(node)).toBe(true);
	expect(
		isCustomNodeEntry({ ...node, workerSyncIssue: "Manager package is unavailable." }),
	).toBe(false);
	expect(
		isCustomNodeEntry({ ...node, repository: "ftp://github.com/kijai/repo" }),
	).toBe(false);
	expect(
		isCustomNodeEntry({
			...node,
			repository: "https://token@github.com/kijai/repo",
		}),
	).toBe(false);
});

test("validates canonical public GitHub custom nodes", () => {
	const commit = "a".repeat(40);
	const node = {
		name: "comfyui-obvpm",
		managerId: null,
		version: commit,
		repository: "https://github.com/obvpm/comfyui-obvpm.git",
		sync: true,
	};
	const currentState = (state: object, nodes: object[] = []) => ({
		contractVersion: 2,
		target: { managerVersion: "4.2.2", nodes },
		operationId: "custom-node-operation",
		...state,
	});
	const workerNode = {
		id: "obvpm/comfyui-obvpm",
		version: commit,
		repository: node.repository,
	};

	expect(isCustomNodeEntry(node)).toBe(true);
	expect(
		isCustomNodeEntry({
			...node,
			workerSyncIssue: "Local changes are not included in the commit.",
		}),
	).toBe(true);
	expect(
		isCustomNodeEntry({
			...node,
			version: "unknown",
			workerSyncIssue: "The Git repository does not have a valid HEAD commit.",
		}),
	).toBe(true);
	expect(
		isCustomNodeEntry({
			name: "manual-node",
			managerId: null,
			version: "unknown",
			workerSyncIssue: "No supported installation source was found.",
			sync: true,
		}),
	).toBe(true);
	expect(
		isCustomNodeEntry({
			name: "manual-node",
			managerId: null,
			version: "unknown",
			sync: true,
		}),
	).toBe(false);
	expect(isCustomNodeEntry({ ...node, version: "main" })).toBe(false);
	expect(
		isCustomNodeEntry({ ...node, repository: "git@github.com:obvpm/repo.git" }),
	).toBe(false);
	expect(
		isWorkerCustomNodeSyncState(
			currentState(
				{
					status: "ready",
					nodes: [workerNode],
					unsupportedNodes: [],
				},
				[workerNode],
			),
		),
	).toBe(true);
	expect(
		isWorkerCustomNodeSyncState({
			contractVersion: 2,
			target: {
				managerVersion: "4.2.2",
				nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
			},
			operationId: "custom-node-operation",
			status: "ready",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
			nodeSnapshot: {
				targetNodes: [
					{
						id: "comfyui-kjnodes",
						status: "installed",
						workerVersion: "1.5.0",
					},
				],
				activeNodes: [],
			},
			unsupportedNodes: [],
			targetNodes: [
				{
					id: "comfyui-kjnodes",
					editorVersion: "1.5.0",
					workerVersion: "1.5.0",
					status: "installed",
				},
			],
			unselectedNodes: [],
		}),
	).toBe(true);
	expect(
		isWorkerCustomNodeSyncState(
			currentState({
				status: "ready",
				nodes: [],
				unsupportedNodes: [],
				targetNodes: [
					{
						id: "comfyui-kjnodes",
						editorVersion: "1.5.0",
						workerVersion: "1.5.0",
						status: "failed",
					},
				],
			}),
		),
	).toBe(true);
	expect(
		isWorkerCustomNodeSyncState(
			currentState({
				status: "ready",
				nodes: [],
				unsupportedNodes: [],
				targetNodes: [
					{
						id: "comfyui-kjnodes",
						editorVersion: "1.5.0",
						workerVersion: "1.4.0",
						status: "installed",
					},
				],
			}),
		),
	).toBe(false);
	expect(
		isWorkerCustomNodeSyncState(
			currentState({
				status: "ready",
				nodes: [],
				unsupportedNodes: [
					{ name: "manual-node", reason: "No supported source was found." },
				],
			}),
		),
	).toBe(true);
	expect(
		isWorkerCustomNodeSyncState(
			currentState({
				status: "ready",
				nodes: [],
				unsupportedNodes: ["manual-node"],
			}),
		),
	).toBe(false);
	expect(
		isWorkerCustomNodeSyncState(
			currentState({
				status: "failed",
				nodes: [
					{
						name: "comfyui-obvpm",
						managerId: null,
						version: null,
						repository: node.repository,
					},
				],
				error: "Git checkout is dirty.",
				unsupportedNodes: [],
			}),
		),
	).toBe(true);
});

test("validates backend result retryability when present", () => {
	const failure = { ok: false, error: "Worker unavailable." };

	expect(isWorkerBackendResult(failure)).toBe(true);
	expect(isWorkerBackendResult({ ...failure, retryable: true })).toBe(true);
	expect(isWorkerBackendResult({ ...failure, retryable: "yes" })).toBe(false);
});
