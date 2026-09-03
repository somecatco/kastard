import { describe, expect, test } from "bun:test";
import type {
	CustomNodeSyncRequest,
	CustomNodeSyncState,
	ModelSyncRequest,
	ModelSyncState,
	ModelSyncTarget,
} from "@kastard/common";
import workerPackage from "../package.json" with { type: "json" };
import { createWorkerApp, readWorkerIdentity } from "./app";
import {
	type BackendProvisionerApi,
	BackendProvisionerController,
	BackendProvisioningError,
	type BackendState,
} from "./backend-provisioner";
import {
	type ComfyRuntimeApi,
	ComfyRuntimeController,
	ComfyRuntimeStartError,
} from "./comfy-runtime";
import {
	type CustomNodeProvisionerApi,
	CustomNodeProvisionerController,
	CustomNodeSyncError,
} from "./custom-node-provisioner";
import {
	type ModelProvisionerApi,
	ModelProvisionerController,
	ModelSyncError,
} from "./model-provisioner";
import type { WorkerSystemStatus } from "./system-status";
import { WorkerLogStore } from "./worker-log";
import { type WorkflowJobApi, WorkflowJobError } from "./workflow-job";

const CUSTOM_NODE_TARGET: CustomNodeSyncRequest = {
	managerVersion: "4.2.2",
	nodes: [],
};
const CUSTOM_NODE_OPERATION: {
	contractVersion: 2;
	target: CustomNodeSyncRequest;
	operationId: string;
} = {
	contractVersion: 2,
	target: CUSTOM_NODE_TARGET,
	operationId: "custom-node-operation",
};
const CUSTOM_NODE_IDLE: CustomNodeSyncState = {
	contractVersion: 2,
	target: null,
	operationId: null,
	status: "idle",
	nodes: [],
};
const MODEL_TARGET: ModelSyncTarget = {
	name: "Model",
	path: "checkpoints/model.safetensors",
	artifact: {
		provider: "huggingface",
		modelId: "owner/repository",
		versionId: "a".repeat(40),
		versionLabel: "main",
		fileId: "model.safetensors",
		fileName: "model.safetensors",
		sizeBytes: 12,
	},
};
const MODEL_REQUEST: ModelSyncRequest = { models: [MODEL_TARGET], credentials: {} };
const MODEL_IDLE: ModelSyncState = {
	contractVersion: 2,
	capabilities: { forceRedownload: true },
	target: null,
	operationId: null,
	status: "idle",
	models: null,
};

function modelOperationState(state: {
	status: Exclude<ModelSyncState["status"], "idle">;
	[key: string]: unknown;
}): ModelSyncState {
	return {
		...state,
		contractVersion: 2,
		capabilities: { forceRedownload: true },
		target: { models: MODEL_REQUEST.models },
		operationId: "model-operation",
		operationKind: "sync",
	} as ModelSyncState;
}

