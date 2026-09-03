import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
	isWorkflowJobId,
	parseWorkflowJobRequest,
	type WorkflowJobFailure,
	type WorkflowJobState,
	type WorkflowResultFile,
	type WorkflowResultManifest,
} from "@kastard/common";
import type { WorkerLogStore } from "./worker-log";
import { WorkflowEventHub } from "./workflow-events";
import {
	type WorkflowInputManifestEntry,
	WorkflowInputStore,
	WorkflowInputStoreError,
} from "./workflow-input-store";

const TERMINAL_JOB_LIMIT = 100;
const INVALID_JOB_STATUS_LIMIT = 60;
const STANDALONE_THREE_D_RESULT_EXTENSIONS = [".glb", ".usdz"];

export type {
	WorkflowJobFailure,
	WorkflowJobState,
	WorkflowResultFile,
	WorkflowResultManifest,
} from "@kastard/common";

export type WorkflowResultDownload = WorkflowResultFile & { path: string };

type TerminalWorkflowJobState = Exclude<
	WorkflowJobState,
	{ status: "running" | "canceling" }
>;

export interface WorkflowJobApi {
	submit(jobId: string, request: unknown): Promise<WorkflowJobState>;
	cancel(jobId: string): Promise<WorkflowJobState>;
	get(jobId: string): WorkflowJobState | null;
	hasActiveJob(): boolean;
	uploadInput(
		jobId: string,
		inputId: string,
		body: ReadableStream<Uint8Array> | null,
		size: number,
		sha256: string,
	): Promise<void>;
	discardInputs(jobId: string): Promise<void>;
	getResults(jobId: string): WorkflowResultManifest | null;
	getResultFile(jobId: string, fileId: string): WorkflowResultDownload | null;
	subscribeEvents(
		jobId: string,
		sink: Parameters<WorkflowEventHub["subscribe"]>[1],
	): () => void;
}

type WorkflowJobOptions = {
	getRootDirectory?: () => string | null;
	getRuntimeUrl: () => string | null;
	getRuntimeGeneration?: () => number | null;
	logs: WorkerLogStore;
	requestFetch?: typeof fetch;
	pollMs?: number;
	events?: WorkflowEventHub;
	openEventSocket?: typeof openComfyEventSocket;
};

type InternalJob = {
	status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
	execution_error?: { exception_message?: unknown };
	outputs?: unknown;
};

export class WorkflowJobError extends Error {
	constructor(
		message: string,
		readonly statusCode: 400 | 409 | 413 | 422 | 502,
		readonly retryable = false,
	) {
		super(message);
	}
}

export class WorkflowJobExecutor implements WorkflowJobApi {
	private readonly requestFetch: typeof fetch;
	private readonly pollMs: number;
	private readonly inputs: WorkflowInputStore;
	private readonly events: WorkflowEventHub;
	private readonly jobs = new Map<string, WorkflowJobState>();
	private readonly results = new Map<
		string,
		{
			manifest: WorkflowResultManifest;
			files: Map<string, WorkflowResultDownload>;
			directory: string | null;
		}
	>();
	private readonly requestFingerprints = new Map<string, string>();
	private activeJobId: string | null = null;
	private activeComfyPromptId: string | null = null;
	private pendingSubmissions = 0;
	private operation = Promise.resolve();

	constructor(private readonly options: WorkflowJobOptions) {
		this.requestFetch = options.requestFetch ?? fetch;
		this.pollMs = options.pollMs ?? 250;
		this.events = options.events ?? new WorkflowEventHub();
		this.inputs = new WorkflowInputStore({
			getRootDirectory: options.getRootDirectory ?? (() => null),
		});
	}

	async initialize(): Promise<void> {
		const root = this.options.getRootDirectory?.() ?? null;
		await Promise.all([
			this.inputs.initialize(),
			root === null
				? Promise.resolve()
				: rm(workflowResultRoot(root), { recursive: true, force: true }),
		]);
	}

