import type {
	StoredWorkflowJob,
	WorkerWorkflowEvent,
	WorkerWorkflowLiveMessage,
	WorkerWorkflowQueue,
} from "./worker-port";

const PREVIEWABLE_MEDIA_TYPES = new Set(["images", "video", "audio", "3d", "text"]);
const THREE_D_EXTENSIONS = [".obj", ".fbx", ".gltf", ".glb", ".usdz"] as const;
const STANDALONE_THREE_D_EXTENSIONS = [".glb", ".usdz"] as const;
const TEXT_EXTENSIONS = [".txt", ".md", ".json"] as const;
const TEXT_PREVIEW_MAX_LENGTH = 1_024;

export function comfyQueueStatus(
	queue: WorkerWorkflowQueue,
): WorkerWorkflowLiveMessage {
	return {
		type: "status",
		data: {
			status: { exec_info: { queue_remaining: queueSize(queue) } },
		},
	};
}

export function comfyTerminalMessage(
	event: WorkerWorkflowEvent,
): WorkerWorkflowLiveMessage {
	if (event.status === "completed") {
		return {
			type: "execution_success",
			data: { prompt_id: event.id },
		};
	}
	if (event.status === "canceled") {
		return {
			type: "execution_interrupted",
			data: {
				prompt_id: event.id,
				node_id: null,
				node_type: null,
				executed: [],
			},
		};
	}
	return {
		type: "execution_error",
		data: {
			prompt_id: event.id,
			node_id: "",
			node_type: "KastardWorkerWorkflow",
			executed: [],
			exception_message: workflowFailureMessage(event.error),
			exception_type:
				event.error.code === "preflight_failed"
					? "KastardWorkerPreflightError"
					: event.error.code === "input_failed"
						? "KastardWorkerInputError"
						: event.error.code === "connection_lost"
							? "KastardWorkerConnectionError"
							: event.error.code === "result_failed"
								? "KastardResultCollectionError"
								: "KastardWorkerExecutionError",
			traceback: [],
		},
	};
}

function workflowFailureMessage(
	failure: Extract<WorkerWorkflowEvent, { status: "failed" }>["error"],
): string {
	if (!("problems" in failure)) return failure.message;
	if (failure.code === "input_failed") {
		return [
			failure.message,
			...failure.problems.map((entry) => {
				const location = [entry.nodeId, entry.inputName].filter(Boolean).join("/");
				return [
					`[input/${entry.reason}] ${entry.name}`,
					location.length === 0 ? null : `at ${location}`,
				]
					.filter(Boolean)
					.join(" ");
			}),
		].join("\n");
	}
	return [
		failure.message,
		...failure.problems.map((entry) => {
			const location = [entry.nodeId, entry.inputName].filter(Boolean).join("/");
			const values = [
				entry.expected === null ? null : `expected: ${entry.expected}`,
				entry.actual === null ? null : `actual: ${entry.actual}`,
			]
				.filter(Boolean)
				.join(", ");
			return [
				`[${entry.kind}/${entry.reason}] ${entry.name}`,
				location.length === 0 ? null : `at ${location}`,
				values.length === 0 ? null : `(${values})`,
			]
				.filter(Boolean)
				.join(" ");
		}),
	].join("\n");
}

export function comfyQueue(queue: WorkerWorkflowQueue): {
	queue_running: unknown[];
	queue_pending: unknown[];
} {
	return {
		queue_running: queue.running.map(comfyQueueItem),
		queue_pending: queue.pending.map(comfyQueueItem),
	};
}

function comfyQueueItem(item: WorkerWorkflowQueue["pending"][number]): unknown[] {
	return [
		item.number,
		item.id,
		item.prompt,
		{
			...(item.clientId === null ? {} : { client_id: item.clientId }),
			create_time: item.createdAt,
		},
		[],
	];
}