describe("Kastard Worker HTTP API", () => {
	test("reports the Worker release identity", () => {
		const sourceRevision = "a".repeat(40);
		expect(
			readWorkerIdentity({
				KASTARD_CHANNEL: "production",
				KASTARD_PRODUCT_VERSION: "0.2.0",
				KASTARD_SOURCE_REVISION: sourceRevision,
			}),
		).toEqual({
			buildNumber: workerPackage.buildNumber,
			channel: "production",
			productVersion: "0.2.0",
			sourceRevision,
		});
		expect(
			readWorkerIdentity({
				KASTARD_CHANNEL: "preview",
				KASTARD_SOURCE_REVISION: sourceRevision,
			}),
		).toEqual({
			buildNumber: workerPackage.buildNumber,
			channel: "preview",
			productVersion: null,
			sourceRevision,
		});
	});

	test("rejects incomplete Worker release metadata", () => {
		expect(() => readWorkerIdentity({ KASTARD_CHANNEL: "preview" })).toThrow(
			"KASTARD_SOURCE_REVISION",
		);
		expect(() =>
			readWorkerIdentity({
				KASTARD_CHANNEL: "production",
				KASTARD_SOURCE_REVISION: "a".repeat(40),
			}),
		).toThrow("KASTARD_PRODUCT_VERSION");
	});

	test("reports health and accepts a connection", async () => {
		const app = createWorkerApp();

		const health = await app.request("/health");
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ status: "ok" });

		const connection = await app.request("/connection");
		expect(connection.status).toBe(200);
		expect(await connection.json()).toEqual({
			status: "connected",
			worker: {
				buildNumber: workerPackage.buildNumber,
				channel: "development",
				productVersion: null,
				sourceRevision: null,
			},
		});
	});

	test("returns logs recorded after the explicit connection", async () => {
		let now = 0;
		const logs = new WorkerLogStore({
			instanceId: "worker-one",
			now: () => new Date(now++ * 1_000),
		});
		const app = createWorkerApp(logs);
		logs.write("info", "Before connection.");

		const connection = await app.request("/connection", {
			method: "POST",
		});
		expect(connection.status).toBe(200);
		expect(await connection.json()).toEqual({
			status: "connected",
			logCursor: "worker-one:1",
			worker: {
				buildNumber: workerPackage.buildNumber,
				channel: "development",
				productVersion: null,
				sourceRevision: null,
			},
		});

		const response = await app.request("/logs?after=worker-one%3A1");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			logs: [
				{
					id: "worker-one:2",
					timestamp: "1970-01-01T00:00:01.000Z",
					level: "info",
					message: "Editor connected.",
				},
			],
			cursor: "worker-one:2",
			truncated: false,
		});
	});

	test("requires a valid log cursor", async () => {
		const app = createWorkerApp();

		expect((await app.request("/logs")).status).toBe(400);
		expect((await app.request("/logs?after=invalid")).status).toBe(400);
	});

	test("does not expose pairing and session endpoints", async () => {
		const app = createWorkerApp();

		expect((await app.request("/pair", { method: "POST" })).status).toBe(404);
		expect((await app.request("/session")).status).toBe(404);
	});

	test("serves current system status", async () => {
		const state: WorkerSystemStatus = {
			sampledAt: "2026-08-17T07:00:00.000Z",
			cpu: { usagePercent: 12 },
			ram: { usedBytes: 4, totalBytes: 8, usagePercent: 50 },
			disk: { path: "/workspace", usedBytes: 3, totalBytes: 10, usagePercent: 30 },
			gpus: [],
		};
		const app = createWorkerApp(
			new WorkerLogStore(),
			undefined,
			undefined,
			undefined,
			undefined,
			{ getState: () => state },
		);

		const response = await app.request("/system/status");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(state);
	});

	test("reads and starts backend preparation", async () => {
		const backend = backendStub();
		const app = createWorkerApp(new WorkerLogStore(), backend);
		const headers = {
			"Content-Type": "application/json",
		};

		const current = await app.request("/comfyui", { headers });
		expect(current.status).toBe(200);
		expect(await current.json()).toEqual(backend.getState());

		const target = {
			version: "0.33.1",
			archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.33.1.zip",
			sha256: "a".repeat(64),
		};
		const prepare = await app.request("/comfyui/prepare", {
			method: "POST",
			headers,
			body: JSON.stringify(target),
		});
		expect(prepare.status).toBe(202);
		expect(await prepare.json()).toMatchObject({
			status: "preparing",
			targetVersion: "0.33.1",
		});
	});

	test("returns preparation conflicts", async () => {
		const backend = backendStub(true);
		const app = createWorkerApp(new WorkerLogStore(), backend);
		const headers = {
			"Content-Type": "application/json",
		};

		expect(
			(
				await app.request("/comfyui/prepare", {
					method: "POST",
					headers,
					body: "{}",
				})
			).status,
		).toBe(409);
	});

	test("keeps the Worker reachable while backend provisioning is unavailable", async () => {
		const backend = new BackendProvisionerController();
		const app = createWorkerApp(new WorkerLogStore(), backend);
		const headers = {};

		expect((await app.request("/health")).status).toBe(200);
		const initializing = await app.request("/comfyui", { headers });
		expect(initializing.status).toBe(503);
		expect(await initializing.json()).toEqual({
			error: "Backend provisioning is initializing.",
			retryable: true,
		});

		backend.fail("KASTARD_COMFYUI_ROOT is not writable.");
		const unavailable = await app.request("/comfyui", { headers });
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toEqual({
			error: "KASTARD_COMFYUI_ROOT is not writable.",
			retryable: false,
		});
	});

	test("reads and starts Worker ComfyUI", async () => {
		let state: ReturnType<ComfyRuntimeApi["getState"]> = { status: "stopped" };
		const runtime: ComfyRuntimeApi = {
			getState: () => state,
			isActive: () => state.status === "starting" || state.status === "ready",
			start: () => {
				state = { status: "starting" };
				return state;
			},
			restart: async () => {
				state = { status: "starting" };
				return state;
			},
			freeMemory: async () => undefined,
		};
		const app = createWorkerApp(
			new WorkerLogStore(),
			backendStub(),
			undefined,
			undefined,
			runtime,
		);
		const headers = {};

		expect(await (await app.request("/comfyui/runtime", { headers })).json()).toEqual({
			status: "stopped",
		});
		const start = await app.request("/comfyui/runtime", {
			method: "POST",
			headers,
		});
		expect(start.status).toBe(202);
		expect(await start.json()).toEqual({ status: "starting" });
		const restart = await app.request("/comfyui/runtime/restart", {
			method: "POST",
			headers,
		});
		expect(restart.status).toBe(202);
		expect(await restart.json()).toEqual({ status: "starting" });
	});

	test("forwards supported Worker ComfyUI memory cleanup actions", async () => {
		const cleanupRequests: unknown[] = [];
		const runtime: ComfyRuntimeApi = {
			getState: () => ({ status: "ready" }),
			isActive: () => true,
			start: () => ({ status: "ready" }),
			restart: async () => ({ status: "starting" }),
			freeMemory: async (request) => {
				cleanupRequests.push(request);
			},
		};
		const app = createWorkerApp(
			new WorkerLogStore(),
			backendStub(),
			undefined,
			undefined,
			runtime,
		);

		for (const request of [
			{ unload_models: true },
			{ unload_models: true, free_memory: true },
		]) {
			const response = await app.request("/comfyui/runtime/free", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({});
		}
		expect(cleanupRequests).toEqual([
			{ unload_models: true },
			{ unload_models: true, free_memory: true },
		]);

		const invalid = await app.request("/comfyui/runtime/free", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ unload_models: false, free_memory: true }),
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({
			error: "Invalid ComfyUI memory cleanup request.",
		});
		expect(cleanupRequests).toHaveLength(2);
	});

	test("reports unavailable Worker ComfyUI memory cleanup", async () => {
		const controller = new ComfyRuntimeController();
		const app = createWorkerApp(
			new WorkerLogStore(),
			backendStub(),
			undefined,
			undefined,
			controller,
		);
		const response = await app.request("/comfyui/runtime/free", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ unload_models: true }),
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "ComfyUI execution is initializing.",
			retryable: true,
		});
	});

	test("returns Worker ComfyUI conflicts and initialization errors", async () => {
		const controller = new ComfyRuntimeController();
		const app = createWorkerApp(
			new WorkerLogStore(),
			backendStub(),
			undefined,
			undefined,
			controller,
		);
		const headers = {};

		const initializing = await app.request("/comfyui/runtime", { headers });
		expect(initializing.status).toBe(503);
		expect(await initializing.json()).toEqual({
			error: "ComfyUI execution is initializing.",
			retryable: true,
		});

		controller.attach({
			getState: () => ({ status: "stopped" }),
			isActive: () => false,
			start: () => {
				throw new ComfyRuntimeStartError("Backend is not ready.", 409);
			},
			restart: async () => {
				throw new ComfyRuntimeStartError("Backend is not ready.", 409);
			},
			freeMemory: async () => undefined,
		});
		const conflict = await app.request("/comfyui/runtime", {
			method: "POST",
			headers,
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ error: "Backend is not ready." });
	});

	test("starts ComfyUI during model sync while keeping incompatible operations exclusive", async () => {
		let runtimeState: ReturnType<ComfyRuntimeApi["getState"]> = {
			status: "stopped",
		};
		let customNodeState: ReturnType<CustomNodeProvisionerApi["getState"]> = {
			...CUSTOM_NODE_OPERATION,
			status: "syncing",
			phase: "install",
			current: 0,
			total: 1,
			currentNode: null,
		};
		let modelState: ReturnType<ModelProvisionerApi["getState"]> = MODEL_IDLE;
		let runtimeStarts = 0;
		let runtimeProcessActive = false;
		let customNodeStarts = 0;
		let modelStarts = 0;
		const runtime: ComfyRuntimeApi = {
			getState: () => runtimeState,
			isActive: () =>
				runtimeProcessActive ||
				runtimeState.status === "starting" ||
				runtimeState.status === "ready",
			start: () => {
				runtimeStarts += 1;
				runtimeState = { status: "starting" };
				return runtimeState;
			},
			restart: async () => {
				runtimeState = { status: "starting" };
				return runtimeState;
			},
			freeMemory: async () => undefined,
		};
		const customNodes: CustomNodeProvisionerApi = {
			getState: () => customNodeState,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => {
				customNodeStarts += 1;
				return customNodeState;
			},
			reinstall: () => {
				customNodeStarts += 1;
				return customNodeState;
			},
			remove: () => {
				customNodeStarts += 1;
				return customNodeState;
			},
			cancel: () => ({ ...CUSTOM_NODE_OPERATION, status: "canceling" }),
		};
		const models: ModelProvisionerApi = {
			getState: () => modelState,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => {
				modelStarts += 1;
				return modelState;
			},
			redownload: () => modelState,
			cancel: () => modelOperationState({ status: "canceling" }),
		};
		const app = createWorkerApp(
			new WorkerLogStore(),
			backendStub(),
			customNodes,
			models,
			runtime,
		);
		const headers = {
			"Content-Type": "application/json",
		};

		const customNodeConflict = await app.request("/comfyui/runtime", {
			method: "POST",
			headers,
		});
		expect(customNodeConflict.status).toBe(409);
		expect(await customNodeConflict.json()).toEqual({
			error: "Worker custom node synchronization must finish before starting ComfyUI.",
		});

		customNodeState = CUSTOM_NODE_IDLE;
		modelState = modelOperationState({ status: "checking", total: 1, totalBytes: 12 });
		const modelSyncStart = await app.request("/comfyui/runtime", {
			method: "POST",
			headers,
		});
		expect(modelSyncStart.status).toBe(202);
		expect(runtimeStarts).toBe(1);

		runtimeState = { status: "stopped" };
		const redownloadState = modelOperationState({
			status: "syncing",
			completed: 0,
			total: 1,
		});
		if (redownloadState.status !== "syncing") throw new Error("Invalid test state.");
		modelState = {
			...redownloadState,
			operationKind: "redownload",
		};
		const modelRedownloadConflict = await app.request("/comfyui/runtime", {
			method: "POST",
			headers,
		});
		expect(modelRedownloadConflict.status).toBe(409);
		expect(await modelRedownloadConflict.json()).toEqual({
			error: "Worker model redownload must finish before starting ComfyUI.",
		});
		expect(runtimeStarts).toBe(1);

		modelState = MODEL_IDLE;
		runtimeState = { status: "starting" };
		const customNodeSync = await app.request("/sync", {
			method: "POST",
			headers,
			body: JSON.stringify({ managerVersion: "4.2.2", nodes: [] }),
		});
		expect(customNodeSync.status).toBe(409);
		expect(await customNodeSync.json()).toEqual({
			error:
				"Worker ComfyUI must finish starting or restarting before synchronization.",
		});
		const modelSyncWhileStarting = await app.request("/models/sync", {
			method: "POST",
			headers,
			body: JSON.stringify({ models: [], credentials: {} }),
		});
		expect(modelSyncWhileStarting.status).toBe(202);
		expect(customNodeStarts).toBe(0);
		expect(modelStarts).toBe(1);

		runtimeState = { status: "ready" };
		const modelSync = await app.request("/models/sync", {
			method: "POST",
			headers,
			body: JSON.stringify({ models: [], credentials: {} }),
		});
		expect(modelSync.status).toBe(202);
		expect(modelStarts).toBe(2);

		runtimeState = { status: "failed", error: "ComfyUI is not responding." };
		runtimeProcessActive = true;
		const terminatingProcessSync = await app.request("/sync", {
			method: "POST",
			headers,
			body: JSON.stringify({ managerVersion: "4.2.2", nodes: [] }),
		});
		expect(terminatingProcessSync.status).toBe(409);
		expect(customNodeStarts).toBe(0);

		runtimeProcessActive = false;
		const failedRuntimeSync = await app.request("/sync", {
			method: "POST",
			headers,
			body: JSON.stringify({ managerVersion: "4.2.2", nodes: [] }),
		});
		expect(failedRuntimeSync.status).toBe(202);
		expect(customNodeStarts).toBe(1);
		expect(modelStarts).toBe(2);

		runtimeState = { status: "stopped" };
		runtimeProcessActive = true;
		const stoppedProcessSync = await app.request("/models/sync", {
			method: "POST",
			headers,
			body: JSON.stringify({ models: [], credentials: {} }),
		});
		expect(stoppedProcessSync.status).toBe(409);
		expect(customNodeStarts).toBe(1);
		expect(modelStarts).toBe(2);
	});

	test("keeps provisioning and synchronization exclusive with a Worker ComfyUI restart", async () => {
		let resolveRestart: () => void = () => undefined;
		let markRestartStarted: () => void = () => undefined;
		const restartStarted = new Promise<void>((resolve) => {
			markRestartStarted = resolve;
		});
		const restartGate = new Promise<void>((resolve) => {
			resolveRestart = resolve;
		});
		let customNodeStarts = 0;
		let modelStarts = 0;
		let runtimeRestarts = 0;
		const runtime: ComfyRuntimeApi = {
			getState: () => ({ status: "stopped" }),
			isActive: () => false,
			start: () => ({ status: "starting" }),
			restart: async () => {
				runtimeRestarts += 1;
				markRestartStarted();
				await restartGate;
				return { status: "starting" };
			},
			freeMemory: async () => undefined,
		};
		const customNodes: CustomNodeProvisionerApi = {
			getState: () => CUSTOM_NODE_IDLE,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => {
				customNodeStarts += 1;
				return CUSTOM_NODE_IDLE;
			},
			reinstall: () => {
				customNodeStarts += 1;
				return CUSTOM_NODE_IDLE;
			},
			remove: () => {
				customNodeStarts += 1;
				return CUSTOM_NODE_IDLE;
			},
			cancel: () => ({ ...CUSTOM_NODE_OPERATION, status: "canceling" }),
		};
		const models: ModelProvisionerApi = {
			getState: () => MODEL_IDLE,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => {
				modelStarts += 1;
				return MODEL_IDLE;
			},
			redownload: () => MODEL_IDLE,
			cancel: () => modelOperationState({ status: "canceling" }),
		};
		const backend = backendStub();
		const app = createWorkerApp(
			new WorkerLogStore(),
			backend,
			customNodes,
			models,
			runtime,
		);
		const headers = {
			"Content-Type": "application/json",
		};

		const restartRequest = app.request("/comfyui/runtime/restart", {
			method: "POST",
			headers,
		});
		await restartStarted;
		const [
			customNodeSync,
			customNodeReinstall,
			modelSync,
			backendPreparation,
			duplicateRestart,
		] = await Promise.all([
			app.request("/sync", {
				method: "POST",
				headers,
				body: JSON.stringify(CUSTOM_NODE_TARGET),
			}),
			app.request("/sync/reinstall", {
				method: "POST",
				headers,
				body: JSON.stringify({
					managerVersion: "4.2.2",
					nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
				}),
			}),
			app.request("/models/sync", {
				method: "POST",
				headers,
				body: JSON.stringify({ models: [], credentials: {} }),
			}),
			app.request("/comfyui/prepare", {
				method: "POST",
				headers,
				body: JSON.stringify({ version: "0.33.1" }),
			}),
			app.request("/comfyui/runtime/restart", { method: "POST", headers }),
		]);
		expect(customNodeSync.status).toBe(409);
		expect(customNodeReinstall.status).toBe(409);
		expect(modelSync.status).toBe(409);
		expect(backendPreparation.status).toBe(409);
		expect(duplicateRestart.status).toBe(409);
		expect(customNodeStarts).toBe(0);
		expect(modelStarts).toBe(0);

		resolveRestart();
		expect((await restartRequest).status).toBe(202);
		expect(runtimeRestarts).toBe(1);

		const preparation = await app.request("/comfyui/prepare", {
			method: "POST",
			headers,
			body: JSON.stringify({ version: "0.33.1" }),
		});
		expect(preparation.status).toBe(202);
		expect(
			(
				await app.request("/comfyui/runtime/restart", {
					method: "POST",
					headers,
				})
			).status,
		).toBe(409);
		expect(runtimeRestarts).toBe(1);
	});

	test("reads and starts custom node synchronization", async () => {
		let request: unknown;
		let reinstallRequest: unknown;
		let removalRequest: unknown;
		let canceledOperationId: string | undefined;
		const customNodes: CustomNodeProvisionerApi = {
			getState: () => CUSTOM_NODE_IDLE,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: (value) => {
				request = value;
				return {
					...CUSTOM_NODE_OPERATION,
					status: "syncing",
					phase: "install",
					current: 0,
					total: 1,
					currentNode: null,
				};
			},
			reinstall: (value) => {
				reinstallRequest = value;
				return {
					...CUSTOM_NODE_OPERATION,
					operationKind: "reinstall",
					status: "syncing",
					phase: "install",
					current: 0,
					total: 1,
					currentNode: null,
				};
			},
			remove: (value) => {
				removalRequest = value;
				return {
					...CUSTOM_NODE_OPERATION,
					operationKind: "remove",
					removalNode: {
						name: "manual.py",
						managerId: null,
						version: null,
					},
					status: "syncing",
					phase: "remove",
					removalPhase: "prepare",
					current: 0,
					total: 1,
					currentNode: "manual.py",
				};
			},
			cancel: (operationId) => {
				canceledOperationId = operationId;
				return { ...CUSTOM_NODE_OPERATION, status: "canceling" };
			},
		};
		const app = createWorkerApp(new WorkerLogStore(), backendStub(), customNodes);
		const headers = {
			"Content-Type": "application/json",
		};

		const current = await app.request("/sync", { headers });
		expect(await current.json()).toMatchObject({
			contractVersion: 2,
			status: "idle",
			nodes: [],
		});

		const nodes = [{ id: "comfyui-kjnodes", version: "1.5.0" }];
		const managerVersion = "4.2.2";
		const start = await app.request("/sync", {
			method: "POST",
			headers,
			body: JSON.stringify({ managerVersion, nodes }),
		});
		expect(start.status).toBe(202);
		expect(request).toEqual({ managerVersion, nodes });
		expect(await start.json()).toMatchObject({
			status: "syncing",
			phase: "install",
		});
		const reinstall = await app.request("/sync/reinstall", {
			method: "POST",
			headers,
			body: JSON.stringify({ managerVersion, nodes }),
		});
		expect(reinstall.status).toBe(202);
		expect(reinstallRequest).toEqual({ managerVersion, nodes });
		expect(await reinstall.json()).toMatchObject({
			status: "syncing",
			operationKind: "reinstall",
		});
		const removalNode = { name: "manual.py", managerId: null, version: null };
		const removal = await app.request("/sync/remove", {
			method: "POST",
			headers,
			body: JSON.stringify({ managerVersion, nodes, node: removalNode }),
		});
		expect(removal.status).toBe(202);
		expect(removalRequest).toEqual({ managerVersion, nodes, node: removalNode });
		expect(await removal.json()).toMatchObject({
			status: "syncing",
			operationKind: "remove",
			removalNode,
		});
		const cancel = await app.request("/sync/custom-node-operation", {
			method: "DELETE",
			headers,
		});
		expect(cancel.status).toBe(202);
		expect(await cancel.json()).toMatchObject({
			status: "canceling",
			operationId: "custom-node-operation",
		});
		expect(canceledOperationId).toBe("custom-node-operation");
	});

	test("returns custom node conflicts and initialization errors", async () => {
		const controller = new CustomNodeProvisionerController();
		const app = createWorkerApp(new WorkerLogStore(), backendStub(), controller);
		const headers = {
			"Content-Type": "application/json",
		};

		const initializing = await app.request("/sync", { headers });
		expect(initializing.status).toBe(503);
		expect(await initializing.json()).toEqual({
			error: "Custom node synchronization is initializing.",
			retryable: true,
		});

		controller.attach({
			getState: () => CUSTOM_NODE_IDLE,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => {
				throw new CustomNodeSyncError("Already syncing.", 409);
			},
			reinstall: () => {
				throw new CustomNodeSyncError("Already syncing.", 409);
			},
			remove: () => {
				throw new CustomNodeSyncError("Already syncing.", 409);
			},
			cancel: () => {
				throw new CustomNodeSyncError("Not syncing.", 409);
			},
		});
		const conflict = await app.request("/sync", {
			method: "POST",
			headers,
			body: JSON.stringify({ managerVersion: "4.2.2", nodes: [] }),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ error: "Already syncing." });
		const cancelConflict = await app.request("/sync", {
			method: "DELETE",
			headers,
		});
		expect(cancelConflict.status).toBe(409);
		expect(await cancelConflict.json()).toEqual({ error: "Not syncing." });
	});

	test("reads and starts model synchronization", async () => {
		let request: unknown;
		let canceled = false;
		let canceledOperationId: string | undefined;
		const models: ModelProvisionerApi = {
			getState: () => MODEL_IDLE,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: (value) => {
				request = value;
				return modelOperationState({ status: "checking", total: 1, totalBytes: 12 });
			},
			redownload: (value) => {
				request = value;
				return modelOperationState({ status: "checking", total: 1, totalBytes: 12 });
			},
			cancel: (operationId) => {
				canceled = true;
				canceledOperationId = operationId;
				return modelOperationState({ status: "canceling" });
			},
		};
		const app = createWorkerApp(new WorkerLogStore(), backendStub(), undefined, models);
		const headers = {
			"Content-Type": "application/json",
		};

		const current = await app.request("/models/sync", { headers });
		expect(await current.json()).toEqual(MODEL_IDLE);
		const body = { models: [{ name: "model" }], credentials: {} };
		const start = await app.request("/models/sync", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		expect(start.status).toBe(202);
		expect(request).toEqual(body);
		expect(await start.json()).toEqual(
			modelOperationState({ status: "checking", total: 1, totalBytes: 12 }),
		);
		const redownload = await app.request("/models/redownload", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		expect(redownload.status).toBe(202);
		expect(request).toEqual(body);
		const cancel = await app.request("/models/sync/model-operation", {
			method: "DELETE",
			headers,
		});
		expect(cancel.status).toBe(202);
		expect(await cancel.json()).toEqual(modelOperationState({ status: "canceling" }));
		expect(canceled).toBe(true);
		expect(canceledOperationId).toBe("model-operation");
	});

	test("blocks force redownload while a workflow is active", async () => {
		let redownloads = 0;
		const models: ModelProvisionerApi = {
			getState: () => MODEL_IDLE,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => MODEL_IDLE,
			redownload: () => {
				redownloads += 1;
				return MODEL_IDLE;
			},
			cancel: () => MODEL_IDLE,
		};
		const app = createWorkerApp(
			new WorkerLogStore(),
			undefined,
			undefined,
			models,
			undefined,
			undefined,
			{ hasActiveJob: () => true } as WorkflowJobApi,
		);

		const response = await app.request("/models/redownload", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(MODEL_REQUEST),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "Worker models cannot be redownloaded while a workflow is running.",
		});
		expect(redownloads).toBe(0);
	});

	test("blocks custom node removal while a workflow is active", async () => {
		let removals = 0;
		const customNodes: CustomNodeProvisionerApi = {
			getState: () => CUSTOM_NODE_IDLE,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => CUSTOM_NODE_IDLE,
			reinstall: () => CUSTOM_NODE_IDLE,
			remove: () => {
				removals += 1;
				return CUSTOM_NODE_IDLE;
			},
			cancel: () => CUSTOM_NODE_IDLE,
		};
		const app = createWorkerApp(
			new WorkerLogStore(),
			undefined,
			customNodes,
			undefined,
			undefined,
			undefined,
			{ hasActiveJob: () => true } as WorkflowJobApi,
		);

		const response = await app.request("/sync/remove", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				managerVersion: "4.2.2",
				nodes: [],
				node: { name: "manual.py", managerId: null, version: null },
			}),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "Worker custom nodes cannot be removed while a workflow is running.",
		});
		expect(removals).toBe(0);
	});

	test("returns model sync conflicts and initialization errors", async () => {
		const controller = new ModelProvisionerController();
		const app = createWorkerApp(
			new WorkerLogStore(),
			backendStub(),
			undefined,
			controller,
		);
		const headers = {
			"Content-Type": "application/json",
		};

		const initializing = await app.request("/models/sync", { headers });
		expect(initializing.status).toBe(503);
		expect(await initializing.json()).toEqual({
			error: "Model synchronization is initializing.",
			retryable: true,
		});

		controller.attach({
			getState: () => MODEL_IDLE,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => {
				throw new ModelSyncError("Already syncing.", 409);
			},
			redownload: () => {
				throw new ModelSyncError("Already syncing.", 409);
			},
			cancel: () => {
				throw new ModelSyncError("Not syncing.", 409);
			},
		});
		const conflict = await app.request("/models/sync", {
			method: "POST",
			headers,
			body: JSON.stringify({ models: [], credentials: {} }),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ error: "Already syncing." });
		const cancelConflict = await app.request("/models/sync", {
			method: "DELETE",
			headers,
		});
		expect(cancelConflict.status).toBe(409);
		expect(await cancelConflict.json()).toEqual({ error: "Not syncing." });
	});

	test("verifies backend, models, and custom nodes through one endpoint", async () => {
		const runtime = {
			cudaVersion: "12.8",
			pythonVersion: "3.12.13",
			torchVersion: "2.11.0+cu128",
			torchvisionVersion: "0.26.0+cu128",
			torchaudioVersion: "2.11.0+cu128",
			uvVersion: "0.12.4",
		};
		const backend: BackendProvisionerApi = {
			getState: () => ({ status: "ready", version: "0.33.1", runtime }),
			prepare: () => ({ status: "ready", version: "0.33.1", runtime }),
		};
		let customNodeRequest: unknown;
		const customNodes: CustomNodeProvisionerApi = {
			getState: () => ({ ...CUSTOM_NODE_OPERATION, status: "ready", nodes: [] }),
			verify: async (request) => {
				customNodeRequest = request;
				return { status: "synced", total: 0 };
			},
			sync: () => ({ ...CUSTOM_NODE_OPERATION, status: "ready", nodes: [] }),
			reinstall: () => ({ ...CUSTOM_NODE_OPERATION, status: "ready", nodes: [] }),
			remove: () => ({ ...CUSTOM_NODE_OPERATION, status: "ready", nodes: [] }),
			cancel: () => ({ ...CUSTOM_NODE_OPERATION, status: "canceling" }),
		};
		let modelRequest: unknown;
		const models: ModelProvisionerApi = {
			getState: () => modelOperationState({ status: "synced", models: [] }),
			verify: async (request) => {
				modelRequest = request;
				return { status: "synced", total: 0 };
			},
			sync: () => modelOperationState({ status: "synced", models: [] }),
			redownload: () => modelOperationState({ status: "synced", models: [] }),
			cancel: () => modelOperationState({ status: "canceling" }),
		};
		const app = createWorkerApp(new WorkerLogStore(), backend, customNodes, models);
		const request = {
			backendVersion: "0.33.1",
			models: [],
			customNodes: {
				managerVersion: "4.2.2",
				nodes: [],
				unsupportedNodes: [],
			},
		};

		expect(
			(
				await app.request("/sync/verify", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({}),
				})
			).status,
		).toBe(400);
		const response = await app.request("/sync/verify", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "synced",
			backend: {
				status: "synced",
				expectedVersion: "0.33.1",
				actualVersion: "0.33.1",
			},
			models: { status: "synced", total: 0 },
			customNodes: { status: "synced", total: 0 },
		});
		expect(modelRequest).toEqual({ models: [] });
		expect(customNodeRequest).toEqual({ managerVersion: "4.2.2", nodes: [] });

		const mismatchResponse = await app.request("/sync/verify", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				...request,
				backendVersion: "0.34.0",
				customNodes: {
					...request.customNodes,
					unsupportedNodes: ["local-git-node"],
				},
			}),
		});
		expect(mismatchResponse.status).toBe(200);
		expect(await mismatchResponse.json()).toMatchObject({
			status: "out-of-sync",
			backend: {
				status: "out-of-sync",
				expectedVersion: "0.34.0",
				actualVersion: "0.33.1",
				reason: "version-mismatch",
			},
			customNodes: {
				status: "out-of-sync",
				problems: [{ reason: "unsupported", name: "local-git-node" }],
			},
		});
	});

	test("exposes the Kastard workflow job contract", async () => {
		const jobId = "11111111-1111-4111-8111-111111111111";
		const otherJobId = "22222222-2222-4222-8222-222222222222";
		const inputId = "b".repeat(64);
		let submitted: unknown = null;
		let uploaded: unknown = null;
		let discarded: string | null = null;
		let canceled: string | null = null;
		let busy = false;
		let modelOperationKind: "sync" | "redownload" = "redownload";
		let customNodeState: CustomNodeSyncState = CUSTOM_NODE_IDLE;
		const customNodes: CustomNodeProvisionerApi = {
			getState: () => customNodeState,
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => customNodeState,
			reinstall: () => customNodeState,
			remove: () => customNodeState,
			cancel: () => customNodeState,
		};
		const models: ModelProvisionerApi = {
			getState: () => ({
				contractVersion: 2,
				capabilities: { forceRedownload: true },
				target: { models: MODEL_REQUEST.models },
				operationId: "model-operation",
				operationKind: modelOperationKind,
				status: "checking",
				total: 1,
				totalBytes: 12,
			}),
			verify: async () => ({ status: "synced", total: 0 }),
			sync: () => MODEL_IDLE,
			redownload: () => MODEL_IDLE,
			cancel: () => MODEL_IDLE,
		};
		const workflowJobs: WorkflowJobApi = {
			cancel: async (requestedId) => {
				canceled = requestedId;
				return { id: requestedId, status: "canceled" };
			},
			getResults: (requestedId) =>
				requestedId === jobId
					? { id: jobId, outputs: { "1": { images: [] } }, files: [] }
					: null,
			getResultFile: () => null,
			subscribeEvents: () => () => undefined,
			uploadInput: async (requestedId, requestedInputId, body, size, sha256) => {
				uploaded = {
					jobId: requestedId,
					inputId: requestedInputId,
					body: await new Response(body).text(),
					size,
					sha256,
				};
			},
			discardInputs: async (requestedId) => {
				discarded = requestedId;
			},
			submit: async (requestedId, request) => {
				if (busy) {
					throw new WorkflowJobError(
						"The Worker is already processing a workflow.",
						409,
						true,
					);
				}
				submitted = { id: requestedId, request };
				return { id: jobId, status: "running" };
			},
			get: (requestedId) =>
				requestedId === jobId ? { id: jobId, status: "completed" } : null,
			hasActiveJob: () => busy,
		};
		const app = createWorkerApp(
			new WorkerLogStore(),
			undefined,
			customNodes,
			models,
			undefined,
			undefined,
			workflowJobs,
		);
		const headers = {
			"Content-Type": "application/json",
		};
		const request = { prompt: { "1": { class_type: "TestNode", inputs: {} } } };

		const upload = await app.request(`/workflow-jobs/${jobId}/inputs/${inputId}`, {
			method: "PUT",
			headers: {
				"Content-Length": "5",
				"Content-Type": "application/octet-stream",
				"X-Kastard-Input-SHA256": inputId,
			},
			body: "bytes",
		});
		expect(upload.status).toBe(204);
		expect(uploaded).toEqual({
			jobId,
			inputId,
			body: "bytes",
			size: 5,
			sha256: inputId,
		});
		const discard = await app.request(`/workflow-jobs/${jobId}/inputs`, {
			method: "DELETE",
			headers,
		});
		expect(discard.status).toBe(204);
		expect(discarded as string | null).toBe(jobId);

		const redownloadConflict = await app.request(`/workflow-jobs/${jobId}`, {
			method: "PUT",
			headers,
			body: JSON.stringify(request),
		});
		expect(redownloadConflict.status).toBe(409);
		expect(await redownloadConflict.json()).toEqual({
			accepted: false,
			error:
				"The Worker must finish redownloading its model before starting a workflow.",
			retryable: true,
		});
		expect(submitted).toBeNull();

		modelOperationKind = "sync";
		customNodeState = {
			...CUSTOM_NODE_OPERATION,
			operationKind: "remove",
			removalNode: { name: "manual.py", managerId: null, version: null },
			status: "syncing",
			phase: "remove",
			removalPhase: "remove",
			current: 0,
			total: 1,
			currentNode: "manual.py",
		};
		const customNodeConflict = await app.request(`/workflow-jobs/${jobId}`, {
			method: "PUT",
			headers,
			body: JSON.stringify(request),
		});
		expect(customNodeConflict.status).toBe(409);
		expect(await customNodeConflict.json()).toEqual({
			accepted: false,
			error:
				"The Worker must finish synchronizing its custom nodes before starting a workflow.",
			retryable: true,
		});
		expect(submitted).toBeNull();

		customNodeState = CUSTOM_NODE_IDLE;
		const submit = await app.request(`/workflow-jobs/${jobId}`, {
			method: "PUT",
			headers,
			body: JSON.stringify(request),
		});
		expect(submit.status).toBe(202);
		expect(await submit.json()).toEqual({ id: jobId, status: "running" });
		expect(submitted).toEqual({ id: jobId, request });
		const cancel = await app.request(`/workflow-jobs/${jobId}`, {
			method: "DELETE",
			headers,
		});
		expect(cancel.status).toBe(202);
		expect(await cancel.json()).toEqual({ id: jobId, status: "canceled" });
		expect(canceled as string | null).toBe(jobId);
		busy = true;
		const conflict = await app.request(`/workflow-jobs/${otherJobId}`, {
			method: "PUT",
			headers,
			body: JSON.stringify(request),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({
			accepted: false,
			error: "The Worker is already processing a workflow.",
			retryable: true,
		});
		expect(
			await (await app.request(`/workflow-jobs/${jobId}`, { headers })).json(),
		).toEqual({ id: jobId, status: "completed" });
		expect(
			await (await app.request(`/workflow-jobs/${jobId}/results`, { headers })).json(),
		).toEqual({ id: jobId, outputs: { "1": { images: [] } }, files: [] });

		expect((await app.request("/prompt", { method: "POST", headers })).status).toBe(
			404,
		);
		expect(
			(await app.request("/workflow-jobs", { method: "POST", headers })).status,
		).toBe(404);
		expect((await app.request("/api/prompt", { method: "POST", headers })).status).toBe(
			404,
		);
	});
});

function backendStub(conflict = false): BackendProvisionerApi {
	const runtime = {
		cudaVersion: "12.8",
		pythonVersion: "3.12.13",
		torchVersion: "2.11.0+cu128",
		torchvisionVersion: "0.26.0+cu128",
		torchaudioVersion: "2.11.0+cu128",
		uvVersion: "0.12.4",
	};
	let state: BackendState = { status: "not-installed", runtime };
	return {
		getState: () => state,
		prepare: (target: unknown) => {
			if (conflict) throw new BackendProvisioningError("Already preparing.", 409);
			const version = (target as { version: string }).version;
			state = {
				status: "preparing",
				targetVersion: version,
				phase: "download",
				progress: 0,
				phaseElapsedMs: 0,
				totalElapsedMs: 0,
				runtime,
			};
			return state;
		},
	};
}
