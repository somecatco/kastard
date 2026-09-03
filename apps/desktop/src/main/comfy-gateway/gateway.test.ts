// @vitest-environment node

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { ComfyGateway } from "./gateway";
import { ComfyGatewayRequestError, type WorkerWorkflowQueue } from "./worker-port";

const servers: Server[] = [];
const gateways: ComfyGateway[] = [];

afterEach(async () => {
	await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

test("rejects prompt submission while the Worker is not ready", async () => {
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => null,
		getQueue: () => ({ running: [], pending: [] }),
		updateQueue: vi.fn(),
		submitPrompt: () =>
			Promise.reject(new ComfyGatewayRequestError("Worker is not ready.", 503)),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();
	const prompt = { "1": { class_type: "TestNode", inputs: {} } };

	const submission = await fetch(new URL("api/prompt", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt, client_id: "comfy-client" }),
	});
	expect(submission.status).toBe(503);
	expect(await submission.json()).toEqual({
		error: {
			type: "worker_execution_error",
			message: "Worker is not ready.",
			details: "Worker is not ready.",
			extra_info: {},
		},
		node_errors: {},
	});
	expect(await (await fetch(new URL("api/queue", gatewayUrl))).json()).toEqual({
		queue_running: [],
		queue_pending: [],
	});
});

test("intercepts ComfyUI interrupt requests for the current Worker workflow", async () => {
	let upstreamInterrupts = 0;
	const upstream = await listen(
		createServer((request, response) => {
			if (request.url?.endsWith("/interrupt")) upstreamInterrupts += 1;
			response.end();
		}),
	);
	const cancelCurrent = vi.fn(() => "11111111-1111-4111-8111-111111111111");
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		cancelCurrent,
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	for (const path of ["interrupt", "api/interrupt"]) {
		const response = await fetch(new URL(path, gatewayUrl), { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
	}
	expect(cancelCurrent).toHaveBeenCalledTimes(2);
	expect(upstreamInterrupts).toBe(0);
});

test("proxies ComfyUI interrupt requests when no Worker workflow is current", async () => {
	const upstreamPaths: string[] = [];
	const upstream = await listen(
		createServer((request, response) => {
			upstreamPaths.push(request.url ?? "");
			response.writeHead(202, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ interrupted: "local" }));
		}),
	);
	const cancelCurrent = vi.fn(() => null);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		cancelCurrent,
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	for (const path of ["interrupt", "api/interrupt"]) {
		const response = await fetch(new URL(path, gatewayUrl), { method: "POST" });
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ interrupted: "local" });
	}
	expect(cancelCurrent).toHaveBeenCalledTimes(2);
	expect(upstreamPaths).toEqual(["/interrupt", "/api/interrupt"]);
});

test("routes ComfyUI memory cleanup actions to the connected Worker", async () => {
	let localCleanupRequests = 0;
	const upstream = await listen(
		createServer((_request, response) => {
			localCleanupRequests += 1;
			response.end();
		}),
	);
	const freeWorkerMemory = vi.fn(async () => undefined);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		isWorkerConnected: () => true,
		freeWorkerMemory,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const requests = [
		{ path: "free", body: { unload_models: true } },
		{
			path: "api/free",
			body: { unload_models: true, free_memory: true },
		},
	] as const;
	for (const request of requests) {
		const response = await fetch(new URL(request.path, gatewayUrl), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request.body),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
	}
	expect(freeWorkerMemory).toHaveBeenNthCalledWith(1, { unload_models: true });
	expect(freeWorkerMemory).toHaveBeenNthCalledWith(2, {
		unload_models: true,
		free_memory: true,
	});
	expect(localCleanupRequests).toBe(0);

	const invalid = await fetch(new URL("free", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ unload_models: false, free_memory: true }),
	});
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toEqual({
		error: "Invalid ComfyUI memory cleanup request.",
	});
	expect(freeWorkerMemory).toHaveBeenCalledTimes(2);
	expect(localCleanupRequests).toBe(0);
});

test("does not fall back to local cleanup after a Worker cleanup failure", async () => {
	let localCleanupRequests = 0;
	const upstream = await listen(
		createServer((_request, response) => {
			localCleanupRequests += 1;
			response.end();
		}),
	);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		isWorkerConnected: () => true,
		freeWorkerMemory: async () => {
			throw new Error("Worker ComfyUI is not ready.");
		},
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const response = await fetch(new URL("free", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ unload_models: true }),
	});
	expect(response.status).toBe(502);
	expect(await response.json()).toEqual({ error: "Worker ComfyUI is not ready." });
	expect(localCleanupRequests).toBe(0);
});