export function isActiveJobsRequest(url: URL): boolean {
	const statuses = url.searchParams.get("status")?.split(",") ?? [];
	return (
		statuses.length > 0 &&
		statuses.every((status) => status === "in_progress" || status === "pending")
	);
}

export function comfyJobs(
	queue: WorkerWorkflowQueue,
	url: URL,
	history: StoredWorkflowJob[],
	upstream: unknown = null,
): unknown {
	const requested = url.searchParams.get("status")?.split(",") ?? null;
	const statuses = requested === null ? null : new Set(requested);
	const kastardJobs = [
		...(statuses === null || statuses.has("in_progress")
			? queue.running.map((item) => comfyActiveJob(item, "in_progress"))
			: []),
		...(statuses === null || statuses.has("pending")
			? queue.pending.map((item) => comfyActiveJob(item, "pending"))
			: []),
		...history
			.filter(
				(job) => statuses === null || statuses.has(comfyStoredJobStatus(job.status)),
			)
			.map((job) => comfyStoredJob(job, false)),
	];
	const jobsById = new Map<string, Record<string, unknown>>();
	if (isRecord(upstream) && Array.isArray(upstream.jobs)) {
		for (const job of upstream.jobs) {
			if (
				isRecord(job) &&
				typeof job.id === "string" &&
				(statuses === null ||
					(typeof job.status === "string" && statuses.has(job.status)))
			) {
				jobsById.set(job.id, job);
			}
		}
	}
	for (const job of kastardJobs) jobsById.set(job.id, job);
	const jobs = [...jobsById.values()].sort(
		(left, right) => jobCreateTime(right) - jobCreateTime(left),
	);
	const offset = nonNegativeInteger(url.searchParams.get("offset"), 0);
	const limit = nonNegativeInteger(url.searchParams.get("limit"), 200);
	const page = jobs.slice(offset, offset + limit);
	return {
		jobs: page,
		pagination: {
			offset,
			limit,
			total: jobs.length,
			has_more: offset + page.length < jobs.length,
		},
	};
}

function jobCreateTime(job: Record<string, unknown>): number {
	return typeof job.create_time === "number" ? job.create_time : 0;
}

export function comfyStoredJob(job: StoredWorkflowJob, includeOutputs: boolean) {
	const outputSummary = summarizeOutputs(
		job.outputs,
		new Map(job.files.map((file) => [file.id, file.type])),
	);
	const summary = {
		id: job.id,
		status: comfyStoredJobStatus(job.status),
		priority: job.number,
		create_time: job.createdAt,
		execution_start_time: job.createdAt,
		execution_end_time: job.completedAt,
		outputs_count: outputSummary.outputsCount,
		previewable_outputs_count: outputSummary.previewableOutputsCount,
		...(outputSummary.previewOutput === null
			? {}
			: { preview_output: outputSummary.previewOutput }),
	};
	return includeOutputs
		? {
				...summary,
				outputs: job.outputs,
				execution_status: {
					status_str: job.status === "completed" ? "success" : "error",
					completed: true,
					messages: [],
				},
				workflow: {
					prompt: job.prompt,
					extra_data: { ...job.extraData, create_time: job.createdAt },
				},
				...(job.error === undefined
					? {}
					: {
							execution_error: {
								exception_message: workflowFailureMessage(job.error),
							},
						}),
			}
		: summary;
}

function comfyStoredJobStatus(
	status: StoredWorkflowJob["status"],
): "completed" | "failed" | "cancelled" {
	return status === "canceled" ? "cancelled" : status;
}

