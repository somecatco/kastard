// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
	cancelWorkerCustomNodeSync,
	cancelWorkerModelSync,
	cancelWorkerWorkflowJob,
	connectToServer,
	discardWorkerWorkflowInputs,
	fetchServerLogs,
	fetchWorkerBackend,
	fetchWorkerComfy,
	fetchWorkerCustomNodeSync,
	fetchWorkerModelSync,
	fetchWorkerSystemMetrics,
	fetchWorkerWorkflowJob,
	freeWorkerComfyMemory,
	prepareWorkerBackend,
	probeServerConnection,
	restartWorkerComfy,
	startWorkerComfy,
	startWorkerCustomNodeReinstall,
	startWorkerCustomNodeRemoval,
	startWorkerCustomNodeSync,
	startWorkerModelRedownload,
	startWorkerModelSync,
	startWorkerWorkflowJob,
	verifyWorkerSynchronization,
} from "./client";
import type { WorkerTunnel } from "./tunnel";

const workerRuntime = {
	cudaVersion: "12.8",
	pythonVersion: "3.12.13",
	torchVersion: "2.11.0+cu128",
	torchvisionVersion: "0.26.0+cu128",
	torchaudioVersion: "2.11.0+cu128",
	uvVersion: "0.12.4",
};
const sessionCapability = "test-session-capability";

function tunnelStub(workerAddress: string): WorkerTunnel {
	return {
		endpointUrl: "http://127.0.0.1:49152",
		workerAddress,
		sessionCapability,
		close: vi.fn(async () => undefined),
		onClose: vi.fn(() => () => undefined),
	};
}