test("does not fall back to local cleanup when the Worker handler is unavailable", async () => {
	let localCleanupRequests = 0;
	const upstream = await listen(
		createServer((_request, response) => {
			localCleanupRequests += 1;
			response.end();
		}),
	);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		isWorkerConnected: () => true,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const response = await fetch(new URL("free", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ unload_models: true }),
	});
	expect(response.status).toBe(502);
	expect(await response.json()).toEqual({
		error: "Worker ComfyUI memory cleanup is unavailable.",
	});
	expect(localCleanupRequests).toBe(0);
});

test("preserves local ComfyUI memory cleanup while no Worker is connected", async () => {
	const localRequests: Array<{ path: string; body: string }> = [];
	const upstream = await listen(
		createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				localRequests.push({
					path: request.url ?? "",
					body: Buffer.concat(chunks).toString("utf8"),
				});
				response.writeHead(202, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ cleaned: "local" }));
			});
		}),
	);
	const freeWorkerMemory = vi.fn(async () => undefined);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		isWorkerConnected: () => false,
		freeWorkerMemory,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();
	const body = JSON.stringify({ unload_models: true, free_memory: true });

	for (const path of ["free", "api/free"]) {
		const response = await fetch(new URL(path, gatewayUrl), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ cleaned: "local" });
	}
	expect(localRequests).toEqual([
		{ path: "/free", body },
		{ path: "/api/free", body },
	]);
	expect(freeWorkerMemory).not.toHaveBeenCalled();
});

test("cancels the current Worker workflow through Job Queue APIs", async () => {
	const jobId = "11111111-1111-4111-8111-111111111111";
	const queue: WorkerWorkflowQueue = {
		running: [
			{
				id: jobId,
				number: 0,
				createdAt: 1_786_979_400_000,
				prompt: { "1": { class_type: "TestNode", inputs: {} } },
				clientId: "comfy-client",
			},
		],
		pending: [],
	};
	const cancelCurrent = vi.fn(() => jobId);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => null,
		getQueue: () => queue,
		updateQueue: vi.fn(),
		cancelCurrent,
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const cancellation = await fetch(new URL(`api/jobs/${jobId}/cancel`, gatewayUrl), {
		method: "POST",
	});
	expect(cancellation.status).toBe(200);
	expect(await cancellation.json()).toEqual({});

	const batchCancellation = await fetch(new URL("api/jobs/cancel", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ job_ids: [jobId] }),
	});
	expect(batchCancellation.status).toBe(200);
	expect(await batchCancellation.json()).toEqual({});
	expect(cancelCurrent).toHaveBeenCalledTimes(2);
});

test("proxies official ComfyUI traffic but intercepts prompt submission", async () => {
	let localPromptRequests = 0;
	let localQueueRequests = 0;
	let localJobsRequests = 0;
	const upstream = await listen(
		createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://local-comfy");
			if (request.url?.endsWith("/prompt")) localPromptRequests += 1;
			if (request.url?.endsWith("/queue")) localQueueRequests += 1;
			if (request.url?.startsWith("/api/jobs")) localJobsRequests += 1;
			if (url.pathname === "/api/jobs" && url.searchParams.has("offset")) {
				response.setHeader("Content-Type", "application/json");
				response.end(
					JSON.stringify({
						jobs: [],
						pagination: { offset: 0, limit: 1_000, total: 0, has_more: false },
					}),
				);
				return;
			}
			response.end(
				request.url === "/hello"
					? "local-comfy"
					: request.url?.startsWith("/api/jobs")
						? "local-jobs"
						: "unexpected",
			);
		}),
	);
	const prompt = { "1": { class_type: "TestNode", inputs: {} } };
	const jobId = "11111111-1111-4111-8111-111111111111";
	const createdAt = 1_786_979_400_000;
	const submitPrompt = vi.fn(async () => ({
		id: jobId,
		number: 3,
	}));
	const updateQueue = vi.fn();
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: () => ({
			running: [],
			pending: [{ id: jobId, number: 3, createdAt, prompt, clientId: "comfy-client" }],
		}),
		updateQueue,
		submitPrompt,
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	expect(await (await fetch(new URL("hello", gatewayUrl))).text()).toBe("local-comfy");
	const response = await fetch(new URL("api/prompt", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: "comfy-client",
			prompt,
			extra_data: { auth_token_comfy_org: "must-not-reach-worker" },
		}),
	});

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		prompt_id: jobId,
		number: 3,
		node_errors: {},
	});
	expect(submitPrompt).toHaveBeenCalledWith(prompt, "comfy-client", {});
	expect(await (await fetch(new URL("api/queue", gatewayUrl))).json()).toEqual({
		queue_running: [],
		queue_pending: [
			[3, jobId, prompt, { client_id: "comfy-client", create_time: createdAt }, []],
		],
	});
	for (const [path, mutation] of [
		["queue", { delete: [jobId] }],
		["api/queue", { clear: true }],
	] as const) {
		const queueMutation = await fetch(new URL(path, gatewayUrl), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(mutation),
		});
		expect(queueMutation.status).toBe(200);
		expect(await queueMutation.json()).toEqual({});
	}
	expect(updateQueue.mock.calls.map(([mutation]) => mutation)).toEqual([
		{ delete: [jobId] },
		{ clear: true },
	]);
	expect(
		await (
			await fetch(
				new URL("api/jobs?status=in_progress,pending&limit=200&offset=0", gatewayUrl),
			)
		).json(),
	).toEqual({
		jobs: [
			{
				id: jobId,
				status: "pending",
				priority: 3,
				create_time: createdAt,
			},
		],
		pagination: { offset: 0, limit: 200, total: 1, has_more: false },
	});
	expect(
		await (
			await fetch(new URL("api/jobs?status=completed&limit=64", gatewayUrl))
		).text(),
	).toBe("local-jobs");
	expect(localPromptRequests).toBe(0);
	expect(localQueueRequests).toBe(0);
	expect(localJobsRequests).toBe(2);
});