function summarizeOutputs(
	outputs: unknown,
	fileTypes: ReadonlyMap<string, string>,
): {
	outputsCount: number;
	previewableOutputsCount: number;
	previewOutput: Record<string, unknown> | null;
} {
	if (!isRecord(outputs)) {
		return { outputsCount: 0, previewableOutputsCount: 0, previewOutput: null };
	}
	let outputsCount = 0;
	let previewableOutputsCount = 0;
	let savedVisual: Record<string, unknown> | null = null;
	let visualFallback: Record<string, unknown> | null = null;
	let textFileFallback: Record<string, unknown> | null = null;
	let textFallback: Record<string, unknown> | null = null;
	for (const [nodeId, nodeOutputs] of Object.entries(outputs)) {
		if (!isRecord(nodeOutputs)) continue;
		for (const [mediaType, items] of Object.entries(nodeOutputs)) {
			if (mediaType === "animated" || !Array.isArray(items)) continue;
			for (const value of items) {
				if (!isRecord(value)) {
					if (mediaType === "text" && textFallback === null) {
						const text = Array.isArray(value) ? value[0] : value;
						const content = String(text ?? "");
						textFallback = {
							content: content.slice(0, TEXT_PREVIEW_MAX_LENGTH),
							...(content.length > TEXT_PREVIEW_MAX_LENGTH ? { truncated: true } : {}),
							nodeId,
							mediaType,
						};
					}
					continue;
				}
				const item = value;
				outputsCount += 1;
				if (!isPreviewableOutput(mediaType, item)) continue;
				previewableOutputsCount += 1;
				const preview = {
					...item,
					nodeId,
					...(typeof item.mediaType === "string" ? {} : { mediaType }),
				};
				if (isTextOutput(mediaType, item)) textFileFallback ??= preview;
				else if (isSavedOutput(item, fileTypes)) savedVisual ??= preview;
				else visualFallback ??= preview;
			}
		}
	}
	return {
		outputsCount,
		previewableOutputsCount,
		previewOutput: savedVisual ?? visualFallback ?? textFileFallback ?? textFallback,
	};
}

function isSavedOutput(
	item: Record<string, unknown>,
	fileTypes: ReadonlyMap<string, string>,
): boolean {
	const originalType =
		typeof item.kastard_file_id === "string"
			? (fileTypes.get(item.kastard_file_id) ?? item.type)
			: item.type;
	return originalType === "output";
}

function isPreviewableOutput(
	mediaType: string,
	item: Record<string, unknown>,
): boolean {
	if (PREVIEWABLE_MEDIA_TYPES.has(mediaType)) return true;
	if (
		typeof item.format === "string" &&
		(item.format.startsWith("video/") || item.format.startsWith("audio/"))
	) {
		return true;
	}
	return (
		typeof item.filename === "string" &&
		(hasExtension(item.filename, THREE_D_EXTENSIONS) ||
			hasExtension(item.filename, TEXT_EXTENSIONS))
	);
}

function isTextOutput(mediaType: string, item: Record<string, unknown>): boolean {
	return (
		mediaType === "text" ||
		(typeof item.filename === "string" && hasExtension(item.filename, TEXT_EXTENSIONS))
	);
}

function hasExtension(value: string, extensions: readonly string[]): boolean {
	const normalized = value.toLowerCase();
	return extensions.some((extension) => normalized.endsWith(extension));
}

export function completedExecutedMessages(
	job: StoredWorkflowJob,
	deferred: WorkerWorkflowLiveMessage[],
): WorkerWorkflowLiveMessage[] {
	if (!isRecord(job.outputs)) return [];
	return Object.entries(job.outputs).flatMap(([nodeId, output]) => {
		if (!isRecord(output) || !hasFileReference(output)) return [];
		const template =
			deferred
				.map((message) => message.data)
				.find(
					(data): data is Record<string, unknown> =>
						isRecord(data) &&
						(nodeIdentifier(data.node) === nodeId ||
							nodeIdentifier(data.display_node) === nodeId),
				) ?? null;
		return [
			{
				type: "executed",
				data: {
					...template,
					prompt_id: job.id,
					node: template?.node ?? nodeId,
					display_node: template?.display_node ?? nodeId,
					output,
				},
			},
		];
	});
}