	submit(jobId: string, value: unknown): Promise<WorkflowJobState> {
		this.pendingSubmissions += 1;
		return this.lock(() => this.submitOnce(jobId, value)).finally(() => {
			this.pendingSubmissions -= 1;
		});
	}

	private async submitOnce(jobId: string, value: unknown): Promise<WorkflowJobState> {
		const request = workflowRequest(jobId, value);
		const existing = this.get(jobId);
		if (existing !== null) {
			if (existing.status === "canceled" && !this.requestFingerprints.has(jobId)) {
				return existing;
			}
			if (this.requestFingerprints.get(jobId) !== request.fingerprint) {
				throw new WorkflowJobError(
					"The workflow job ID is already bound to different inputs.",
					409,
				);
			}
			return existing;
		}
		if (this.activeJobId !== null) {
			throw new WorkflowJobError(
				"The Worker is already processing a workflow.",
				409,
				true,
			);
		}

		const runtimeUrl = this.options.getRuntimeUrl();
		if (runtimeUrl === null) {
			throw new WorkflowJobError("Worker ComfyUI is not ready.", 409, true);
		}
		const runtimeGeneration = this.options.getRuntimeGeneration?.() ?? runtimeUrl;
		let prompt: unknown;
		try {
			prompt = await this.inputs.publish(jobId, request.prompt, request.inputs);
		} catch (error) {
			if (!(error instanceof WorkflowInputStoreError)) throw error;
			const failed: WorkflowJobState = {
				id: jobId,
				status: "failed",
				error: error.failure.message,
				failure: error.failure,
			};
			this.requestFingerprints.set(jobId, request.fingerprint);
			this.finish(failed);
			await this.inputs.cleanup(jobId).catch(() => undefined);
			return failed;
		}

		const state: WorkflowJobState = { id: jobId, status: "running" };
		this.jobs.set(jobId, state);
		this.requestFingerprints.set(jobId, request.fingerprint);
		this.activeJobId = jobId;
		void this.execute(
			runtimeUrl,
			runtimeGeneration,
			jobId,
			prompt,
			request.extraData,
		).finally(() => this.inputs.cleanup(jobId).catch(() => undefined));
		return state;
	}

	cancel(jobId: string): Promise<WorkflowJobState> {
		return this.lock(() => this.cancelOnce(jobId));
	}

	private async cancelOnce(jobId: string): Promise<WorkflowJobState> {
		if (!isWorkflowJobId(jobId)) {
			throw new WorkflowJobError("Invalid workflow job ID.", 400);
		}
		const existing = this.get(jobId);
		if (
			existing !== null &&
			existing.status !== "running" &&
			existing.status !== "canceling"
		) {
			return existing;
		}
		if (existing === null) {
			const canceled = { id: jobId, status: "canceled" as const };
			this.finish(canceled);
			await this.inputs.cleanup(jobId).catch(() => undefined);
			return canceled;
		}

		const canceling = { id: jobId, status: "canceling" as const };
		this.jobs.set(jobId, canceling);
		const runtimeUrl = this.options.getRuntimeUrl();
		const comfyPromptId = this.activeComfyPromptId;
		if (runtimeUrl === null || comfyPromptId === null) {
			return this.finishCanceled(jobId);
		}

		await this.cancelComfy(runtimeUrl, comfyPromptId);
		const latest = this.get(jobId);
		if (
			latest !== null &&
			latest.status !== "running" &&
			latest.status !== "canceling"
		) {
			return latest;
		}
		return canceling;
	}

	uploadInput(
		jobId: string,
		inputId: string,
		body: ReadableStream<Uint8Array> | null,
		size: number,
		sha256: string,
	): Promise<void> {
		return this.lock(() => this.uploadInputOnce(jobId, inputId, body, size, sha256));
	}