test("relays local WebSocket traffic and injects workflow events", async () => {
	const server = createServer();
	const upstreamSockets = new WebSocketServer({ server });
	upstreamSockets.on("connection", (socket) => {
		socket.send(
			JSON.stringify({
				type: "status",
				data: { status: { exec_info: { queue_remaining: 0 } }, sid: "client-one" },
			}),
		);
	});
	const upstream = await listen(server);
	let queue: WorkerWorkflowQueue = {
		running: [],
		pending: [
			{
				id: "workflow-job",
				number: 0,
				createdAt: 1_786_979_400_000,
				prompt: { "1": { class_type: "TestNode", inputs: {} } },
				clientId: "client-one",
			},
		],
	};
	const collectedJob = {
		id: "workflow-job",
		number: 0,
		createdAt: 1_786_979_400_000,
		completedAt: 1_786_979_401_000,
		prompt: { "4": { class_type: "SaveImage", inputs: {} } },
		extraData: {},
		clientId: "client-one",
		status: "completed" as const,
		outputs: {
			"3": { text: ["ready"] },
			"4": {
				images: [
					{
						filename: "result.png",
						subfolder: "kastard/workflow-job/file-id",
						type: "output",
					},
				],
			},
			"5": {
				result: [
					{
						filename: "model.glb",
						subfolder: "kastard/workflow-job/model-id",
						type: "output",
					},
				],
			},
		},
		files: [],
	};
	const recoveredJob = {
		...collectedJob,
		id: "recovered-job",
		outputs: {
			"8": {
				images: [
					{
						filename: "recovered.png",
						subfolder: "kastard/recovered-job/file-id",
						type: "output",
					},
				],
			},
		},
	};
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: () => queue,
		updateQueue: vi.fn(),
		getHistoryJob: (jobId) =>
			[collectedJob, recoveredJob].find((job) => job.id === jobId) ?? null,
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();
	const client = new WebSocket(new URL("ws", gatewayUrl));
	await once(client, "open");
	const initial = await nextJson(client);
	expect(initial).toMatchObject({
		type: "status",
		data: {
			sid: "client-one",
			status: { exec_info: { queue_remaining: 1 } },
		},
	});

	queue = { running: queue.pending, pending: [] };
	gateway.sendQueueStatus(queue);
	expect(await nextJson(client)).toEqual({
		type: "status",
		data: { status: { exec_info: { queue_remaining: 1 } } },
	});
	gateway.sendStarted("workflow-job", "client-one");
	expect(await nextJson(client)).toEqual({
		type: "execution_start",
		data: { prompt_id: "workflow-job" },
	});
	gateway.sendLive({
		id: "workflow-job",
		clientId: "client-one",
		message: {
			type: "progress",
			data: { prompt_id: "workflow-job", node: "4", value: 1, max: 2 },
		},
	});
	expect(await nextJson(client)).toEqual({
		type: "progress",
		data: { prompt_id: "workflow-job", node: "4", value: 1, max: 2 },
	});
	gateway.sendLive({
		id: "workflow-job",
		clientId: "client-one",
		message: {
			type: "executed",
			data: {
				prompt_id: "workflow-job",
				node: "3",
				output: { text: ["ready"] },
			},
		},
	});
	expect(await nextJson(client)).toEqual({
		type: "executed",
		data: {
			prompt_id: "workflow-job",
			node: "3",
			output: { text: ["ready"] },
		},
	});
	gateway.sendLive({
		id: "workflow-job",
		clientId: "client-one",
		message: {
			type: "executed",
			data: {
				prompt_id: "workflow-job",
				node: "5",
				display_node: "5",
				output: { result: ["model.glb"] },
			},
		},
	});
	gateway.sendLive({
		id: "workflow-job",
		clientId: "client-one",
		message: {
			type: "executed",
			data: {
				prompt_id: "workflow-job",
				node: "4",
				display_node: "4",
				output: {
					images: [{ filename: "result.png", subfolder: "images", type: "output" }],
				},
			},
		},
	});
	gateway.sendLive({
		id: "workflow-job",
		clientId: "client-one",
		message: {
			type: "progress",
			data: { prompt_id: "workflow-job", node: "4", value: 2, max: 2 },
		},
	});
	expect(await nextJson(client)).toEqual({
		type: "progress",
		data: { prompt_id: "workflow-job", node: "4", value: 2, max: 2 },
	});
	const preview = nextBinary(client);
	gateway.sendLive({
		id: "workflow-job",
		clientId: "client-one",
		preview: new Uint8Array([4, 0, 0, 0, 1, 2, 3]),
	});
	expect([...(await preview)]).toEqual([4, 0, 0, 0, 1, 2, 3]);
	const completedMessages = nextJson(client, 3);
	gateway.sendTerminal({
		id: "workflow-job",
		clientId: "client-one",
		status: "completed",
	});
	expect(await completedMessages).toEqual([
		{
			type: "executed",
			data: {
				prompt_id: "workflow-job",
				node: "4",
				display_node: "4",
				output: collectedJob.outputs["4"],
			},
		},
		{
			type: "executed",
			data: {
				prompt_id: "workflow-job",
				node: "5",
				display_node: "5",
				output: collectedJob.outputs["5"],
			},
		},
		{
			type: "execution_success",
			data: { prompt_id: "workflow-job" },
		},
	]);
	const recoveredMessages = nextJson(client, 2);
	gateway.sendTerminal({
		id: "recovered-job",
		clientId: "client-one",
		status: "completed",
	});
	expect(await recoveredMessages).toEqual([
		{
			type: "executed",
			data: {
				prompt_id: "recovered-job",
				node: "8",
				display_node: "8",
				output: recoveredJob.outputs["8"],
			},
		},
		{
			type: "execution_success",
			data: { prompt_id: "recovered-job" },
		},
	]);
	gateway.sendLive({
		id: "failed-job",
		clientId: "client-one",
		message: {
			type: "executed",
			data: {
				prompt_id: "failed-job",
				node: "7",
				output: {
					images: [{ filename: "incomplete.png", subfolder: "images", type: "output" }],
				},
			},
		},
	});
	gateway.sendTerminal({
		id: "failed-job",
		clientId: "client-one",
		status: "failed",
		error: {
			code: "preflight_failed",
			message: "Worker workflow preflight failed.",
			problems: [
				{
					kind: "node",
					reason: "invalid",
					name: "CheckpointLoaderSimple.ckpt_name",
					expected: "A value available on the Worker",
					actual: "missing.safetensors",
					nodeId: "7",
					inputName: "ckpt_name",
				},
			],
		},
	});
	expect(await nextJson(client)).toEqual({
		type: "execution_error",
		data: {
			prompt_id: "failed-job",
			node_id: "",
			node_type: "KastardWorkerWorkflow",
			executed: [],
			exception_message:
				"Worker workflow preflight failed.\n[node/invalid] CheckpointLoaderSimple.ckpt_name at 7/ckpt_name (expected: A value available on the Worker, actual: missing.safetensors)",
			exception_type: "KastardWorkerPreflightError",
			traceback: [],
		},
	});
	gateway.sendTerminal({
		id: "connection-lost-job",
		clientId: "client-one",
		status: "failed",
		error: {
			code: "connection_lost",
			message: "The Worker connection was lost, so the workflow failed.",
		},
	});
	expect(await nextJson(client)).toEqual({
		type: "execution_error",
		data: {
			prompt_id: "connection-lost-job",
			node_id: "",
			node_type: "KastardWorkerWorkflow",
			executed: [],
			exception_message: "The Worker connection was lost, so the workflow failed.",
			exception_type: "KastardWorkerConnectionError",
			traceback: [],
		},
	});
	gateway.sendTerminal({
		id: "canceled-job",
		clientId: "client-one",
		status: "canceled",
	});
	expect(await nextJson(client)).toEqual({
		type: "execution_interrupted",
		data: {
			prompt_id: "canceled-job",
			node_id: null,
			node_type: null,
			executed: [],
		},
	});
	queue = { running: [], pending: [] };
	gateway.sendQueueStatus(queue);
	expect(await nextJson(client)).toEqual({
		type: "status",
		data: { status: { exec_info: { queue_remaining: 0 } } },
	});

	client.close();
	upstreamSockets.close();
});