describe("server connection client", () => {
	test("starts the Worker connection through an encrypted local tunnel", async () => {
		const requestFetch = vi.fn(async () =>
			Response.json({
				status: "connected",
				logCursor: "server-one:0",
				worker: {
					buildNumber: "15",
					channel: "preview",
					productVersion: null,
					sourceRevision: "a".repeat(40),
				},
			}),
		);
		const tunnel = tunnelStub("203.0.113.10:22001");
		const openTunnel = vi.fn(async () => tunnel);

		const result = await connectToServer(
			"203.0.113.10:22001",
			"ABCD-EFGH-JKLM-NPQR",
			undefined,
			requestFetch as unknown as typeof fetch,
			openTunnel,
		);

		expect(result).toEqual({
			ok: true,
			logCursor: "server-one:0",
			tunnel,
			worker: {
				buildNumber: "15",
				channel: "preview",
				productVersion: null,
				sourceRevision: "a".repeat(40),
			},
		});
		expect(openTunnel).toHaveBeenCalledWith(
			"203.0.113.10:22001",
			"ABCD-EFGH-JKLM-NPQR",
			undefined,
		);
		expect(requestFetch).toHaveBeenCalledWith(
			"http://127.0.0.1:49152/connection",
			expect.objectContaining({
				method: "POST",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${sessionCapability}`,
				},
			}),
		);
	});

	test("loads structured server logs without exposing the cursor to callers", async () => {
		const requestFetch = vi.fn(async () =>
			Response.json({
				logs: [
					{
						id: "server-one:1",
						timestamp: "2026-08-15T12:00:00.000Z",
						level: "info",
						message: "Editor connected.",
					},
				],
				cursor: "server-one:1",
				truncated: false,
			}),
		);

		const result = await fetchServerLogs(
			{ serverUrl: "https://kastard.example.com", sessionCapability },
			"server-one:0",
			requestFetch as unknown as typeof fetch,
		);

		expect(result).toEqual({
			ok: true,
			logs: [
				{
					id: "server-one:1",
					timestamp: "2026-08-15T12:00:00.000Z",
					level: "info",
					message: "Editor connected.",
				},
			],
			cursor: "server-one:1",
			truncated: false,
		});
		expect(requestFetch).toHaveBeenCalledWith(
			"https://kastard.example.com/logs?after=server-one%3A0",
			expect.objectContaining({
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${sessionCapability}`,
				},
			}),
		);
	});

	test("does not expose an invalid server log response body", async () => {
		const result = await fetchServerLogs(
			{ serverUrl: "https://kastard.example.com", sessionCapability },
			"server-one:0",
			vi.fn(
				async () => new Response("provider-token=secret", { status: 500 }),
			) as unknown as typeof fetch,
		);

		expect(result).toEqual({
			ok: false,
			error: "Could not load Worker logs. The Worker returned HTTP 500.",
		});
	});

	test("closes the tunnel when the Worker API rejects the connection", async () => {
		const tunnel = tunnelStub("203.0.113.10:22001");
		const result = await connectToServer(
			"203.0.113.10:22001",
			"ABCD-EFGH-JKLM-NPQR",
			undefined,
			vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
			async () => tunnel,
		);

		expect(result).toEqual({ ok: false, error: "The Worker returned HTTP 503." });
		expect(tunnel.close).toHaveBeenCalledOnce();
	});

	test("reports an offline active connection", async () => {
		const result = await probeServerConnection(
			{ serverUrl: "https://kastard.example.com", sessionCapability },
			vi.fn(async () => {
				throw new Error("offline");
			}) as unknown as typeof fetch,
		);

		expect(result).toEqual({
			status: "offline",
			error: "Could not reach the Worker. Check its address and connection.",
		});
	});

	test("reads Worker identity while probing an active connection", async () => {
		expect(
			await probeServerConnection(
				{ serverUrl: "https://kastard.example.com", sessionCapability },
				vi.fn(async () =>
					Response.json({
						status: "connected",
						worker: {
							buildNumber: "15",
							channel: "production",
							productVersion: "0.1.0",
							sourceRevision: "a".repeat(40),
						},
					}),
				) as unknown as typeof fetch,
			),
		).toEqual({
			status: "connected",
			worker: {
				buildNumber: "15",
				channel: "production",
				productVersion: "0.1.0",
				sourceRevision: "a".repeat(40),
			},
		});
	});

	test("reads and prepares the Worker ComfyUI backend", async () => {
		const requestFetch = vi.fn(async () =>
			Response.json({ status: "not-installed", runtime: workerRuntime }),
		);
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};

		expect(
			await fetchWorkerBackend(credential, requestFetch as unknown as typeof fetch),
		).toEqual({
			ok: true,
			state: { status: "not-installed", runtime: workerRuntime },
		});
		const target = {
			version: "0.33.1",
			archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.33.1.zip",
			sha256: "a".repeat(64),
		};
		await prepareWorkerBackend(
			credential,
			target,
			requestFetch as unknown as typeof fetch,
		);
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/comfyui/prepare",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(target),
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
	});

	test("rejects backend failures without retry metadata", async () => {
		const requestFetch = vi.fn(async () =>
			Response.json({
				status: "failed",
				targetVersion: "0.33.1",
				error: "The fixed Worker runtime is incompatible.",
				runtime: workerRuntime,
			}),
		);

		expect(
			await fetchWorkerBackend(
				{ serverUrl: "https://kastard.example.com", sessionCapability },
				requestFetch as unknown as typeof fetch,
			),
		).toEqual({
			ok: false,
			error: "The Worker returned an invalid ComfyUI backend status.",
			retryable: false,
		});
	});

	test("rejects backend preparation without elapsed times", async () => {
		const requestFetch = vi.fn(async () =>
			Response.json({
				status: "preparing",
				targetVersion: "0.33.1",
				phase: "download",
				progress: 42,
				runtime: workerRuntime,
			}),
		);

		expect(
			await fetchWorkerBackend(
				{ serverUrl: "https://kastard.example.com", sessionCapability },
				requestFetch as unknown as typeof fetch,
			),
		).toEqual({
			ok: false,
			error: "The Worker returned an invalid ComfyUI backend status.",
			retryable: false,
		});
	});

	test("reads, starts, and restarts Worker ComfyUI execution", async () => {
		const requestFetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ status: "stopped" }))
			.mockResolvedValueOnce(Response.json({ status: "starting" }, { status: 202 }))
			.mockResolvedValueOnce(Response.json({ status: "starting" }, { status: 202 }));
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};

		expect(
			await fetchWorkerComfy(credential, requestFetch as unknown as typeof fetch),
		).toEqual({ ok: true, state: { status: "stopped" } });
		expect(
			await startWorkerComfy(credential, requestFetch as unknown as typeof fetch),
		).toEqual({ ok: true, state: { status: "starting" } });
		expect(
			await restartWorkerComfy(credential, requestFetch as unknown as typeof fetch),
		).toEqual({ ok: true, state: { status: "starting" } });
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/comfyui/runtime/restart",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
	});

	test("requests authenticated Worker ComfyUI memory cleanup", async () => {
		const requestFetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({}))
			.mockResolvedValueOnce(
				Response.json(
					{ error: "Worker ComfyUI is not ready.", retryable: true },
					{ status: 503 },
				),
			)
			.mockRejectedValueOnce(new Error("connection lost"));
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};

		expect(
			await freeWorkerComfyMemory(
				credential,
				{ unload_models: true, free_memory: true },
				requestFetch as unknown as typeof fetch,
			),
		).toEqual({ ok: true, state: true });
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/comfyui/runtime/free",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ unload_models: true, free_memory: true }),
				headers: expect.objectContaining({
					Accept: "application/json",
					Authorization: `Bearer ${sessionCapability}`,
					"Content-Type": "application/json",
				}),
			}),
		);
		expect(
			await freeWorkerComfyMemory(
				credential,
				{ unload_models: true },
				requestFetch as unknown as typeof fetch,
			),
		).toEqual({
			ok: false,
			error: "Worker ComfyUI is not ready.",
			retryable: true,
		});
		expect(
			await freeWorkerComfyMemory(
				credential,
				{ unload_models: true },
				requestFetch as unknown as typeof fetch,
			),
		).toEqual({
			ok: false,
			error: "Could not reach the Worker for ComfyUI memory cleanup.",
			retryable: true,
		});
	});

	test("submits the workflow job snapshot to the Worker", async () => {
		const jobId = "11111111-1111-4111-8111-111111111111";
		const prompt = { "1": { class_type: "TestNode", inputs: {} } };
		const snapshot = { prompt, inputs: [] };
		const extraData = { extra_pnginfo: { workflow: { id: "workflow" } } };
		const requestFetch = vi.fn(async () =>
			Response.json({ id: jobId, status: "running" }, { status: 202 }),
		);
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};

		expect(
			await startWorkerWorkflowJob(
				credential,
				jobId,
				snapshot,
				extraData,
				requestFetch,
			),
		).toEqual({ outcome: "accepted", state: { id: jobId, status: "running" } });
		expect(requestFetch).toHaveBeenCalledWith(
			`https://kastard.example.com/workflow-jobs/${jobId}`,
			expect.objectContaining({
				method: "PUT",
				body: JSON.stringify({ prompt, inputs: [], extra_data: extraData }),
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
		requestFetch.mockResolvedValueOnce(
			Response.json(
				{ accepted: false, error: "The Worker is busy.", retryable: true },
				{ status: 409 },
			),
		);
		expect(
			await startWorkerWorkflowJob(
				credential,
				jobId,
				snapshot,
				extraData,
				requestFetch,
			),
		).toEqual({
			outcome: "rejected",
			error: "The Worker is busy.",
			retry: "state-change",
		});
		requestFetch.mockResolvedValueOnce(
			Response.json({ error: "Unexpected failure." }, { status: 500 }),
		);
		expect(
			await startWorkerWorkflowJob(
				credential,
				jobId,
				snapshot,
				extraData,
				requestFetch,
			),
		).toEqual({
			outcome: "unknown",
			error: "The Worker returned HTTP 500.",
		});
		requestFetch.mockRejectedValueOnce(new Error("response lost"));
		expect(
			await startWorkerWorkflowJob(
				credential,
				jobId,
				snapshot,
				extraData,
				requestFetch,
			),
		).toEqual({
			outcome: "unknown",
			error: "Could not submit the workflow to the Worker.",
		});

		requestFetch.mockResolvedValueOnce(
			Response.json({ id: jobId, status: "completed" }),
		);
		expect(await fetchWorkerWorkflowJob(credential, jobId, requestFetch)).toEqual({
			ok: true,
			state: { id: jobId, status: "completed" },
		});

		const failure = {
			code: "preflight_failed" as const,
			message: "Worker workflow preflight failed.",
			problems: [
				{
					kind: "model" as const,
					reason: "missing" as const,
					name: "checkpoints/model.safetensors",
					expected: "Configured model artifact",
					actual: null,
					nodeId: "7",
					inputName: "ckpt_name",
				},
			],
		};
		requestFetch.mockResolvedValueOnce(
			Response.json({
				id: jobId,
				status: "failed",
				error: failure.message,
				failure,
			}),
		);
		expect(await fetchWorkerWorkflowJob(credential, jobId, requestFetch)).toEqual({
			ok: true,
			state: { id: jobId, status: "failed", error: failure },
		});

		requestFetch.mockResolvedValueOnce(
			Response.json({ id: jobId, status: "failed", error: "unsupported failure" }),
		);
		expect(await fetchWorkerWorkflowJob(credential, jobId, requestFetch)).toEqual({
			ok: false,
			error: "The Worker returned an invalid workflow status.",
			retryable: false,
		});

		const connectionLost = {
			code: "connection_lost" as const,
			message: "The Worker connection was lost, so the workflow failed.",
		};
		requestFetch.mockResolvedValueOnce(
			Response.json({
				id: jobId,
				status: "failed",
				error: connectionLost.message,
				failure: connectionLost,
			}),
		);
		expect(await fetchWorkerWorkflowJob(credential, jobId, requestFetch)).toEqual({
			ok: true,
			state: { id: jobId, status: "failed", error: connectionLost },
		});
	});

	test("cancels a workflow through its Desktop job ID", async () => {
		const jobId = "11111111-1111-4111-8111-111111111111";
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};
		const requestFetch = vi.fn(async () =>
			Response.json({ id: jobId, status: "canceled" }, { status: 202 }),
		);

		expect(await cancelWorkerWorkflowJob(credential, jobId, requestFetch)).toEqual({
			ok: true,
			state: { id: jobId, status: "canceled" },
		});
		expect(requestFetch).toHaveBeenCalledWith(
			`https://kastard.example.com/workflow-jobs/${jobId}`,
			expect.objectContaining({
				method: "DELETE",
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);

		requestFetch.mockRejectedValueOnce(new Error("response lost"));
		expect(await cancelWorkerWorkflowJob(credential, jobId, requestFetch)).toEqual({
			ok: false,
			error: "Could not cancel the Worker workflow.",
			retryable: true,
		});
	});

	test("reports failed Worker input cleanup", async () => {
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};
		const unavailable = vi.fn(async () => {
			throw new Error("Worker unavailable.");
		});
		await expect(
			discardWorkerWorkflowInputs(
				credential,
				"11111111-1111-4111-8111-111111111111",
				unavailable as unknown as typeof fetch,
			),
		).rejects.toThrow("Worker unavailable.");

		const rejected = vi.fn(async () => new Response(null, { status: 503 }));
		await expect(
			discardWorkerWorkflowInputs(
				credential,
				"11111111-1111-4111-8111-111111111111",
				rejected as unknown as typeof fetch,
			),
		).rejects.toThrow("HTTP 503");
	});

	test("streams snapshotted inputs before submitting their manifest", async () => {
		const directory = await mkdtemp(join(tmpdir(), "kastard-input-upload-"));
		try {
			const jobId = "11111111-1111-4111-8111-111111111111";
			const bytes = Buffer.from("snapshotted bytes");
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const path = join(directory, "snapshot");
			await writeFile(path, bytes);
			const prompt = {
				"1": { class_type: "LoadImage", inputs: { image: "source.png" } },
			};
			const requests: string[] = [];
			let uploadAttempts = 0;
			const requestFetch = vi.fn(
				async (input: string | URL | Request, init?: RequestInit) => {
					const url = new URL(input.toString());
					requests.push(url.pathname);
					if (url.pathname.endsWith(`/inputs/${sha256}`)) {
						uploadAttempts += 1;
						expect(await new Response(init?.body ?? null).text()).toBe(
							bytes.toString(),
						);
						expect(init?.headers).toEqual(
							expect.objectContaining({
								"Content-Length": String(bytes.byteLength),
								"Content-Type": "application/octet-stream",
								"X-Kastard-Input-SHA256": sha256,
							}),
						);
						return uploadAttempts === 1
							? Response.json({ error: "Try again." }, { status: 429 })
							: new Response(null, { status: 204 });
					}
					const submitted = JSON.parse(String(init?.body));
					expect(submitted).toEqual({
						prompt,
						inputs: [
							{
								id: sha256,
								name: "source.png",
								size: bytes.byteLength,
								sha256,
								references: [
									{
										nodeId: "1",
										inputName: "image",
										value: "source.png",
									},
								],
							},
						],
						extra_data: {},
					});
					return Response.json({ id: jobId, status: "running" }, { status: 202 });
				},
			);
			const credential = {
				serverUrl: "https://kastard.example.com",
				sessionCapability,
			};

			expect(
				await startWorkerWorkflowJob(
					credential,
					jobId,
					{
						prompt,
						inputs: [
							{
								id: sha256,
								name: "source.png",
								path,
								size: bytes.byteLength,
								sha256,
								references: [
									{
										nodeId: "1",
										inputName: "image",
										value: "source.png",
									},
								],
							},
						],
					},
					{},
					requestFetch as unknown as typeof fetch,
				),
			).toEqual({
				outcome: "accepted",
				state: { id: jobId, status: "running" },
			});
			expect(uploadAttempts).toBe(2);
			expect(requests).toEqual([
				`/workflow-jobs/${jobId}/inputs/${sha256}`,
				`/workflow-jobs/${jobId}/inputs/${sha256}`,
				`/workflow-jobs/${jobId}`,
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("reads multi-GPU system status", async () => {
		const metrics = {
			sampledAt: "2026-08-17T07:00:00.000Z",
			cpu: { usagePercent: 12 },
			ram: { usedBytes: 4, totalBytes: 8, usagePercent: 50 },
			disk: { path: "/workspace", usedBytes: 3, totalBytes: 10, usagePercent: 30 },
			gpus: [
				{
					index: 0,
					uuid: "GPU-a",
					name: "NVIDIA RTX 4090",
					usagePercent: 72,
					vramUsedBytes: 12,
					vramTotalBytes: 24,
					vramUsagePercent: 50,
					temperatureC: 68,
				},
			],
		};
		const requestFetch = vi.fn(async () => Response.json(metrics));
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};

		expect(
			await fetchWorkerSystemMetrics(
				credential,
				requestFetch as unknown as typeof fetch,
			),
		).toEqual({ ok: true, state: metrics });
		expect(requestFetch).toHaveBeenCalledWith(
			"https://kastard.example.com/system/status",
			expect.objectContaining({
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
	});

	test("reads and starts custom node synchronization", async () => {
		const target = {
			managerVersion: "4.2.2",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		};
		const operation = {
			contractVersion: 2,
			target,
			operationId: "custom-node-operation",
		};
		const requestFetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					contractVersion: 2,
					target: null,
					operationId: null,
					status: "idle",
					nodes: [],
				}),
			)
			.mockResolvedValueOnce(
				Response.json(
					{
						...operation,
						status: "syncing",
						phase: "install",
						current: 0,
						total: 1,
						currentNode: null,
					},
					{ status: 202 },
				),
			)
			.mockResolvedValueOnce(
				Response.json(
					{
						...operation,
						operationKind: "reinstall",
						status: "syncing",
						phase: "install",
						current: 0,
						total: 1,
						currentNode: null,
					},
					{ status: 202 },
				),
			)
			.mockResolvedValueOnce(
				Response.json(
					{
						...operation,
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
					},
					{ status: 202 },
				),
			)
			.mockResolvedValueOnce(
				Response.json({ ...operation, status: "canceling" }, { status: 202 }),
			);
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};

		expect(
			await fetchWorkerCustomNodeSync(
				credential,
				requestFetch as unknown as typeof fetch,
			),
		).toMatchObject({
			ok: true,
			state: { status: "idle", contractVersion: 2, target: null },
		});
		const node = { id: "comfyui-kjnodes", version: "1.5.0" };
		const nodes = [node];
		expect(
			await startWorkerCustomNodeSync(
				credential,
				"4.2.2",
				nodes,
				requestFetch as unknown as typeof fetch,
			),
		).toMatchObject({ ok: true, state: { status: "syncing" } });
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/sync",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ managerVersion: "4.2.2", nodes }),
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
		expect(
			await startWorkerCustomNodeReinstall(
				credential,
				"4.2.2",
				node,
				requestFetch as unknown as typeof fetch,
			),
		).toMatchObject({
			ok: true,
			state: { status: "syncing", operationKind: "reinstall" },
		});
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/sync/reinstall",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ managerVersion: "4.2.2", nodes: [node] }),
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
		const removalNode = { name: "manual.py", managerId: null, version: null };
		expect(
			await startWorkerCustomNodeRemoval(
				credential,
				target,
				removalNode,
				requestFetch as unknown as typeof fetch,
			),
		).toMatchObject({
			ok: true,
			state: { status: "syncing", operationKind: "remove", removalNode },
		});
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/sync/remove",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ ...target, node: removalNode }),
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
		expect(
			await cancelWorkerCustomNodeSync(
				credential,
				"custom-node-operation",
				requestFetch as unknown as typeof fetch,
			),
		).toMatchObject({
			ok: true,
			state: { status: "canceling", operationId: "custom-node-operation" },
		});
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/sync/custom-node-operation",
			expect.objectContaining({
				method: "DELETE",
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
	});

	test("reads and starts model synchronization", async () => {
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};
		const request = {
			models: [
				{
					name: "Flux",
					path: "checkpoints/flux.safetensors",
					artifact: {
						provider: "huggingface" as const,
						modelId: "owner/repository",
						versionId: "a".repeat(40),
						versionLabel: "aaaaaaa",
						fileId: "flux.safetensors",
						fileName: "flux.safetensors",
						sizeBytes: 123,
					},
				},
			],
			credentials: { huggingface: "provider-token" },
		};
		const operation = {
			contractVersion: 2,
			capabilities: { forceRedownload: true },
			target: { models: request.models },
			operationId: "model-operation",
			operationKind: "sync" as const,
		};
		const requestFetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					contractVersion: 2,
					target: null,
					operationId: null,
					status: "idle",
					models: null,
				}),
			)
			.mockResolvedValueOnce(
				Response.json(
					{ ...operation, status: "checking", total: 1, totalBytes: 123 },
					{ status: 202 },
				),
			)
			.mockResolvedValueOnce(
				Response.json(
					{
						...operation,
						operationKind: "redownload",
						status: "checking",
						total: 1,
						totalBytes: 123,
					},
					{ status: 202 },
				),
			)
			.mockResolvedValueOnce(
				Response.json({ ...operation, status: "canceling" }, { status: 202 }),
			);

		expect(
			await fetchWorkerModelSync(credential, requestFetch as unknown as typeof fetch),
		).toEqual({
			ok: true,
			state: {
				status: "idle",
				models: null,
				contractVersion: 2,
				target: null,
				operationId: null,
			},
		});
		expect(
			await startWorkerModelSync(
				credential,
				request,
				requestFetch as unknown as typeof fetch,
			),
		).toMatchObject({ ok: true, state: { status: "checking" } });
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/models/sync",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(request),
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
		expect(
			await startWorkerModelRedownload(
				credential,
				request,
				requestFetch as unknown as typeof fetch,
			),
		).toMatchObject({
			ok: true,
			state: { status: "checking", operationKind: "redownload" },
		});
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/models/redownload",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(request),
			}),
		);
		expect(
			await cancelWorkerModelSync(
				credential,
				"model-operation",
				requestFetch as unknown as typeof fetch,
			),
		).toMatchObject({
			ok: true,
			state: { status: "canceling", operationId: "model-operation" },
		});
		expect(requestFetch).toHaveBeenLastCalledWith(
			"https://kastard.example.com/models/sync/model-operation",
			expect.objectContaining({
				method: "DELETE",
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
	});

	test("explains unsupported model synchronization contracts", async () => {
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};
		const requestFetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ status: "idle", models: null }))
			.mockResolvedValueOnce(
				Response.json({ contractVersion: 2, status: "idle", models: null }),
			)
			.mockResolvedValueOnce(Response.json({ status: "idle", models: null }))
			.mockResolvedValueOnce(
				Response.json({ contractVersion: 2, status: "idle", models: null }),
			);

		await expect(
			fetchWorkerModelSync(credential, requestFetch as unknown as typeof fetch),
		).resolves.toEqual({
			ok: false,
			error:
				"This Worker uses an unsupported model sync contract. Start a Worker version compatible with this version of Kastard, reconnect, and try again.",
			retryable: false,
		});
		await expect(
			fetchWorkerModelSync(credential, requestFetch as unknown as typeof fetch),
		).resolves.toEqual({
			ok: false,
			error: "The Worker returned an invalid model sync status.",
			retryable: false,
		});
		await expect(
			startWorkerModelRedownload(
				credential,
				{ models: [], credentials: {} },
				requestFetch as unknown as typeof fetch,
			),
		).resolves.toEqual({
			ok: false,
			error:
				"This Worker uses an unsupported model sync contract. Start a Worker version compatible with this version of Kastard, reconnect, and try again.",
			retryable: false,
		});
		await expect(
			startWorkerModelRedownload(
				credential,
				{ models: [], credentials: {} },
				requestFetch as unknown as typeof fetch,
			),
		).resolves.toEqual({
			ok: false,
			error: "The Worker returned an invalid model redownload status.",
			retryable: false,
		});
	});

	test("verifies all Worker synchronization targets without provider credentials", async () => {
		const verification = {
			status: "synced" as const,
			backend: {
				status: "synced" as const,
				expectedVersion: "0.33.1",
				actualVersion: "0.33.1",
			},
			models: { status: "synced" as const, total: 0 },
			customNodes: { status: "synced" as const, total: 0 },
		};
		const requestFetch = vi.fn().mockResolvedValue(Response.json(verification));
		const credential = {
			serverUrl: "https://kastard.example.com",
			sessionCapability,
		};
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
			await verifyWorkerSynchronization(
				credential,
				request,
				requestFetch as unknown as typeof fetch,
			),
		).toEqual({ ok: true, state: verification });
		expect(requestFetch).toHaveBeenCalledWith(
			"https://kastard.example.com/sync/verify",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(request),
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
		expect(JSON.stringify(request)).not.toContain("credential");
		expect(JSON.stringify(request)).not.toContain("token");
	});
});