	private async uploadInputOnce(
		jobId: string,
		inputId: string,
		body: ReadableStream<Uint8Array> | null,
		size: number,
		sha256: string,
	): Promise<void> {
		if (this.jobs.has(jobId)) return;
		try {
			await this.inputs.upload(jobId, inputId, body, size, sha256);
		} catch (error) {
			if (!(error instanceof WorkflowInputStoreError)) throw error;
			throw workflowInputJobError(error);
		}
	}

	discardInputs(jobId: string): Promise<void> {
		return this.lock(async () => {
			if (this.jobs.has(jobId)) return;
			try {
				await this.inputs.cleanup(jobId);
			} catch (error) {
				if (!(error instanceof WorkflowInputStoreError)) throw error;
				throw workflowInputJobError(error);
			}
		});
	}

	private async execute(
		runtimeUrl: string,
		runtimeGeneration: number | string,
		jobId: string,
		prompt: unknown,
		extraData: unknown,
	): Promise<void> {
		let eventSocket: WorkflowEventSocket | null = null;
		try {
			const comfyPromptId = randomUUID();
			this.activeComfyPromptId = comfyPromptId;
			if (this.jobs.get(jobId)?.status !== "running") return;
			if (this.options.events !== undefined) {
				eventSocket = await (this.options.openEventSocket ?? openComfyEventSocket)({
					runtimeUrl,
					jobId,
					comfyPromptId,
					events: this.events,
				});
			}
			if (this.jobs.get(jobId)?.status !== "running") {
				if (this.jobs.get(jobId)?.status === "canceling") this.finishCanceled(jobId);
				return;
			}
			const accepted = await this.queue(runtimeUrl, comfyPromptId, prompt, extraData);
			if (this.jobs.get(jobId)?.status === "canceling") {
				await this.cancelComfy(runtimeUrl, comfyPromptId);
			}
			if (accepted) {
				this.options.logs.write("info", `Worker workflow started: ${jobId}`);
			}
			await this.monitor(runtimeUrl, runtimeGeneration, jobId, comfyPromptId, accepted);
		} catch (error) {
			if (this.activeJobId !== jobId) return;
			this.finishCanceledOrFailed(jobId, error);
		} finally {
			eventSocket?.close();
		}
	}