test("rejects deleting the current workflow while clear only targets queued jobs", async () => {
	const upstream = await listen(createServer((_request, response) => response.end()));
	const jobId = "11111111-1111-4111-8111-111111111111";
	const updateQueue = vi.fn((mutation: { clear: true } | { delete: string[] }) => {
		if ("delete" in mutation && mutation.delete.includes(jobId)) {
			throw new ComfyGatewayRequestError(
				"The current Worker workflow cannot be deleted.",
				409,
			);
		}
	});
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: () => ({
			running: [
				{
					id: jobId,
					number: 0,
					createdAt: 1_786_979_400_000,
					prompt: { "1": { class_type: "TestNode", inputs: {} } },
					clientId: null,
				},
			],
			pending: [],
		}),
		updateQueue,
		submitPrompt: async () => ({ id: "unused", number: 1 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const deletion = await fetch(new URL("api/queue", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ delete: [jobId] }),
	});
	expect(deletion.status).toBe(409);
	expect(await deletion.json()).toEqual({
		error: "The current Worker workflow cannot be deleted.",
	});

	const clear = await fetch(new URL("api/queue", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ clear: true }),
	});
	expect(clear.status).toBe(200);
	expect(updateQueue).toHaveBeenLastCalledWith({ clear: true });
});

test("rejects cross-site prompt submissions and WebSocket connections", async () => {
	const upstream = await listen(createServer((_request, response) => response.end()));
	const submitPrompt = vi.fn(async () => ({ id: "unused", number: 0 }));
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt,
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const response = await fetch(new URL("api/prompt", gatewayUrl), {
		method: "POST",
		headers: {
			"Content-Type": "text/plain",
			Origin: "https://evil.example",
			"Sec-Fetch-Site": "cross-site",
		},
		body: JSON.stringify({
			prompt: { "1": { class_type: "TestNode", inputs: {} } },
		}),
	});
	expect(response.status).toBe(403);
	expect(submitPrompt).not.toHaveBeenCalled();
	const reboundHost = `attacker.example:${new URL(gatewayUrl).port}`;
	const reboundResponse = await fetch(new URL("api/prompt", gatewayUrl), {
		method: "POST",
		headers: {
			"Content-Type": "text/plain",
			Host: reboundHost,
			Origin: `http://${reboundHost}`,
		},
		body: JSON.stringify({
			prompt: { "1": { class_type: "TestNode", inputs: {} } },
		}),
	});
	expect(reboundResponse.status).toBe(403);
	expect(submitPrompt).not.toHaveBeenCalled();

	const client = new WebSocket(new URL("ws", gatewayUrl), {
		origin: "https://evil.example",
	});
	const [upgradeRequest, upgradeResponse] = (await once(
		client,
		"unexpected-response",
	)) as [{ destroy(): void }, { statusCode: number; resume(): void }];
	expect(upgradeResponse.statusCode).toBe(403);
	upgradeResponse.resume();
	upgradeRequest.destroy();
});

