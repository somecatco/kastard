import type { IncomingMessage, ServerResponse } from "node:http";
import {
	parseWorkerComfyMemoryCleanupRequest,
	type WorkerComfyMemoryCleanupRequest,
} from "@kastard/common";
import {
	comfyActiveJob,
	comfyHistory,
	comfyJobs,
	comfyQueue,
	comfyQueueStatus,
	comfyStoredJob,
	comfyTerminalMessage,
	completedExecutedMessages,
	isActiveJobsRequest,
	mergedComfyHistory,
	shouldDeferExecutedMessage,
	workflowExtraData,
} from "./compat";
import type { LocalComfyUiTransport } from "./local";
import {
	ComfyGatewayRequestError,
	type ComfyGatewayWorkerPort,
	type WorkerWorkflowEvent,
	type WorkerWorkflowLiveEvent,
	type WorkerWorkflowLiveMessage,
} from "./worker-port";

const MAX_PROMPT_BYTES = 32 * 1024 * 1024;

export type ComfyGatewayWorkflowOptions = ComfyGatewayWorkerPort;

type WorkflowClients = {
	send: (clientId: string | null, value: unknown) => void;
	sendBinary: (clientId: string | null, value: Uint8Array) => void;
};

export class ComfyGatewayWorkflow {
	private readonly deferredExecuted = new Map<string, WorkerWorkflowLiveMessage[]>();

	constructor(
		private readonly options: ComfyGatewayWorkflowOptions,
		private readonly local: LocalComfyUiTransport,
		private readonly clients: WorkflowClients,
	) {}

	async handle(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
	): Promise<boolean> {
		const path = url.pathname;
		if (request.method === "POST" && (path === "/prompt" || path === "/api/prompt")) {
			await this.handlePrompt(request, response);
			return true;
		}
		if (
			request.method === "POST" &&
			(path === "/free" || path === "/api/free") &&
			this.options.isWorkerConnected?.() === true
		) {
			await this.handleMemoryCleanup(request, response);
			return true;
		}
		if (request.method === "GET" && (path === "/queue" || path === "/api/queue")) {
			writeJson(response, 200, comfyQueue(this.options.getQueue()));
			return true;
		}
		if (request.method === "POST" && (path === "/queue" || path === "/api/queue")) {
			await this.handleQueueMutation(request, response);
			return true;
		}
		if (
			request.method === "POST" &&
			(path === "/interrupt" || path === "/api/interrupt")
		) {
			const canceledJobId = this.options.cancelCurrent?.() ?? null;
			if (canceledJobId !== null) {
				writeJson(response, 200, {});
				return true;
			}
			return false;
		}
		const cancelJobId = path.match(/^\/(?:api\/)?jobs\/([^/]+)\/cancel$/)?.[1];
		if (request.method === "POST" && cancelJobId !== undefined) {
			return this.handleJobCancellation(response, cancelJobId);
		}
		if (
			request.method === "POST" &&
			(path === "/jobs/cancel" || path === "/api/jobs/cancel")
		) {
			await this.handleJobCancellations(request, response);
			return true;
		}
		const jobId = path.match(/^\/(?:api\/)?jobs\/([^/]+)$/)?.[1];
		if (
			request.method === "GET" &&
			jobId !== undefined &&
			this.options.getHistoryJob !== undefined
		) {
			return this.handleJob(response, jobId);
		}
		const historyId = path.match(/^\/(?:api\/)?history\/([^/]+)$/)?.[1];
		if (
			request.method === "GET" &&
			historyId !== undefined &&
			this.options.getHistoryJob !== undefined
		) {
			return this.handleHistoryJob(response, historyId);
		}
		if (
			request.method === "GET" &&
			(path === "/history" || path === "/api/history") &&
			this.options.getHistory !== undefined
		) {
			await this.handleHistory(request, response, url);
			return true;
		}
		if (
			request.method === "POST" &&
			(path === "/history" || path === "/api/history") &&
			this.options.updateHistory !== undefined
		) {
			await this.handleHistoryMutation(request, response);
			return true;
		}
		if (
			request.method === "GET" &&
			(path === "/jobs" || path === "/api/jobs") &&
			(isActiveJobsRequest(url) || this.options.getHistory !== undefined)
		) {
			await this.handleJobs(request, response, url);
			return true;
		}
		return false;
	}

	sendStarted(jobId: string, clientId: string | null): void {
		this.clients.send(clientId, {
			type: "execution_start",
			data: { prompt_id: jobId },
		});
	}

	sendQueueStatus(queue = this.options.getQueue()): void {
		this.clients.send(null, comfyQueueStatus(queue));
	}