	private async cancelComfy(runtimeUrl: string, comfyPromptId: string): Promise<void> {
		try {
			await Promise.all([
				this.request(new URL("queue", runtimeUrl), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ delete: [comfyPromptId] }),
				}),
				this.request(new URL("interrupt", runtimeUrl), { method: "POST" }),
			]);
		} catch {
			return;
		}
	}

	hasActiveJob(): boolean {
		return this.pendingSubmissions > 0 || this.activeJobId !== null;
	}

	get(jobId: string): WorkflowJobState | null {
		return this.jobs.get(jobId) ?? null;
	}

	getResults(jobId: string): WorkflowResultManifest | null {
		return this.results.get(jobId)?.manifest ?? null;
	}

	getResultFile(jobId: string, fileId: string): WorkflowResultDownload | null {
		return this.results.get(jobId)?.files.get(fileId) ?? null;
	}

	subscribeEvents(
		jobId: string,
		sink: Parameters<WorkflowEventHub["subscribe"]>[1],
	): () => void {
		this.validateEventSubscription(jobId);
		return this.events.subscribe(jobId, sink);
	}

	validateEventSubscription(jobId: string): void {
		if (!isWorkflowJobId(jobId)) {
			throw new WorkflowJobError("Invalid workflow job ID.", 400);
		}
	}

	private async queue(
		runtimeUrl: string,
		comfyPromptId: string,
		prompt: unknown,
		extraData: unknown,
	): Promise<boolean> {
		let response: Response;
		try {
			response = await this.request(new URL("prompt", runtimeUrl), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt,
					prompt_id: comfyPromptId,
					client_id: comfyPromptId,
					extra_data: extraData,
				}),
			});
		} catch {
			return false;
		}
		const payload: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			if (response.status === 400) {
				throw new WorkflowJobError(comfyPromptError(payload), 422);
			}
			throw new WorkflowJobError(comfyError(payload), 502);
		}
		return isRecord(payload) && payload.prompt_id === comfyPromptId;
	}

	private async monitor(
		runtimeUrl: string,
		runtimeGeneration: number | string,
		jobId: string,
		comfyPromptId: string,
		startedLogged: boolean,
	): Promise<void> {
		let invalidStatuses = 0;
		while (
			this.activeJobId === jobId &&
			(this.jobs.get(jobId)?.status === "running" ||
				this.jobs.get(jobId)?.status === "canceling")
		) {
			await delay(this.pollMs);
			if (!this.isCurrentRuntime(runtimeUrl, runtimeGeneration)) {
				this.finishCanceledOrFailed(
					jobId,
					"Worker ComfyUI stopped before the workflow finished.",
				);
				return;
			}
			try {
				const response = await this.request(
					new URL(`api/jobs/${encodeURIComponent(comfyPromptId)}`, runtimeUrl),
				);
				if (response.status === 404) {
					invalidStatuses += 1;
					if (invalidStatuses >= INVALID_JOB_STATUS_LIMIT) {
						this.finishCanceledOrFailed(jobId, "Worker workflow job was not found.");
						return;
					}
					continue;
				}
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const payload: unknown = await response.json().catch(() => null);
				if (!isInternalJob(payload)) {
					invalidStatuses += 1;
					if (invalidStatuses >= INVALID_JOB_STATUS_LIMIT) {
						this.finishCanceledOrFailed(
							jobId,
							"Worker workflow status remained invalid.",
						);
						return;
					}
					continue;
				}
				invalidStatuses = 0;
				if (!startedLogged) {
					this.options.logs.write("info", `Worker workflow started: ${jobId}`);
					startedLogged = true;
				}
				if (payload.status === "pending" || payload.status === "in_progress") continue;
				if (payload.status === "cancelled") {
					this.finishCanceled(jobId);
					return;
				}
				if (payload.status === "completed") {
					try {
						const result = await createWorkflowResults(
							jobId,
							payload.outputs ?? {},
							this.options.getRootDirectory?.() ?? null,
						);
						this.results.set(jobId, result);
					} catch (error) {
						this.failResult(jobId, error);
						return;
					}
					this.finish({ id: jobId, status: "completed" });
					this.options.logs.write("info", `Worker workflow completed: ${jobId}`);
					return;
				}
				this.fail(
					jobId,
					payload.execution_error?.exception_message ??
						`Worker workflow ${payload.status}.`,
				);
				return;
			} catch {
				invalidStatuses = 0;
				if (!this.isCurrentRuntime(runtimeUrl, runtimeGeneration)) {
					this.finishCanceledOrFailed(
						jobId,
						"Worker ComfyUI stopped before the workflow finished.",
					);
					return;
				}
			}
		}
	}

	private isCurrentRuntime(runtimeUrl: string, generation: number | string): boolean {
		return (
			this.options.getRuntimeUrl() === runtimeUrl &&
			(this.options.getRuntimeGeneration?.() ?? runtimeUrl) === generation
		);
	}

	private fail(jobId: string, error: unknown): void {
		const failure: WorkflowJobFailure = {
			code: "execution_failed",
			message: errorMessage(error),
		};
		this.finish({
			id: jobId,
			status: "failed",
			error: failure.message,
			failure,
		});
		this.options.logs.write(
			"error",
			`Worker workflow failed: ${jobId}. ${failure.message}`,
		);
	}

	private failResult(jobId: string, error: unknown): void {
		const failure: WorkflowJobFailure = {
			code: "result_failed",
			message: `Worker result preparation failed: ${errorMessage(error)}`,
		};
		this.finish({
			id: jobId,
			status: "failed",
			error: failure.message,
			failure,
		});
		this.options.logs.write(
			"error",
			`Worker workflow failed: ${jobId}. ${failure.message}`,
		);
	}

	private finishCanceled(jobId: string): WorkflowJobState {
		const canceled = { id: jobId, status: "canceled" as const };
		this.finish(canceled);
		this.options.logs.write("info", `Worker workflow canceled: ${jobId}`);
		return canceled;
	}

	private finishCanceledOrFailed(jobId: string, error: unknown): void {
		if (this.jobs.get(jobId)?.status === "canceling") {
			this.finishCanceled(jobId);
		} else if (this.jobs.get(jobId)?.status === "running") {
			this.fail(jobId, error);
		}
	}

	private finish(state: TerminalWorkflowJobState): void {
		if (this.activeJobId === state.id) {
			this.activeJobId = null;
			this.activeComfyPromptId = null;
		}
		this.jobs.set(state.id, state);
		if (this.jobs.size <= TERMINAL_JOB_LIMIT) return;
		for (const [jobId, job] of this.jobs) {
			if (job.status === "running" || job.status === "canceling") continue;
			const result = this.results.get(jobId);
			this.jobs.delete(jobId);
			this.requestFingerprints.delete(jobId);
			this.results.delete(jobId);
			this.events.delete(jobId);
			if (result?.directory !== null && result?.directory !== undefined) {
				void rm(result.directory, { recursive: true, force: true }).catch(
					() => undefined,
				);
			}
			break;
		}
	}

	private async request(url: URL, init?: RequestInit): Promise<Response> {
		try {
			return await this.requestFetch(url, init);
		} catch {
			throw new WorkflowJobError("Worker ComfyUI could not be reached.", 502);
		}
	}

	private async lock<Result>(operation: () => Promise<Result>): Promise<Result> {
		const previous = this.operation;
		let release = (): void => undefined;
		this.operation = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

function workflowRequest(
	jobId: string,
	value: unknown,
): {
	prompt: unknown;
	inputs: WorkflowInputManifestEntry[];
	extraData: unknown;
	fingerprint: string;
} {
	const parsed = parseWorkflowJobRequest(jobId, value);
	if (!parsed.ok) {
		throw new WorkflowJobError(
			parsed.issue === "inputs"
				? "Invalid workflow inputs."
				: "Invalid workflow job request.",
			400,
		);
	}
	const { prompt, inputs, extra_data: extraData } = parsed.value;
	return {
		prompt,
		inputs,
		extraData,
		fingerprint: createHash("sha256")
			.update(stableJson({ prompt, inputs, extraData }))
			.digest("hex"),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === "string"
			? error
			: "Worker workflow failed.";
}

function isInternalJob(value: unknown): value is InternalJob {
	return (
		isRecord(value) &&
		(value.status === "pending" ||
			value.status === "in_progress" ||
			value.status === "completed" ||
			value.status === "failed" ||
			value.status === "cancelled")
	);
}

function comfyError(value: unknown): string {
	if (
		isRecord(value) &&
		isRecord(value.error) &&
		typeof value.error.message === "string"
	) {
		return value.error.message;
	}
	return "Worker ComfyUI rejected the workflow.";
}

function comfyPromptError(value: unknown): string {
	const message = comfyError(value);
	if (isRecord(value) && isRecord(value.node_errors)) {
		const details = Object.entries(value.node_errors).flatMap(([nodeId, entry]) => {
			if (!isRecord(entry) || !Array.isArray(entry.errors)) return [];
			return entry.errors.flatMap((error) => {
				if (!isRecord(error)) return [];
				const extra = isRecord(error.extra_info) ? error.extra_info : null;
				const inputName =
					extra !== null && typeof extra.input_name === "string"
						? extra.input_name
						: undefined;
				const classType =
					typeof entry.class_type === "string"
						? entry.class_type
						: "Worker ComfyUI node";
				const detail =
					typeof error.details === "string"
						? error.details
						: typeof error.message === "string"
							? error.message
							: null;
				const name = inputName === undefined ? classType : `${classType}.${inputName}`;
				return [`${name} at ${nodeId}${detail === null ? "" : `: ${detail}`}`];
			});
		});
		if (details.length > 0) return [message, ...details].join("\n");
	}
	return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function workflowInputJobError(error: WorkflowInputStoreError): WorkflowJobError {
	const reason = error.failure.problems[0]?.reason;
	return new WorkflowJobError(
		error.failure.message,
		reason === "too-large"
			? 413
			: reason === "checksum-mismatch"
				? 422
				: reason === "transfer-failed"
					? 502
					: 400,
		reason === "transfer-failed",
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

type WorkflowEventSocket = { close: () => void };

async function openComfyEventSocket(options: {
	runtimeUrl: string;
	jobId: string;
	comfyPromptId: string;
	events: WorkflowEventHub;
}): Promise<WorkflowEventSocket> {
	const url = new URL("ws", options.runtimeUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("clientId", options.comfyPromptId);
	return await new Promise((resolveConnection, rejectConnection) => {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		let opened = false;
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.close();
			rejectConnection(new Error("Worker ComfyUI event stream timed out."));
		}, 10_000);
		socket.addEventListener("open", () => {
			opened = true;
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				resolveConnection({ close: () => socket.close() });
			}
			socket.send(
				JSON.stringify({
					type: "feature_flags",
					data: { supports_preview_metadata: true },
				}),
			);
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data === "string") {
				try {
					options.events.publishJson(
						options.jobId,
						options.comfyPromptId,
						JSON.parse(event.data),
					);
				} catch {
					return;
				}
				return;
			}
			if (event.data instanceof ArrayBuffer) {
				options.events.publishBinary(options.jobId, options.comfyPromptId, event.data);
			}
		});
		const rejectBeforeOpen = (): void => {
			if (opened || settled) return;
			settled = true;
			clearTimeout(timeout);
			rejectConnection(new Error("Worker ComfyUI event stream could not be opened."));
		};
		socket.addEventListener("error", rejectBeforeOpen);
		socket.addEventListener("close", rejectBeforeOpen);
	});
}

async function createWorkflowResults(
	jobId: string,
	outputs: unknown,
	rootDirectory: string | null,
): Promise<{
	manifest: WorkflowResultManifest;
	files: Map<string, WorkflowResultDownload>;
	directory: string | null;
}> {
	const references = new Map<string, WorkflowResultReference>();
	const normalizedOutputs = collectResultReferences(
		normalizeResultOutputs(outputs),
		references,
	);
	if (references.size > 0 && rootDirectory === null) {
		throw new Error("Worker ComfyUI root is unavailable.");
	}
	if (references.size === 0) {
		return {
			manifest: { id: jobId, outputs: normalizedOutputs, files: [] },
			files: new Map(),
			directory: null,
		};
	}
	const root = workflowResultRoot(rootDirectory as string);
	const snapshotId = randomUUID();
	const directory = join(root, `${jobId}-${snapshotId}`);
	const staging = join(root, `.${jobId}-${snapshotId}.staging`);
	const files = new Map<string, WorkflowResultDownload>();
	try {
		await mkdir(staging, { recursive: true });
		for (const reference of references.values()) {
			const source = await resolveResultPath(rootDirectory as string, reference);
			const destination = join(staging, reference.id, reference.filename);
			await mkdir(dirname(destination), { recursive: true });
			await copyFile(source, destination);
			const metadata = await stat(destination);
			if (!metadata.isFile()) throw new Error("Worker result is not a file.");
			const file: WorkflowResultDownload = {
				...reference,
				path: join(directory, reference.id, reference.filename),
				size: metadata.size,
				sha256: await sha256File(destination),
				contentType: resultContentType(reference.filename),
			};
			files.set(file.id, file);
		}
		await rename(staging, directory);
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return {
		manifest: {
			id: jobId,
			outputs: normalizedOutputs,
			files: [...files.values()].map(({ path: _, ...file }) => file),
		},
		files,
		directory,
	};
}

function workflowResultRoot(rootDirectory: string): string {
	return join(rootDirectory, ".kastard", "workflow-results");
}

type WorkflowResultReference = Pick<
	WorkflowResultFile,
	"id" | "filename" | "subfolder" | "type"
>;

function normalizeResultOutputs(outputs: unknown): unknown {
	if (!isRecord(outputs)) return outputs;
	return Object.fromEntries(
		Object.entries(outputs).map(([nodeId, nodeOutputs]) => [
			nodeId,
			isRecord(nodeOutputs)
				? Object.fromEntries(
						Object.entries(nodeOutputs).map(([mediaType, items]) => [
							mediaType,
							Array.isArray(items)
								? items.map((item) => normalizeResultItem(mediaType, item))
								: items,
						]),
					)
				: nodeOutputs,
		]),
	);
}

function normalizeResultItem(mediaType: string, value: unknown): unknown {
	if (
		(mediaType !== "3d" && mediaType !== "result") ||
		typeof value !== "string" ||
		!STANDALONE_THREE_D_RESULT_EXTENSIONS.some((extension) =>
			value.toLowerCase().endsWith(extension),
		)
	) {
		return value;
	}
	return { filename: value, subfolder: "", type: "output", mediaType: "3d" };
}

function collectResultReferences(
	value: unknown,
	references: Map<string, WorkflowResultReference>,
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => collectResultReferences(entry, references));
	}
	if (!isRecord(value)) return value;
	const reference = workflowResultReference(value);
	const entries = Object.entries(value).map(([key, entry]) => [
		key,
		collectResultReferences(entry, references),
	]);
	if (reference === null) return Object.fromEntries(entries);
	references.set(reference.id, reference);
	return Object.fromEntries([...entries, ["kastard_file_id", reference.id]]);
}

function workflowResultReference(
	value: Record<string, unknown>,
): WorkflowResultReference | null {
	if (
		typeof value.filename !== "string" ||
		typeof value.subfolder !== "string" ||
		(value.type !== "input" && value.type !== "output" && value.type !== "temp")
	) {
		return null;
	}
	if (
		value.filename.length === 0 ||
		basename(value.filename) !== value.filename ||
		value.subfolder.includes("\\")
	) {
		throw new Error("Worker result path is invalid.");
	}
	const normalizedSubfolder = value.subfolder.replace(/^\/+|\/+$/g, "");
	if (
		normalizedSubfolder
			.split("/")
			.some((segment) => segment === ".." || segment === ".")
	) {
		throw new Error("Worker result path is invalid.");
	}
	const id = createHash("sha256")
		.update(`${value.type}\0${normalizedSubfolder}\0${value.filename}`)
		.digest("hex");
	return {
		id,
		filename: value.filename,
		subfolder: normalizedSubfolder,
		type: value.type,
	};
}

async function resolveResultPath(
	rootDirectory: string,
	reference: WorkflowResultReference,
): Promise<string> {
	const base = await realpath(resolve(rootDirectory, reference.type));
	const path = await realpath(resolve(base, reference.subfolder, reference.filename));
	if (path !== base && !path.startsWith(`${base}${sep}`)) {
		throw new Error("Worker result path escapes its output directory.");
	}
	return path;
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function resultContentType(filename: string): string {
	switch (filename.split(".").at(-1)?.toLowerCase()) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "mp4":
			return "video/mp4";
		case "webm":
			return "video/webm";
		case "wav":
			return "audio/wav";
		case "mp3":
			return "audio/mpeg";
		case "json":
			return "application/json";
		case "txt":
			return "text/plain; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}