test("coalesces concurrent starts into one gateway", async () => {
	const upstream = await listen(createServer((_request, response) => response.end()));
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);

	const [first, second] = await Promise.all([gateway.start(), gateway.start()]);
	expect(second).toBe(first);
});

test("reuses an assigned Gateway port after restart", async () => {
	const persistedPorts: number[] = [];
	const first = new ComfyGateway({
		getUpstreamUrl: () => null,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
		persistPort: async (port) => {
			persistedPorts.push(port);
		},
	});
	gateways.push(first);
	const firstUrl = await first.start();
	await first.stop();

	const assignedPort = Number(new URL(firstUrl).port);
	const restored = new ComfyGateway({
		listenPort: assignedPort,
		getUpstreamUrl: () => null,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(restored);

	expect(await restored.start()).toBe(firstUrl);
	expect(persistedPorts).toEqual([assignedPort]);
});

test("does not publish a Gateway URL when its port cannot be persisted", async () => {
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => null,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
		persistPort: async () => {
			throw new Error("Port settings are read-only.");
		},
	});
	gateways.push(gateway);

	await expect(gateway.start()).rejects.toThrow("Port settings are read-only.");
	expect(gateway.getUrl()).toBeNull();
});

test("retries the saved Gateway port without falling back after a conflict", async () => {
	const occupiedServer = createServer((_request, response) => response.end());
	const occupiedUrl = await listen(occupiedServer);
	const port = Number(new URL(occupiedUrl).port);
	const gateway = new ComfyGateway({
		listenPort: port,
		getUpstreamUrl: () => null,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);

	await expect(gateway.start()).rejects.toThrow(
		`The saved ComfyUI Gateway port ${port} is already in use.`,
	);
	expect(gateway.getUrl()).toBeNull();

	await new Promise<void>((resolve, reject) => {
		occupiedServer.close((error) => (error ? reject(error) : resolve()));
	});
	servers.splice(servers.indexOf(occupiedServer), 1);

	expect(await gateway.start()).toBe(occupiedUrl);
});

test("serves collected Worker jobs from local Jobs and History endpoints", async () => {
	const fileId = "a".repeat(64);
	const modelFileId = "b".repeat(64);
	const tempFileId = "c".repeat(64);
	const job = {
		id: "11111111-1111-4111-8111-111111111111",
		number: 2,
		createdAt: 100,
		completedAt: 200,
		prompt: { "4": { class_type: "SaveImage", inputs: {} } },
		extraData: { extra_pnginfo: { workflow: {} } },
		clientId: "comfy-client",
		status: "completed" as const,
		outputs: {
			"1": { text: ["raw preview"] },
			"2": {
				files: [{ filename: "state.latent", subfolder: "", type: "output" }],
			},
			"3": {
				images: [
					{
						filename: "preview.png",
						subfolder: `kastard/11111111-1111-4111-8111-111111111111/${tempFileId}`,
						type: "output",
						kastard_file_id: tempFileId,
					},
				],
			},
			"4": {
				images: [
					{
						filename: "result.png",
						subfolder: `kastard/11111111-1111-4111-8111-111111111111/${fileId}`,
						type: "output",
					},
				],
			},
			"5": {
				text: [{ filename: "notes.txt", subfolder: "", type: "output" }],
			},
			"6": {
				mesh: [
					{
						filename: "model.glb",
						subfolder: `kastard/11111111-1111-4111-8111-111111111111/${modelFileId}`,
						type: "output",
						mediaType: "3d",
					},
				],
			},
		},
		files: [
			{
				id: tempFileId,
				filename: "preview.png",
				subfolder: "",
				type: "temp" as const,
				size: 0,
				sha256: tempFileId,
				contentType: "image/png",
			},
		],
	};
	const updateHistory = vi.fn(async () => undefined);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => null,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		getHistory: () => [job],
		getHistoryJob: (jobId) => (jobId === job.id ? job : null),
		updateHistory,
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	expect(
		await (await fetch(new URL("api/jobs?status=completed", gatewayUrl))).json(),
	).toMatchObject({
		jobs: [
			{
				id: job.id,
				status: "completed",
				outputs_count: 5,
				previewable_outputs_count: 4,
				preview_output: {
					filename: "result.png",
					subfolder: `kastard/${job.id}/${fileId}`,
					type: "output",
					nodeId: "4",
					mediaType: "images",
				},
			},
		],
		pagination: { total: 1 },
	});
	expect(
		await (await fetch(new URL(`api/jobs/${job.id}`, gatewayUrl))).json(),
	).toMatchObject({ id: job.id, outputs: job.outputs });
	expect(
		await (await fetch(new URL(`history/${job.id}`, gatewayUrl))).json(),
	).toMatchObject({ [job.id]: { outputs: job.outputs, status: { completed: true } } });
	const clear = await fetch(new URL("api/history", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ clear: true }),
	});
	expect(clear.status).toBe(200);
	expect(updateHistory).toHaveBeenCalledWith({ clear: true });
});

