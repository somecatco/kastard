import type {
	WorkerComfyMemoryCleanupRequest,
	WorkflowJobFailure,
	WorkflowResultFile,
} from "@kastard/common";

export type WorkerWorkflowQueueItem = {
	id: string;
	number: number;
	createdAt: number;
	prompt: Record<string, unknown>;
	clientId: string | null;
};

export type WorkerWorkflowQueue = {
	running: WorkerWorkflowQueueItem[];
	pending: WorkerWorkflowQueueItem[];
};

export type WorkerWorkflowEvent =
	| { id: string; clientId: string | null; status: "completed" }
	| { id: string; clientId: string | null; status: "canceled" }
	| {
			id: string;
			clientId: string | null;
			status: "failed";
			error: WorkflowJobFailure;
	  };

export type WorkerWorkflowLiveMessage = {
	type: string;
	data: unknown;
};

export type WorkerWorkflowLiveEvent = {
	id: string;
	clientId: string | null;
	message?: WorkerWorkflowLiveMessage;
	preview?: Uint8Array;
};

export type StoredWorkflowJob = WorkerWorkflowQueueItem & {
	extraData: Record<string, unknown>;
	status: "completed" | "failed" | "canceled";
	completedAt: number;
	outputs: unknown;
	files: WorkflowResultFile[];
	error?: WorkflowJobFailure;
};

export type ComfyGatewayWorkerPort = {
	isWorkerConnected?: () => boolean;
	freeWorkerMemory?: (request: WorkerComfyMemoryCleanupRequest) => Promise<void>;
	getQueue: () => WorkerWorkflowQueue;
	updateQueue: (mutation: { clear: true } | { delete: string[] }) => void;
	cancelCurrent?: () => string | null;
	getHistory?: () => StoredWorkflowJob[];
	getHistoryJob?: (jobId: string) => StoredWorkflowJob | null;
	updateHistory?: (mutation: { clear: true } | { delete: string[] }) => Promise<void>;
	submitPrompt: (
		prompt: Record<string, unknown>,
		clientId: string | null,
		extraData: Record<string, unknown>,
	) => Promise<{ id: string; number: number }>;
};

export class ComfyGatewayRequestError extends Error {
	constructor(
		message: string,
		readonly statusCode: 400 | 409 | 503,
	) {
		super(message);
	}
}
