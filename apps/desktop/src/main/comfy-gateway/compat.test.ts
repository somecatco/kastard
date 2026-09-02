import { expect, test } from "vitest";
import {
	comfyJobs,
	comfyQueue,
	comfyTerminalMessage,
	completedExecutedMessages,
	withComfyQueueStatus,
} from "./compat";
import type { WorkerWorkflowQueue } from "./worker-port";

const queue: WorkerWorkflowQueue = {
	running: [
		{
			id: "running-job",
			number: 1,
			createdAt: 300,
			prompt: { "1": { class_type: "RunningNode", inputs: {} } },
			clientId: "comfy-client",
		},
	],
	pending: [
		{
			id: "pending-job",
			number: 2,
			createdAt: 200,
			prompt: { "2": { class_type: "PendingNode", inputs: {} } },
			clientId: null,
		},
	],
};

test("formats the Desktop workflow queue without transport state", () => {
	expect(comfyQueue(queue)).toEqual({
		queue_running: [
			[
				1,
				"running-job",
				queue.running[0]?.prompt,
				{ client_id: "comfy-client", create_time: 300 },
				[],
			],
		],
		queue_pending: [
			[2, "pending-job", queue.pending[0]?.prompt, { create_time: 200 }, []],
		],
	});

	expect(
		JSON.parse(
			withComfyQueueStatus(
				JSON.stringify({
					type: "status",
					data: { sid: "comfy-client", status: { exec_info: { queue_remaining: 0 } } },
				}),
				queue,
			),
		),
	).toEqual({
		type: "status",
		data: {
			sid: "comfy-client",
			status: { exec_info: { queue_remaining: 2 } },
		},
	});
});

test("merges Local and Desktop jobs before applying pagination", () => {
	const url = new URL("http://gateway/api/jobs?status=completed&offset=1&limit=1");
	const history = [
		{
			id: "desktop-job",
			number: 3,
			createdAt: 400,
			completedAt: 500,
			prompt: {},
			extraData: {},
			clientId: null,
			status: "completed" as const,
			outputs: {},
			files: [],
		},
	];
	const result = comfyJobs(queue, url, history, {
		jobs: [
			{ id: "desktop-job", status: "completed", create_time: 100 },
			{ id: "local-job", status: "completed", create_time: 350 },
		],
	});

	expect(result).toMatchObject({
		jobs: [{ id: "local-job", create_time: 350 }],
		pagination: { offset: 1, limit: 1, total: 2, has_more: false },
	});
});

test("maps terminal workflow states to Comfy execution events", () => {
	expect(
		comfyTerminalMessage({
			id: "failed-job",
			clientId: null,
			status: "failed",
			error: {
				code: "connection_lost",
				message: "The Worker connection was lost, so the workflow failed.",
			},
		}),
	).toMatchObject({
		type: "execution_error",
		data: {
			prompt_id: "failed-job",
			exception_type: "KastardWorkerConnectionError",
			exception_message: "The Worker connection was lost, so the workflow failed.",
		},
	});
	expect(
		comfyTerminalMessage({ id: "canceled-job", clientId: null, status: "canceled" }),
	).toMatchObject({
		type: "execution_interrupted",
		data: { prompt_id: "canceled-job" },
	});
});

test("rebuilds executed events from Desktop-readable collected results", () => {
	const job = {
		id: "completed-job",
		number: 4,
		createdAt: 100,
		completedAt: 200,
		prompt: {},
		extraData: {},
		clientId: "comfy-client",
		status: "completed" as const,
		outputs: {
			"7": {
				images: [
					{
						filename: "result.png",
						subfolder: "kastard/completed-job/file-id",
						type: "output",
					},
				],
			},
		},
		files: [],
	};

	expect(
		completedExecutedMessages(job, [
			{
				type: "executed",
				data: { prompt_id: job.id, node: "7", display_node: "preview-node" },
			},
		]),
	).toEqual([
		{
			type: "executed",
			data: {
				prompt_id: job.id,
				node: "7",
				display_node: "preview-node",
				output: job.outputs["7"],
			},
		},
	]);
});