test("maps stored Worker cancellations to the ComfyUI Job status", async () => {
	const job = {
		id: "11111111-1111-4111-8111-111111111111",
		number: 2,
		createdAt: 1_786_979_400_000,
		completedAt: 1_786_979_401_000,
		prompt: { "1": { class_type: "TestNode", inputs: {} } },
		extraData: {},
		clientId: null,
		status: "canceled" as const,
		outputs: {},
		files: [],
	};
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => null,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		getHistory: () => [job],
		getHistoryJob: (jobId) => (jobId === job.id ? job : null),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	expect(
		await (await fetch(new URL("api/jobs?status=cancelled", gatewayUrl))).json(),
	).toMatchObject({
		jobs: [{ id: job.id, status: "cancelled" }],
		pagination: { total: 1 },
	});
	expect(
		await (await fetch(new URL(`api/jobs/${job.id}`, gatewayUrl))).json(),
	).toMatchObject({ id: job.id, status: "cancelled" });
});

test("merges collected Worker jobs with local ComfyUI Jobs and History", async () => {
	const localJobId = "22222222-2222-4222-8222-222222222222";
	const upstreamHistoryMutations: unknown[] = [];
	const workerJob = {
		id: "11111111-1111-4111-8111-111111111111",
		number: 2,
		createdAt: 300,
		completedAt: 400,
		prompt: { "4": { class_type: "SaveImage", inputs: {} } },
		extraData: {},
		clientId: null,
		status: "completed" as const,
		outputs: { "4": { images: [] } },
		files: [],
	};
	const upstream = await listen(
		createServer(async (request, response) => {
			const path = new URL(request.url ?? "/", "http://local-comfy").pathname;
			response.setHeader("Content-Type", "application/json");
			if (path === "/api/jobs") {
				response.end(
					JSON.stringify({
						jobs: [
							{
								id: localJobId,
								status: "completed",
								create_time: 200,
							},
						],
						pagination: { offset: 0, limit: 10000, total: 1, has_more: false },
					}),
				);
				return;
			}
			if (path === `/api/jobs/${localJobId}`) {
				response.end(JSON.stringify({ id: localJobId, status: "completed" }));
				return;
			}
			if (path === "/history" && request.method === "POST") {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				upstreamHistoryMutations.push(
					JSON.parse(Buffer.concat(chunks).toString("utf8")),
				);
				response.end("{}");
				return;
			}
			if (path === "/history") {
				response.end(
					JSON.stringify({
						[localJobId]: { outputs: { local: true }, status: { completed: true } },
					}),
				);
				return;
			}
			if (path === `/history/${localJobId}`) {
				response.end(
					JSON.stringify({
						[localJobId]: { outputs: { local: true }, status: { completed: true } },
					}),
				);
				return;
			}
			if (path === "/api/jobs/%ZZ" || path === "/history/%ZZ") {
				response.writeHead(400);
				response.end(JSON.stringify({ error: "invalid path" }));
				return;
			}
			response.writeHead(404);
			response.end(JSON.stringify({ error: "not found" }));
		}),
	);
	const updateHistory = vi.fn(async () => undefined);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		getHistory: () => [workerJob],
		getHistoryJob: (jobId) => (jobId === workerJob.id ? workerJob : null),
		updateHistory,
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const jobs = await (
		await fetch(new URL("api/jobs?status=completed", gatewayUrl))
	).json();
	expect(jobs).toMatchObject({
		jobs: [{ id: workerJob.id }, { id: localJobId }],
		pagination: { total: 2 },
	});
	const history = await (await fetch(new URL("history", gatewayUrl))).json();
	expect(history).toMatchObject({
		[workerJob.id]: { outputs: workerJob.outputs },
		[localJobId]: { outputs: { local: true } },
	});
	const limitedHistory = await (
		await fetch(new URL("history?max_items=1", gatewayUrl))
	).json();
	expect(limitedHistory).toEqual({
		[workerJob.id]: expect.objectContaining({ outputs: workerJob.outputs }),
	});
	expect(
		await (await fetch(new URL(`api/jobs/${localJobId}`, gatewayUrl))).json(),
	).toEqual({ id: localJobId, status: "completed" });
	expect(
		await (await fetch(new URL(`history/${localJobId}`, gatewayUrl))).json(),
	).toMatchObject({ [localJobId]: { outputs: { local: true } } });
	const mutation = { delete: [workerJob.id, localJobId] };
	const mutationResponse = await fetch(new URL("history", gatewayUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(mutation),
	});
	expect(mutationResponse.status).toBe(200);
	expect(updateHistory).toHaveBeenCalledWith(mutation);
	expect(upstreamHistoryMutations).toEqual([mutation]);
	for (const path of ["api/jobs/%ZZ", "history/%ZZ"]) {
		const malformed = await fetch(new URL(path, gatewayUrl));
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toEqual({ error: "invalid path" });
	}
});

