import { describe, expect, test } from "bun:test";
import {
	backendTargetIssue,
	isWorkerRuntime,
	parseBackendServerState,
	parseBackendTarget,
} from "./backend";
import {
	isUnsupportedModelSyncContract,
	type ModelSyncServerState,
	parseModelSyncRequest,
	parseModelSyncState,
} from "./model-sync";
import { parseServerLogSnapshot } from "./server-log";
import {
	parseSyncVerification,
	parseSyncVerificationRequest,
} from "./sync-verification";
import { parseWorkerSystemStatus } from "./system-status";
import {
	parseWorkerComfyMemoryCleanupRequest,
	parseWorkerComfyServerState,
	parseWorkerConnectionStartResponse,
	parseWorkerErrorResponse,
} from "./worker-http";
import {
	parseWorkflowJobRequest,
	parseWorkflowJobState,
	parseWorkflowResultManifest,
} from "./workflow";

const runtime = {
	cudaVersion: "12.8",
	pythonVersion: "3.12.13",
	torchVersion: "2.11.0+cu128",
	torchvisionVersion: "0.26.0+cu128",
	torchaudioVersion: "2.11.0+cu128",
	uvVersion: "0.12.4",
};

const backendTarget = {
	version: "0.33.1",
	archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.33.1.zip",
	sha256: "a".repeat(64),
};

const model = {
	name: "Model",
	path: "checkpoints/model.safetensors",
	artifact: {
		provider: "civitai" as const,
		modelId: "1",
		versionId: "2",
		versionLabel: "v1",
		fileId: "3",
		fileName: "model.safetensors",
		sizeBytes: 10,
	},
};

