import WebSocket, { type RawData } from "ws";
import type { WorkerSessionCredential } from "./client";

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
const HEARTBEAT_MS = 15_000;

export type WorkerWorkflowLiveMessage = {
	type: string;
	data: unknown;
};

export type WorkerWorkflowEventConnection = {
	close: () => void;
};

export async function openWorkerWorkflowEvents(
	credential: WorkerSessionCredential,
	jobId: string,
	handlers: {
		onMessage: (message: WorkerWorkflowLiveMessage) => void;
		onPreview: (message: Uint8Array) => void;
	},
): Promise<WorkerWorkflowEventConnection> {
	let socket: WebSocket | null = null;
	let reconnectTimer: NodeJS.Timeout | null = null;
	let heartbeat: NodeJS.Timeout | null = null;
	let stopped = false;
	let reconnectAttempt = 0;
	let lastSequence = 0;

	const stopTimers = (): void => {
		if (reconnectTimer !== null) clearTimeout(reconnectTimer);
		if (heartbeat !== null) clearInterval(heartbeat);
		reconnectTimer = null;
		heartbeat = null;
	};
	const terminateSocket = (): void => {
		socket?.terminate();
	};

	const connect = (): Promise<void> =>
		new Promise((resolve, reject) => {
			const next = new WebSocket(workflowEventUrl(credential.workerApiUrl, jobId), {
				handshakeTimeout: 10_000,
				headers: {
					Authorization: `Bearer ${credential.sessionCapability}`,
				},
			});
			socket = next;
			let opened = false;
			let alive = true;
			next.binaryType = "arraybuffer";
			next.once("open", () => {
				opened = true;
				reconnectAttempt = 0;
				heartbeat = setInterval(() => {
					if (!alive) {
						next.terminate();
						return;
					}
					alive = false;
					next.ping();
				}, HEARTBEAT_MS);
				resolve();
			});
			next.on("pong", () => {
				alive = true;
			});
			next.on("message", (data, binary) => {
				if (binary) {
					handlers.onPreview(rawBytes(data));
					return;
				}
				const event = workflowEventMessage(data.toString(), jobId, lastSequence);
				if (event === null) return;
				lastSequence = event.sequence;
				handlers.onMessage(event.message);
			});
			next.once("error", (error) => {
				if (!opened) reject(error);
			});
			next.once("close", () => {
				if (heartbeat !== null) clearInterval(heartbeat);
				heartbeat = null;
				if (!opened)
					reject(new Error("Worker workflow event stream could not be opened."));
				if (stopped) return;
				const delay =
					RECONNECT_DELAYS_MS[
						Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
					] ??
					RECONNECT_DELAYS_MS.at(-1) ??
					10_000;
				reconnectAttempt += 1;
				reconnectTimer = setTimeout(() => {
					reconnectTimer = null;
					void connect().catch(() => undefined);
				}, delay);
			});
		});

	try {
		await connect();
	} catch (error) {
		stopped = true;
		stopTimers();
		terminateSocket();
		throw error;
	}
	return {
		close: () => {
			stopped = true;
			stopTimers();
			socket?.close();
		},
	};
}

function workflowEventUrl(workerApiUrl: string, jobId: string): string {
	const url = new URL(
		`workflow-jobs/${encodeURIComponent(jobId)}/events`,
		`${workerApiUrl}/`,
	);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

function workflowEventMessage(
	serialized: string,
	jobId: string,
	lastSequence: number,
): { sequence: number; message: WorkerWorkflowLiveMessage } | null {
	try {
		const value: unknown = JSON.parse(serialized);
		if (
			!isRecord(value) ||
			typeof value.sequence !== "number" ||
			!Number.isSafeInteger(value.sequence) ||
			value.sequence <= lastSequence ||
			!isRecord(value.message) ||
			typeof value.message.type !== "string" ||
			!isRecord(value.message.data)
		) {
			return null;
		}
		if (value.message.data.prompt_id !== jobId) {
			return null;
		}
		return {
			sequence: value.sequence,
			message: { type: value.message.type, data: value.message.data },
		};
	} catch {
		return null;
	}
}

function rawBytes(data: RawData): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (Array.isArray(data)) return Buffer.concat(data);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