test("preserves local ComfyUI History larger than the prompt submission limit", async () => {
	const localJobId = "22222222-2222-4222-8222-222222222222";
	const metadata = "x".repeat(32 * 1024 * 1024);
	const upstream = await listen(
		createServer((_request, response) => {
			response.setHeader("Content-Type", "application/json");
			response.end(
				JSON.stringify({
					[localJobId]: { outputs: { metadata }, status: { completed: true } },
				}),
			);
		}),
	);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		getHistory: () => [],
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const history = await (
		await fetch(new URL("history?max_items=1", gatewayUrl))
	).json();
	expect(history).toEqual({
		[localJobId]: { outputs: { metadata }, status: { completed: true } },
	});
});

test("returns a retryable error when local ComfyUI merge sources cannot be read", async () => {
	const upstream = await listen(
		createServer((request, response) => {
			if (request.url?.startsWith("/history")) {
				response.writeHead(503);
				response.end();
				return;
			}
			response.end("not-json");
		}),
	);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		getHistory: () => [],
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const history = await fetch(new URL("history", gatewayUrl));
	expect(history.status).toBe(502);
	expect(await history.json()).toEqual({
		error: "Local ComfyUI History could not be loaded.",
	});
	const jobs = await fetch(new URL("api/jobs", gatewayUrl));
	expect(jobs.status).toBe(502);
	expect(await jobs.json()).toEqual({
		error: "Local ComfyUI Jobs could not be loaded.",
	});
});