	sendLive(event: WorkerWorkflowLiveEvent): void {
		if (shouldDeferExecutedMessage(event.message)) {
			// Worker file references become Desktop-readable only after result publication.
			const messages = this.deferredExecuted.get(event.id) ?? [];
			messages.push(event.message);
			this.deferredExecuted.set(event.id, messages);
		} else if (event.message !== undefined) {
			this.clients.send(event.clientId, event.message);
		}
		if (event.preview !== undefined)
			this.clients.sendBinary(event.clientId, event.preview);
	}

	sendTerminal(event: WorkerWorkflowEvent): void {
		const deferred = this.deferredExecuted.get(event.id) ?? [];
		this.deferredExecuted.delete(event.id);
		if (event.status === "completed") {
			const job = this.options.getHistoryJob?.(event.id) ?? null;
			if (job?.status === "completed") {
				for (const message of completedExecutedMessages(job, deferred)) {
					this.clients.send(event.clientId, message);
				}
			}
		}
		this.clients.send(event.clientId, comfyTerminalMessage(event));
	}

	reset(): void {
		this.deferredExecuted.clear();
	}

	private handleJob(response: ServerResponse, encodedJobId: string): boolean {
		const jobId = decodePathSegment(encodedJobId);
		if (jobId === null) return false;
		const job = this.options.getHistoryJob?.(jobId) ?? null;
		const queue = this.options.getQueue();
		const active = [...queue.running, ...queue.pending].find(
			(item) => item.id === jobId,
		);
		if (job !== null) {
			writeJson(response, 200, comfyStoredJob(job, true));
			return true;
		}
		if (active === undefined) return false;
		writeJson(
			response,
			200,
			comfyActiveJob(
				active,
				queue.running.some((item) => item.id === jobId) ? "in_progress" : "pending",
			),
		);
		return true;
	}

	private handleHistoryJob(response: ServerResponse, encodedJobId: string): boolean {
		const jobId = decodePathSegment(encodedJobId);
		if (jobId === null) return false;
		const job = this.options.getHistoryJob?.(jobId) ?? null;
		if (job === null) return false;
		writeJson(response, 200, comfyHistory([job]));
		return true;
	}

	private async handleHistory(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
	): Promise<void> {
		const upstream = await this.local.readJson(request);
		if (this.local.isAvailable() && !isRecord(upstream)) {
			writeJson(response, 502, { error: "Local ComfyUI History could not be loaded." });
			return;
		}
		writeJson(
			response,
			200,
			mergedComfyHistory(
				upstream,
				this.options.getHistory?.() ?? [],
				url.searchParams.get("max_items"),
			),
		);
	}

	private async handleJobs(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
	): Promise<void> {
		const upstream = await this.local.readJobs(request);
		if (this.local.isAvailable() && upstream === null) {
			writeJson(response, 502, { error: "Local ComfyUI Jobs could not be loaded." });
			return;
		}
		writeJson(
			response,
			200,
			comfyJobs(
				this.options.getQueue(),
				url,
				this.options.getHistory?.() ?? [],
				upstream,
			),
		);
	}

	private async handleHistoryMutation(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		try {
			const body = await readJson(request);
			const mutation =
				isRecord(body) && body.clear === true
					? ({ clear: true } as const)
					: isRecord(body) &&
							Array.isArray(body.delete) &&
							body.delete.every((id) => typeof id === "string")
						? { delete: body.delete }
						: null;
			if (mutation === null) throw new Error("Invalid workflow history change.");
			const upstreamExpected = this.local.isAvailable();
			const [, upstream] = await Promise.all([
				this.options.updateHistory?.(mutation),
				this.local.request(request, { body: Buffer.from(JSON.stringify(mutation)) }),
			]);
			if (
				upstreamExpected &&
				(upstream === null || upstream.statusCode < 200 || upstream.statusCode >= 300)
			) {
				throw new Error("Local ComfyUI history change failed.");
			}
			writeJson(response, 200, {});
		} catch {
			writeJson(response, 500, { error: "Workflow history change failed." });
		}
	}

	private async handleQueueMutation(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		try {
			const body = await readJson(request);
			if (isRecord(body) && body.clear === true) {
				this.options.updateQueue({ clear: true });
				writeJson(response, 200, {});
				return;
			}
			if (
				isRecord(body) &&
				Array.isArray(body.delete) &&
				body.delete.every((id) => typeof id === "string")
			) {
				this.options.updateQueue({ delete: body.delete });
				writeJson(response, 200, {});
				return;
			}
			throw new ComfyGatewayRequestError("Invalid Worker queue change.", 400);
		} catch (error) {
			const statusCode =
				error instanceof ComfyGatewayRequestError ? error.statusCode : 500;
			const message =
				error instanceof ComfyGatewayRequestError
					? error.message
					: "Worker queue change failed.";
			writeJson(response, statusCode, { error: message });
		}
	}

