import { expect, test, vi } from "vitest";
import { LocalComfyUiTransport } from "./local";
import { ComfyGatewayWorkflow } from "./workflow";

test("publishes Worker events only after collected results become Desktop-readable", () => {
	const job = {
		id: "workflow-job",
		number: 1,
		createdAt: 100,
		completedAt: 200,
		prompt: {},
		extraData: {},
		clientId: "comfy-client",
		status: "completed" as const,
		outputs: {
			"4": {
				images: [
					{
						filename: "result.png",
						subfolder: "kastard/workflow-job/file-id",
						type: "output",
					},
				],
			},
		},
		files: [],
	};
	const sent: Array<{ clientId: string | null; value: unknown }> = [];
	const previews: Array<{ clientId: string | null; value: Uint8Array }> = [];
	const workflow = new ComfyGatewayWorkflow(
		{
			getQueue: () => ({ running: [], pending: [] }),
			updateQueue: vi.fn(),
			getHistoryJob: (jobId) => (jobId === job.id ? job : null),
			submitPrompt: async () => ({ id: "unused", number: 0 }),
		},
		new LocalComfyUiTransport(
			() => null,
			() => null,
		),
		{
			send: (clientId, value) => sent.push({ clientId, value }),
			sendBinary: (clientId, value) => previews.push({ clientId, value }),
		},
	);

	workflow.sendLive({
		id: job.id,
		clientId: "comfy-client",
		message: {
			type: "executed",
			data: {
				prompt_id: job.id,
				node: "4",
				output: {
					images: [{ filename: "result.png", subfolder: "remote", type: "output" }],
				},
			},
		},
	});
	workflow.sendLive({
		id: job.id,
		clientId: "comfy-client",
		message: {
			type: "progress",
			data: { prompt_id: job.id, node: "4", value: 1, max: 1 },
		},
		preview: new Uint8Array([1, 2, 3]),
	});

	expect(sent).toEqual([
		{
			clientId: "comfy-client",
			value: {
				type: "progress",
				data: { prompt_id: job.id, node: "4", value: 1, max: 1 },
			},
		},
	]);
	expect(previews).toEqual([
		{ clientId: "comfy-client", value: new Uint8Array([1, 2, 3]) },
	]);

	workflow.sendTerminal({ id: job.id, clientId: "comfy-client", status: "completed" });

	expect(sent.slice(1)).toEqual([
		{
			clientId: "comfy-client",
			value: {
				type: "executed",
				data: {
					prompt_id: job.id,
					node: "4",
					display_node: "4",
					output: job.outputs["4"],
				},
			},
		},
		{
			clientId: "comfy-client",
			value: { type: "execution_success", data: { prompt_id: job.id } },
		},
	]);
});
