const LIVE_EVENT_TYPES = new Set([
	"executing",
	"execution_cached",
	"executed",
	"progress",
	"progress_state",
]);

const PREVIEW_IMAGE_WITH_METADATA = 4;

export type WorkflowEventMessage = {
	sequence: number;
	message: {
		type: string;
		data: unknown;
	};
};

export type WorkflowEventSink = {
	sendText: (message: string) => void;
	sendBinary: (message: Uint8Array) => void;
};

type WorkflowEventChannel = {
	sequence: number;
	messages: Map<string, WorkflowEventMessage>;
	preview: Uint8Array | null;
	sinks: Set<WorkflowEventSink>;
};

export class WorkflowEventHub {
	private readonly channels = new Map<string, WorkflowEventChannel>();

	subscribe(jobId: string, sink: WorkflowEventSink): () => void {
		const channel = this.channel(jobId);
		channel.sinks.add(sink);
		for (const event of [...channel.messages.values()].sort(
			(left, right) => left.sequence - right.sequence,
		)) {
			sink.sendText(JSON.stringify(event));
		}
		if (channel.preview !== null) sink.sendBinary(channel.preview);
		return () => {
			channel.sinks.delete(sink);
			if (
				channel.sinks.size === 0 &&
				channel.messages.size === 0 &&
				channel.preview === null &&
				this.channels.get(jobId) === channel
			) {
				this.channels.delete(jobId);
			}
		};
	}

	publishJson(jobId: string, comfyPromptId: string, message: unknown): void {
		const normalized = normalizeLiveMessage(message, comfyPromptId, jobId);
		if (normalized === null) return;
		const channel = this.channel(jobId);
		const event = {
			sequence: ++channel.sequence,
			message: normalized,
		};
		channel.messages.set(normalized.type, event);
		const serialized = JSON.stringify(event);
		for (const sink of channel.sinks) sink.sendText(serialized);
	}

	publishBinary(
		jobId: string,
		comfyPromptId: string,
		message: ArrayBuffer | Uint8Array,
	): void {
		const normalized = normalizePreviewMessage(
			message instanceof Uint8Array ? message : new Uint8Array(message),
			comfyPromptId,
			jobId,
		);
		if (normalized === null) return;
		const channel = this.channel(jobId);
		channel.preview = normalized;
		for (const sink of channel.sinks) sink.sendBinary(normalized);
	}

	delete(jobId: string): void {
		this.channels.delete(jobId);
	}

	private channel(jobId: string): WorkflowEventChannel {
		const existing = this.channels.get(jobId);
		if (existing !== undefined) return existing;
		const channel: WorkflowEventChannel = {
			sequence: 0,
			messages: new Map(),
			preview: null,
			sinks: new Set(),
		};
		this.channels.set(jobId, channel);
		return channel;
	}
}

function normalizeLiveMessage(
	value: unknown,
	comfyPromptId: string,
	jobId: string,
): WorkflowEventMessage["message"] | null {
	if (
		!isRecord(value) ||
		typeof value.type !== "string" ||
		!LIVE_EVENT_TYPES.has(value.type) ||
		!isRecord(value.data)
	) {
		return null;
	}
	if (value.data.prompt_id !== comfyPromptId) {
		return null;
	}
	return {
		type: value.type,
		data: replacePromptId(value.data, comfyPromptId, jobId),
	};
}

function normalizePreviewMessage(
	value: Uint8Array,
	comfyPromptId: string,
	jobId: string,
): Uint8Array | null {
	if (value.byteLength < 4) return null;
	const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
	const type = view.getUint32(0);
	if (type !== PREVIEW_IMAGE_WITH_METADATA || value.byteLength < 8) return null;
	const metadataLength = view.getUint32(4);
	if (metadataLength > value.byteLength - 8) return null;
	try {
		const metadataBytes = value.subarray(8, 8 + metadataLength);
		const metadata: unknown = JSON.parse(new TextDecoder().decode(metadataBytes));
		if (!isRecord(metadata)) return null;
		if (metadata.prompt_id !== comfyPromptId) {
			return null;
		}
		const normalized = new TextEncoder().encode(
			JSON.stringify(replacePromptId(metadata, comfyPromptId, jobId)),
		);
		const output = new Uint8Array(
			8 + normalized.byteLength + value.byteLength - 8 - metadataLength,
		);
		const outputView = new DataView(output.buffer);
		outputView.setUint32(0, PREVIEW_IMAGE_WITH_METADATA);
		outputView.setUint32(4, normalized.byteLength);
		output.set(normalized, 8);
		output.set(value.subarray(8 + metadataLength), 8 + normalized.byteLength);
		return output;
	} catch {
		return null;
	}
}

function replacePromptId(
	value: unknown,
	comfyPromptId: string,
	jobId: string,
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => replacePromptId(entry, comfyPromptId, jobId));
	}
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			key === "prompt_id" && entry === comfyPromptId
				? jobId
				: replacePromptId(entry, comfyPromptId, jobId),
		]),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