	private handleJobCancellation(
		response: ServerResponse,
		encodedJobId: string,
	): boolean {
		const jobId = decodePathSegment(encodedJobId);
		if (jobId === null) return false;
		try {
			if (!this.cancelKastardJob(jobId)) return false;
			writeJson(response, 200, {});
		} catch (error) {
			const statusCode =
				error instanceof ComfyGatewayRequestError ? error.statusCode : 500;
			writeJson(response, statusCode, {
				error:
					error instanceof Error ? error.message : "Worker job cancellation failed.",
			});
		}
		return true;
	}

	private async handleJobCancellations(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		try {
			const body = await readJson(request);
			if (
				!isRecord(body) ||
				!Array.isArray(body.job_ids) ||
				!body.job_ids.every((id) => typeof id === "string")
			) {
				throw new ComfyGatewayRequestError("Invalid Worker job cancellation.", 400);
			}
			const unknown = [...new Set(body.job_ids)].filter(
				(jobId) => !this.cancelKastardJob(jobId),
			);
			if (unknown.length > 0) {
				const upstream = await this.local.request(request, {
					body: Buffer.from(JSON.stringify({ job_ids: unknown })),
				});
				if (
					upstream === null ||
					upstream.statusCode < 200 ||
					upstream.statusCode >= 300
				) {
					throw new Error("Local ComfyUI job cancellation failed.");
				}
			}
			writeJson(response, 200, {});
		} catch (error) {
			const statusCode =
				error instanceof ComfyGatewayRequestError ? error.statusCode : 500;
			writeJson(response, statusCode, {
				error:
					error instanceof Error ? error.message : "Worker job cancellation failed.",
			});
		}
	}

	private cancelKastardJob(jobId: string): boolean {
		const queue = this.options.getQueue();
		if (queue.pending.some((item) => item.id === jobId)) {
			this.options.updateQueue({ delete: [jobId] });
			return true;
		}
		if (queue.running.some((item) => item.id === jobId)) {
			if (this.options.cancelCurrent?.() === jobId) return true;
			throw new ComfyGatewayRequestError(
				"The current Worker workflow could not be canceled.",
				409,
			);
		}
		return this.options.getHistoryJob?.(jobId) != null;
	}

	private async handlePrompt(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		try {
			const body = await readJson(request);
			if (!isRecord(body) || !isRecord(body.prompt)) {
				throw new ComfyGatewayRequestError("Invalid workflow prompt.", 400);
			}
			const clientId = typeof body.client_id === "string" ? body.client_id : null;
			const result = await this.options.submitPrompt(
				body.prompt,
				clientId,
				workflowExtraData(body.extra_data),
			);
			writeJson(response, 200, {
				prompt_id: result.id,
				number: result.number,
				node_errors: {},
			});
		} catch (error) {
			const statusCode =
				error instanceof ComfyGatewayRequestError ? error.statusCode : 500;
			const message =
				error instanceof ComfyGatewayRequestError
					? error.message
					: "Worker workflow submission failed.";
			writeJson(response, statusCode, {
				error: {
					type: "worker_execution_error",
					message,
					details: message,
					extra_info: {},
				},
				node_errors: {},
			});
		}
	}

	private async handleMemoryCleanup(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		let cleanup: WorkerComfyMemoryCleanupRequest | null;
		try {
			cleanup = parseWorkerComfyMemoryCleanupRequest(await readJson(request));
		} catch {
			cleanup = null;
		}
		if (cleanup === null) {
			writeJson(response, 400, { error: "Invalid ComfyUI memory cleanup request." });
			return;
		}
		const freeWorkerMemory = this.options.freeWorkerMemory;
		if (freeWorkerMemory === undefined) {
			writeJson(response, 502, {
				error: "Worker ComfyUI memory cleanup is unavailable.",
			});
			return;
		}
		try {
			await freeWorkerMemory(cleanup);
			writeJson(response, 200, {});
		} catch (error) {
			writeJson(response, 502, {
				error:
					error instanceof Error
						? error.message
						: "Worker ComfyUI memory cleanup failed.",
			});
		}
	}
}

function decodePathSegment(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_PROMPT_BYTES) {
			throw new ComfyGatewayRequestError("Workflow prompt is too large.", 400);
		}
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new ComfyGatewayRequestError("Invalid workflow prompt JSON.", 400);
	}
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
