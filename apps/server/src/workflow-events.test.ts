import { expect, test, vi } from "bun:test";
import { WorkflowEventHub } from "./workflow-events";

const jobId = "11111111-1111-4111-8111-111111111111";
const comfyPromptId = "22222222-2222-4222-8222-222222222222";

test("maps live Comfy messages to the workflow job and restores snapshots", () => {
	const hub = new WorkflowEventHub();
	const first = sink();
	const unsubscribe = hub.subscribe(jobId, first);
	hub.publishJson(jobId, comfyPromptId, {
		type: "progress_state",
		data: {
			prompt_id: comfyPromptId,
			nodes: { "7": { prompt_id: comfyPromptId, value: 2, max: 10 } },
		},
	});
	hub.publishJson(jobId, comfyPromptId, {
		type: "executing",
		data: { prompt_id: "another-job", node: "8" },
	});

	expect(first.text).toHaveBeenCalledTimes(1);
	expect(JSON.parse(first.text.mock.calls[0]?.[0] ?? "null")).toEqual({
		sequence: 1,
		message: {
			type: "progress_state",
			data: {
				prompt_id: jobId,
				nodes: { "7": { prompt_id: jobId, value: 2, max: 10 } },
			},
		},
	});
	unsubscribe();
	const reconnect = sink();
	hub.subscribe(jobId, reconnect);
	expect(reconnect.text).toHaveBeenCalledWith(first.text.mock.calls[0]?.[0]);
});

test("forwards preview bytes and rewrites preview metadata", () => {
	const hub = new WorkflowEventHub();
	const target = sink();
	hub.subscribe(jobId, target);
	const metadata = new TextEncoder().encode(
		JSON.stringify({ prompt_id: comfyPromptId, node_id: "4" }),
	);
	const preview = new Uint8Array(8 + metadata.byteLength + 3);
	const view = new DataView(preview.buffer);
	view.setUint32(0, 4);
	view.setUint32(4, metadata.byteLength);
	preview.set(metadata, 8);
	preview.set([1, 2, 3], 8 + metadata.byteLength);

	hub.publishBinary(jobId, comfyPromptId, preview);
	const sent = target.binary.mock.calls[0]?.[0];
	expect(sent).toBeInstanceOf(Uint8Array);
	const sentView = new DataView(sent?.buffer ?? new ArrayBuffer(0));
	const sentMetadataLength = sentView.getUint32(4);
	expect(
		JSON.parse(new TextDecoder().decode(sent?.subarray(8, 8 + sentMetadataLength))),
	).toEqual({ prompt_id: jobId, node_id: "4" });
	expect([...(sent?.subarray(8 + sentMetadataLength) ?? [])]).toEqual([1, 2, 3]);
});

test("removes an empty event channel after its last subscriber disconnects", () => {
	const hub = new WorkflowEventHub();
	const unsubscribe = hub.subscribe(jobId, sink());
	expect(channelCount(hub)).toBe(1);

	unsubscribe();
	expect(channelCount(hub)).toBe(0);
});

function sink() {
	const text = vi.fn<(value: string) => void>();
	const binary = vi.fn<(value: Uint8Array) => void>();
	return { text, binary, sendText: text, sendBinary: binary };
}

function channelCount(hub: WorkflowEventHub): number {
	return (
		hub as unknown as {
			channels: Map<string, unknown>;
		}
	).channels.size;
}