function nodeIdentifier(value: unknown): string | null {
	return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

export function shouldDeferExecutedMessage(
	message: WorkerWorkflowLiveMessage | undefined,
): message is WorkerWorkflowLiveMessage {
	return (
		message?.type === "executed" &&
		isRecord(message.data) &&
		(hasFileReference(message.data.output) ||
			hasUncollectedThreeDResult(message.data.output))
	);
}

function hasUncollectedThreeDResult(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return ["3d", "result"].some((mediaType) => {
		const items = value[mediaType];
		return (
			Array.isArray(items) &&
			items.some(
				(item) =>
					typeof item === "string" && hasExtension(item, STANDALONE_THREE_D_EXTENSIONS),
			)
		);
	});
}

function hasFileReference(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasFileReference);
	if (!isRecord(value)) return false;
	if (
		typeof value.filename === "string" &&
		typeof value.subfolder === "string" &&
		(value.type === "input" || value.type === "output" || value.type === "temp")
	) {
		return true;
	}
	return Object.values(value).some(hasFileReference);
}

export function comfyHistory(jobs: StoredWorkflowJob[]): Record<string, unknown> {
	return Object.fromEntries(
		jobs.map((job) => [
			job.id,
			{
				prompt: [
					job.number,
					job.id,
					job.prompt,
					{
						...job.extraData,
						...(job.clientId === null ? {} : { client_id: job.clientId }),
						create_time: job.createdAt,
					},
					[],
				],
				outputs: job.outputs,
				status: {
					status_str: job.status === "completed" ? "success" : "error",
					completed: true,
					messages: [],
				},
			},
		]),
	);
}

export function mergedComfyHistory(
	upstream: unknown,
	jobs: StoredWorkflowJob[],
	maxItemsValue: string | null,
): Record<string, unknown> {
	const entries = new Map<string, unknown>(
		isRecord(upstream) ? Object.entries(upstream) : [],
	);
	for (const [jobId, job] of Object.entries(comfyHistory(jobs)))
		entries.set(jobId, job);
	if (maxItemsValue === null) return Object.fromEntries(entries);
	const maxItems = nonNegativeInteger(maxItemsValue, entries.size);
	return Object.fromEntries(
		[...entries]
			.sort((left, right) => historyCreateTime(right[1]) - historyCreateTime(left[1]))
			.slice(0, maxItems),
	);
}

function historyCreateTime(value: unknown): number {
	if (!isRecord(value) || !Array.isArray(value.prompt)) return 0;
	const extraData = value.prompt[3];
	return isRecord(extraData) && typeof extraData.create_time === "number"
		? extraData.create_time
		: 0;
}

export function comfyActiveJob(
	item: WorkerWorkflowQueue["pending"][number],
	status: "in_progress" | "pending",
) {
	return {
		id: item.id,
		status,
		priority: item.number,
		create_time: item.createdAt,
	};
}

function nonNegativeInteger(value: string | null, fallback: number): number {
	if (value === null) return fallback;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function queueSize(queue: WorkerWorkflowQueue): number {
	return queue.running.length + queue.pending.length;
}

export function workflowExtraData(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			([key]) => key !== "auth_token_comfy_org" && key !== "api_key_comfy_org",
		),
	);
}

export function withComfyQueueStatus(
	message: string,
	queue: WorkerWorkflowQueue,
): string {
	try {
		const value: unknown = JSON.parse(message);
		if (!isRecord(value) || value.type !== "status" || !isRecord(value.data)) {
			return message;
		}
		const status = isRecord(value.data.status) ? value.data.status : {};
		const execInfo = isRecord(status.exec_info) ? status.exec_info : {};
		return JSON.stringify({
			...value,
			data: {
				...value.data,
				status: {
					...status,
					exec_info: {
						...execInfo,
						queue_remaining: queueSize(queue),
					},
				},
			},
		});
	} catch {
		return message;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