describe("Worker HTTP contracts", () => {
	test("validates current backend targets and states", () => {
		expect(parseBackendTarget(backendTarget)).toEqual(backendTarget);
		expect(
			backendTargetIssue({ ...backendTarget, archiveUrl: "https://example.com" }),
		).toBe("archive-url");
		expect(
			parseBackendServerState({
				status: "failed",
				targetVersion: "0.33.1",
				error: "Incompatible runtime.",
				retryable: false,
				runtime,
			}),
		).toEqual({
			status: "failed",
			targetVersion: "0.33.1",
			error: "Incompatible runtime.",
			retryable: false,
			runtime,
		});
		expect(
			parseBackendServerState({
				status: "failed",
				targetVersion: "0.33.1",
				error: "Unsupported Worker failure.",
				runtime,
			}),
		).toBeNull();
		expect(
			parseBackendServerState({
				status: "preparing",
				targetVersion: "0.33.1",
				phase: "download",
				progress: 50,
				phaseElapsedMs: 100,
				totalElapsedMs: 200,
				runtime,
			}),
		).toMatchObject({ phase: "download", progress: 50 });
		expect(
			parseBackendServerState({
				status: "preparing",
				targetVersion: "0.33.1",
				phase: "download",
				progress: 50,
				runtime,
			}),
		).toBeNull();
	});

	test("normalizes supported Worker ComfyUI memory cleanup requests", () => {
		expect(parseWorkerComfyMemoryCleanupRequest({ unload_models: true })).toEqual({
			unload_models: true,
		});
		expect(
			parseWorkerComfyMemoryCleanupRequest({
				unload_models: true,
				free_memory: true,
			}),
		).toEqual({ unload_models: true, free_memory: true });
		expect(
			parseWorkerComfyMemoryCleanupRequest({
				unload_models: true,
				free_memory: false,
			}),
		).toEqual({ unload_models: true });
		expect(
			parseWorkerComfyMemoryCleanupRequest({
				unload_models: false,
				free_memory: true,
			}),
		).toBeNull();
	});

	test("accepts current CUDA and CPU Worker runtimes", () => {
		expect(isWorkerRuntime(runtime)).toBe(true);
		expect(
			isWorkerRuntime({ ...runtime, computeBackend: "cpu", cudaVersion: null }),
		).toBe(true);
		expect(
			isWorkerRuntime({ ...runtime, computeBackend: "cpu", cudaVersion: "12.8" }),
		).toBe(false);
		expect(
			isWorkerRuntime({ ...runtime, computeBackend: "cuda", cudaVersion: null }),
		).toBe(false);
	});

	test("shares connection, runtime, log, and system status response validation", () => {
		expect(
			parseWorkerConnectionStartResponse({
				status: "connected",
				logCursor: "worker:0",
				worker: {
					buildNumber: "15",
					channel: "preview",
					productVersion: null,
					sourceRevision: "a".repeat(40),
				},
			}),
		).toEqual({
			status: "connected",
			logCursor: "worker:0",
			worker: {
				buildNumber: "15",
				channel: "preview",
				productVersion: null,
				sourceRevision: "a".repeat(40),
			},
		});
		expect(
			parseWorkerConnectionStartResponse({
				status: "connected",
				logCursor: "worker:0",
				worker: {
					buildNumber: "0",
					channel: "preview",
					productVersion: null,
					sourceRevision: "a".repeat(40),
				},
			}),
		).toEqual({ status: "connected", logCursor: "worker:0" });
		expect(
			parseWorkerErrorResponse({ error: "Unavailable.", retryable: true }),
		).toEqual({
			error: "Unavailable.",
			retryable: true,
		});
		expect(parseWorkerComfyServerState({ status: "ready" })).toEqual({
			status: "ready",
		});
		expect(
			parseWorkerComfyServerState({
				status: "ready",
				warnings: ["ComfyUI could not initialize comfyui-impact-pack."],
			}),
		).toEqual({
			status: "ready",
			warnings: ["ComfyUI could not initialize comfyui-impact-pack."],
		});
		expect(parseWorkerComfyServerState({ status: "ready", warnings: [""] })).toBeNull();
		expect(
			parseServerLogSnapshot({
				logs: [
					{
						id: "worker:1",
						timestamp: "2026-08-25T00:00:00.000Z",
						level: "info",
						message: "Connected.",
					},
				],
				cursor: "worker:1",
				truncated: false,
			}),
		).not.toBeNull();
		expect(
			parseWorkerSystemStatus({
				sampledAt: "2026-08-25T00:00:00.000Z",
				cpu: { usagePercent: 20 },
				ram: { usedBytes: 1, totalBytes: 2, usagePercent: 50 },
				disk: { path: "/data", usedBytes: 2, totalBytes: 4, usagePercent: 50 },
				gpus: [],
			}),
		).not.toBeNull();
	});

	test("validates model synchronization requests and states with one rule set", () => {
		expect(parseModelSyncRequest({ models: [model], credentials: {} })).toEqual({
			ok: true,
			value: { models: [model], credentials: {} },
		});
		expect(
			parseModelSyncRequest({ models: [model], credentials: { civitai: " token " } }),
		).toEqual({ ok: false, issue: "credential" });
		expect(parseModelSyncRequest({ models: [model, model], credentials: {} })).toEqual({
			ok: false,
			issue: "duplicate-path",
		});
		expect(
			parseModelSyncState({
				status: "failed",
				models: [model],
				total: 2,
				error: "One model failed.",
			}),
		).toBeNull();
		expect(isUnsupportedModelSyncContract({ status: "idle", models: null })).toBe(true);
		expect(isUnsupportedModelSyncContract({ status: "idle" })).toBe(false);
		expect(
			parseModelSyncState({
				contractVersion: 1,
				target: null,
				operationId: null,
				status: "failed",
				models: [model],
				error: "Older Worker failure.",
			}),
		).toBeNull();
		expect(
			isUnsupportedModelSyncContract({
				contractVersion: 1,
				status: "failed",
			}),
		).toBe(true);
		expect(isUnsupportedModelSyncContract({ contractVersion: 3, status: "idle" })).toBe(
			true,
		);
		const current: ModelSyncServerState = {
			contractVersion: 2,
			capabilities: { forceRedownload: true },
			target: { models: [model] },
			operationId: "model-operation",
			operationKind: "redownload",
			status: "syncing",
			completed: 0,
			total: 1,
			completedBytes: 4,
			totalBytes: 10,
			present: 0,
			active: [model.path],
			modelSnapshot: {
				models: [
					{
						path: model.path,
						status: "downloading",
						downloadedBytes: 4,
					},
				],
			},
		};
		expect(parseModelSyncState(current)).toEqual(current);
		expect(isUnsupportedModelSyncContract(current)).toBe(false);
		expect(
			isUnsupportedModelSyncContract({ contractVersion: 2, status: "unknown" }),
		).toBe(false);
		expect(
			parseModelSyncState({
				...current,
				status: "failed",
				models: [model],
				total: 0,
				error: "Invalid model count.",
			}),
		).toBeNull();
		expect(parseModelSyncState({ ...current, completed: 2 })).toBeNull();
		expect(
			parseModelSyncState({
				...current,
				target: { models: [model], credentials: { civitai: "secret" } },
			}),
		).toBeNull();
		expect(
			parseModelSyncState({
				...current,
				modelSnapshot: {
					models: [
						{
							path: model.path,
							status: "ready",
							downloadedBytes: 9,
						},
					],
				},
			}),
		).toBeNull();
	});

	test("validates synchronization verification requests and responses", () => {
		const request = {
			backendVersion: "0.33.1",
			models: [model],
			customNodes: {
				managerVersion: "4.2.2",
				nodes: [],
				unsupportedNodes: ["local-node", "local-node"],
			},
		};
		expect(parseSyncVerificationRequest(request)?.customNodes.unsupportedNodes).toEqual(
			["local-node"],
		);
		expect(
			parseSyncVerification({
				status: "synced",
				backend: {
					status: "synced",
					expectedVersion: "0.33.1",
					actualVersion: "0.33.1",
				},
				models: { status: "synced", total: 1 },
				customNodes: { status: "synced", total: 0 },
			}),
		).not.toBeNull();
	});

	test("normalizes current workflow job responses", () => {
		const jobId = "11111111-1111-4111-8111-111111111111";
		expect(
			parseWorkflowJobRequest(jobId, {
				prompt: "ComfyUI validates this value",
				extra_data: ["forwarded without interpretation"],
			}),
		).toEqual({
			ok: true,
			value: {
				prompt: "ComfyUI validates this value",
				inputs: [],
				extra_data: ["forwarded without interpretation"],
			},
		});
		expect(
			parseWorkflowJobRequest(jobId, {
				prompt: { "1": { class_type: "TestNode", inputs: {} } },
				inputs: null,
			}),
		).toEqual({ ok: false, issue: "inputs" });
		const failure = {
			code: "execution_failed" as const,
			message: "Worker ComfyUI failed.",
		};
		expect(
			parseWorkflowJobState({
				id: jobId,
				status: "failed",
				error: failure.message,
				failure,
			}),
		).toEqual({ id: jobId, status: "failed", error: failure });
		expect(
			parseWorkflowJobState({
				id: jobId,
				status: "failed",
				error: "Unsupported failure.",
			}),
		).toBeNull();
		expect(parseWorkflowResultManifest({ id: jobId, outputs: {}, files: [] })).toEqual({
			id: jobId,
			outputs: {},
			files: [],
		});
		expect(
			parseWorkflowResultManifest({
				id: jobId,
				outputs: {},
				files: [
					{
						id: "a".repeat(64),
						filename: "result\\preview.png",
						subfolder: "",
						type: "output",
						size: 1,
						sha256: "b".repeat(64),
						contentType: "image/png",
					},
				],
			}),
		).not.toBeNull();
	});
});