test("proxies collected Worker View requests with native methods and headers", async () => {
	const upstreamRequests: Array<{
		method: string | undefined;
		range: string | undefined;
	}> = [];
	const upstream = await listen(
		createServer((request, response) => {
			if (request.url?.startsWith("/view") || request.url?.startsWith("/api/view")) {
				upstreamRequests.push({
					method: request.method,
					range: request.headers.range,
				});
				response.writeHead(206, {
					"Accept-Ranges": "bytes",
					"Content-Length": "4",
					"Content-Range": "bytes 2-5/10",
					"X-Content-Type-Options": "nosniff",
				});
				response.end(request.method === "HEAD" ? undefined : "2345");
				return;
			}
			response.end();
		}),
	);
	const gateway = new ComfyGateway({
		getUpstreamUrl: () => upstream,
		getQueue: emptyQueue,
		updateQueue: vi.fn(),
		submitPrompt: async () => ({ id: "unused", number: 0 }),
	});
	gateways.push(gateway);
	const gatewayUrl = await gateway.start();

	const remotePath =
		`filename=remote.mp4&type=output&subfolder=kastard/${"1".repeat(8)}-` +
		`${"1".repeat(4)}-4111-8111-${"1".repeat(12)}/${"a".repeat(64)}`;
	const ranged = await fetch(new URL(`view?${remotePath}`, gatewayUrl), {
		headers: { Range: "bytes=2-5" },
	});
	expect(ranged.status).toBe(206);
	expect(await ranged.text()).toBe("2345");
	expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10");
	expect(ranged.headers.get("x-content-type-options")).toBe("nosniff");

	const head = await fetch(new URL(`api/view?${remotePath}`, gatewayUrl), {
		method: "HEAD",
		headers: { Range: "bytes=2-5" },
	});
	expect(head.status).toBe(206);
	expect(await head.text()).toBe("");
	expect(head.headers.get("accept-ranges")).toBe("bytes");
	expect(upstreamRequests).toEqual([
		{ method: "GET", range: "bytes=2-5" },
		{ method: "HEAD", range: "bytes=2-5" },
	]);
});

async function listen(server: Server): Promise<string> {
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}/`;
}

function nextJson(socket: WebSocket, count = 1): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const messages: unknown[] = [];
		const onMessage = (data: RawData, binary: boolean): void => {
			if (binary) return;
			try {
				messages.push(JSON.parse(data.toString()));
			} catch (error) {
				cleanup();
				reject(error);
				return;
			}
			if (messages.length !== count) return;
			cleanup();
			resolve(count === 1 ? messages[0] : messages);
		};
		const onClose = (): void => {
			cleanup();
			reject(new Error("WebSocket closed before all messages arrived."));
		};
		const cleanup = (): void => {
			socket.off("message", onMessage);
			socket.off("close", onClose);
		};
		socket.on("message", onMessage);
		socket.once("close", onClose);
	});
}

function nextBinary(socket: WebSocket): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const onMessage = (data: RawData, binary: boolean): void => {
			if (!binary) return;
			cleanup();
			resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
		};
		const onClose = (): void => {
			cleanup();
			reject(new Error("WebSocket closed before binary data arrived."));
		};
		const cleanup = (): void => {
			socket.off("message", onMessage);
			socket.off("close", onClose);
		};
		socket.on("message", onMessage);
		socket.once("close", onClose);
	});
}

function emptyQueue() {
	return { running: [], pending: [] };
}
