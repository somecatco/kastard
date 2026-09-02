import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
	type BackendServerState,
	type BackendTarget,
	type CustomNodeInventoryEntry,
	type CustomNodeSyncRequest,
	type CustomNodeSyncServerState,
	type CustomNodeSyncTarget,
	isUnsupportedModelSyncContract,
	type ModelSyncRequest,
	type ModelSyncServerState,
	type ParsedWorkflowJobState,
	parseBackendServerState,
	parseCustomNodeSyncServerState,
	parseModelSyncState,
	parseServerLogSnapshot,
	parseSyncVerification,
	parseWorkerComfyServerState,
	parseWorkerConnectionResponse,
	parseWorkerConnectionStartResponse,
	parseWorkerErrorResponse,
	parseWorkerSystemStatus,
	parseWorkflowJobRejection,
	parseWorkflowJobState,
	type ServerLogEntry,
	type SyncVerification,
	type SyncVerificationRequest,
	type WorkerComfyMemoryCleanupRequest,
	type WorkerComfyServerState,
	type WorkerIdentity,
	type WorkerSystemStatus,
} from "@kastard/common";
import { connectWorkerTunnel, type WorkerTunnel } from "./tunnel";
import type {
	WorkflowInputFailure,
	WorkflowInputManifestEntry,
	WorkflowInputSnapshot,
} from "./workflow-input-snapshot";

export type { WorkflowJobFailure } from "@kastard/common";

export const CONNECTION_REQUEST_TIMEOUT_MS = 10_000;
const WORKER_COMFY_RESTART_REQUEST_TIMEOUT_MS = 20_000;
const WORKFLOW_INPUT_RETRY_DELAYS_MS = [250, 1_000] as const;
const UNREACHABLE_ERROR =
	"Could not reach the Worker. Check its address and connection.";
const UNSUPPORTED_MODEL_SYNC_CONTRACT_ERROR =
	"This Worker uses an unsupported model sync contract. Start a Worker version compatible with this version of Kastard, reconnect, and try again.";

export type ServerCredential = {
	serverUrl: string;
	sessionCapability: string;
	workerUrl?: string;
};

export type ConnectionAttemptResult =
	| { ok: true; logCursor: string; tunnel: WorkerTunnel; worker?: WorkerIdentity }
	| { ok: false; error: string };

export type ConnectionProbeResult =
	| { status: "connected"; worker?: WorkerIdentity }
	| { status: "offline"; error: string };

export type ServerLogsFetchResult =
	| {
			ok: true;
			logs: ServerLogEntry[];
			cursor: string;
			truncated: boolean;
	  }
	| { ok: false; error: string };

type WorkerRequestResult<State> =
	| { ok: true; state: State }
	| { ok: false; error: string; retryable?: boolean };

export type BackendRequestResult = WorkerRequestResult<BackendServerState>;
export type SyncRequestResult = WorkerRequestResult<CustomNodeSyncServerState>;
export type ModelSyncRequestResult = WorkerRequestResult<ModelSyncServerState>;
export type WorkerComfyRequestResult = WorkerRequestResult<WorkerComfyServerState>;
type SystemStatusRequestResult = WorkerRequestResult<WorkerSystemStatus>;
export type SyncVerificationRequestResult = WorkerRequestResult<SyncVerification>;

export type WorkflowJobState = ParsedWorkflowJobState;

type WorkflowJobStartResult =
	| { outcome: "accepted"; state: WorkflowJobState }
	| { outcome: "rejected"; error: string; retry: "state-change" | "never" }
	| { outcome: "failed"; error: WorkflowInputFailure }
	| { outcome: "unknown"; error: string };

type WorkflowJobReadResult = WorkerRequestResult<WorkflowJobState>;

type RequestFetch = typeof fetch;

export async function connectToServer(
	serverUrlInput: string,
	authenticationCode: string,
	signal?: AbortSignal,
	requestFetch: RequestFetch = fetch,
	openTunnel: typeof connectWorkerTunnel = connectWorkerTunnel,
): Promise<ConnectionAttemptResult> {
	let tunnel: WorkerTunnel;
	try {
		tunnel = await openTunnel(serverUrlInput, authenticationCode, signal);
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}

	let response: Response;
	try {
		response = await requestFetch(`${tunnel.endpointUrl}/connection`, {
			method: "POST",
			headers: connectionHeaders(tunnel),
			cache: "no-store",
			signal: requestSignal(CONNECTION_REQUEST_TIMEOUT_MS, signal),
		});
	} catch {
		await tunnel.close();
		return { ok: false, error: UNREACHABLE_ERROR };
	}

	const error = responseError(response);
	if (error !== null) {
		await tunnel.close();
		return { ok: false, error };
	}
	const payload: unknown = await response.json().catch(() => null);
	const connection = parseWorkerConnectionStartResponse(payload);
	if (connection === null) {
		await tunnel.close();
		return { ok: false, error: "The Worker returned an invalid connection status." };
	}
	return {
		ok: true,
		logCursor: connection.logCursor,
		tunnel,
		...(connection.worker === undefined ? {} : { worker: connection.worker }),
	};
}

export async function probeServerConnection(
	credential: ServerCredential,
	requestFetch: RequestFetch = fetch,
): Promise<ConnectionProbeResult> {
	let response: Response;
	try {
		response = await requestFetch(`${credential.serverUrl}/connection`, {
			headers: connectionHeaders(credential),
			cache: "no-store",
			signal: AbortSignal.timeout(CONNECTION_REQUEST_TIMEOUT_MS),
		});
	} catch {
		return {
			status: "offline",
			error: UNREACHABLE_ERROR,
		};
	}

	const error = responseError(response);
	if (error !== null) return { status: "offline", error };
	const payload: unknown = await response.json().catch(() => null);
	const connection = parseWorkerConnectionResponse(payload);
	return connection !== null
		? connection
		: {
				status: "offline",
				error: "The Worker returned an invalid connection status.",
			};
}

export async function fetchServerLogs(
	credential: ServerCredential,
	cursor: string,
	requestFetch: RequestFetch = fetch,
): Promise<ServerLogsFetchResult> {
	let response: Response;
	try {
		response = await requestFetch(
			`${credential.serverUrl}/logs?after=${encodeURIComponent(cursor)}`,
			{
				headers: connectionHeaders(credential),
				cache: "no-store",
				signal: AbortSignal.timeout(CONNECTION_REQUEST_TIMEOUT_MS),
			},
		);
	} catch {
		return {
			ok: false,
			error: "Could not load Worker logs. Check the Worker connection.",
		};
	}

	if (!response.ok) {
		return {
			ok: false,
			error: `Could not load Worker logs. The Worker returned HTTP ${response.status}.`,
		};
	}
	const payload: unknown = await response.json().catch(() => null);
	const snapshot = parseServerLogSnapshot(payload);
	return snapshot !== null
		? { ok: true, ...snapshot }
		: { ok: false, error: "The Worker returned invalid log data." };
}

export async function fetchWorkerBackend(
	credential: ServerCredential,
	requestFetch: RequestFetch = fetch,
): Promise<BackendRequestResult> {
	return requestWorkerState({
		credential,
		path: "/comfyui",
		requestFetch,
		parseState: parseBackendServerState,
		unreachableError: "Could not load the Worker ComfyUI backend status.",
		invalidError: "The Worker returned an invalid ComfyUI backend status.",
	});
}

export async function prepareWorkerBackend(
	credential: ServerCredential,
	target: BackendTarget,
	requestFetch: RequestFetch = fetch,
): Promise<BackendRequestResult> {
	return requestWorkerState({
		credential,
		path: "/comfyui/prepare",
		body: target,
		requestFetch,
		parseState: parseBackendServerState,
		unreachableError: "Could not load the Worker ComfyUI backend status.",
		invalidError: "The Worker returned an invalid ComfyUI backend status.",
	});
}

export async function fetchWorkerComfy(
	credential: ServerCredential,
	requestFetch: RequestFetch = fetch,
): Promise<WorkerComfyRequestResult> {
	return requestWorkerState({
		credential,
		path: "/comfyui/runtime",
		requestFetch,
		parseState: parseWorkerComfyServerState,
		unreachableError: "Could not load the Worker ComfyUI execution status.",
		invalidError: "The Worker returned an invalid ComfyUI execution status.",
	});
}

export async function fetchWorkerSystemMetrics(
	credential: ServerCredential,
	requestFetch: RequestFetch = fetch,
): Promise<SystemStatusRequestResult> {
	return requestWorkerState({
		credential,
		path: "/system/status",
		requestFetch,
		parseState: parseWorkerSystemStatus,
		unreachableError: "Could not load the Worker system status.",
		invalidError: "The Worker returned an invalid system status.",
	});
}

export async function startWorkerComfy(
	credential: ServerCredential,
	requestFetch: RequestFetch = fetch,
): Promise<WorkerComfyRequestResult> {
	return requestWorkerState({
		credential,
		path: "/comfyui/runtime",
		method: "POST",
		requestFetch,
		parseState: parseWorkerComfyServerState,
		unreachableError: "Could not start Worker ComfyUI.",
		invalidError: "The Worker returned an invalid ComfyUI execution status.",
	});
}

export async function restartWorkerComfy(
	credential: ServerCredential,
	requestFetch: RequestFetch = fetch,
): Promise<WorkerComfyRequestResult> {
	return requestWorkerState({
		credential,
		path: "/comfyui/runtime/restart",
		method: "POST",
		requestFetch,
		parseState: parseWorkerComfyServerState,
		unreachableError: "Could not restart Worker ComfyUI.",
		invalidError: "The Worker returned an invalid ComfyUI execution status.",
		timeoutMs: WORKER_COMFY_RESTART_REQUEST_TIMEOUT_MS,
	});
}

export async function freeWorkerComfyMemory(
	credential: ServerCredential,
	request: WorkerComfyMemoryCleanupRequest,
	requestFetch: RequestFetch = fetch,
): Promise<WorkerRequestResult<true>> {
	return requestWorkerState({
		credential,
		path: "/comfyui/runtime/free",
		method: "POST",
		body: request,
		requestFetch,
		parseState: (value) => (isRecord(value) ? true : null),
		unreachableError: "Could not reach the Worker for ComfyUI memory cleanup.",
		invalidError: "The Worker returned an invalid ComfyUI memory cleanup response.",
	});
}

export async function startWorkerWorkflowJob(
	credential: ServerCredential,
	jobId: string,
	snapshot: WorkflowInputSnapshot,
	extraData: Record<string, unknown>,
	requestFetch: RequestFetch = fetch,
	abortSignal?: AbortSignal,
): Promise<WorkflowJobStartResult> {
	for (const input of snapshot.inputs) {
		let uploaded: Awaited<ReturnType<typeof uploadWorkerWorkflowInput>>;
		let attempt = 0;
		do {
			uploaded = await uploadWorkerWorkflowInput(
				credential,
				jobId,
				input,
				requestFetch,
				abortSignal,
			);
			if (
				uploaded === null ||
				uploaded.outcome !== "rejected" ||
				uploaded.retry !== "state-change" ||
				attempt >= WORKFLOW_INPUT_RETRY_DELAYS_MS.length
			) {
				break;
			}
			await delay(WORKFLOW_INPUT_RETRY_DELAYS_MS[attempt] ?? 0, abortSignal);
			attempt += 1;
		} while (attempt <= WORKFLOW_INPUT_RETRY_DELAYS_MS.length);
		if (uploaded !== null) {
			if (uploaded.outcome === "failed") {
				await discardWorkerWorkflowInputs(credential, jobId, requestFetch).catch(
					() => undefined,
				);
			}
			return uploaded;
		}
	}
	let response: Response;
	try {
		response = await requestFetch(
			`${credential.serverUrl}/workflow-jobs/${encodeURIComponent(jobId)}`,
			{
				method: "PUT",
				body: JSON.stringify({
					prompt: snapshot.prompt,
					inputs: snapshot.inputs.map(inputManifest),
					extra_data: extraData,
				}),
				headers: {
					...connectionHeaders(credential),
					"Content-Type": "application/json",
				},
				cache: "no-store",
				signal: requestSignal(CONNECTION_REQUEST_TIMEOUT_MS, abortSignal),
			},
		);
	} catch {
		return {
			outcome: "unknown",
			error: "Could not submit the workflow to the Worker.",
		};
	}

	const payload: unknown = await response.json().catch(() => null);
	if (response.ok) {
		const state = parseWorkflowJobState(payload);
		return state !== null
			? { outcome: "accepted", state }
			: {
					outcome: "unknown",
					error: "The Worker returned an invalid workflow job.",
				};
	}
	const rejection = parseWorkflowJobRejection(payload);
	if (rejection !== null) {
		if (!rejection.retryable) {
			await discardWorkerWorkflowInputs(credential, jobId, requestFetch).catch(
				() => undefined,
			);
		}
		return {
			outcome: "rejected",
			error: rejection.error,
			retry: rejection.retryable ? "state-change" : "never",
		};
	}
	return {
		outcome: "unknown",
		error: `The Worker returned HTTP ${response.status}.`,
	};
}

export async function discardWorkerWorkflowInputs(
	credential: ServerCredential,
	jobId: string,
	requestFetch: RequestFetch = fetch,
): Promise<void> {
	const response = await requestFetch(
		`${credential.serverUrl}/workflow-jobs/${encodeURIComponent(jobId)}/inputs`,
		{
			method: "DELETE",
			headers: connectionHeaders(credential),
			cache: "no-store",
			signal: AbortSignal.timeout(CONNECTION_REQUEST_TIMEOUT_MS),
		},
	);
	if (!response.ok) {
		throw new Error(`The Worker returned HTTP ${response.status}.`);
	}
}

export async function fetchWorkerWorkflowJob(
	credential: ServerCredential,
	jobId: string,
	requestFetch: RequestFetch = fetch,
	signal?: AbortSignal,
): Promise<WorkflowJobReadResult> {
	return requestWorkerState({
		credential,
		path: `/workflow-jobs/${encodeURIComponent(jobId)}`,
		requestFetch,
		parseState: parseWorkflowJobState,
		unreachableError: "Could not load the Worker workflow status.",
		invalidError: "The Worker returned an invalid workflow status.",
		...(signal === undefined ? {} : { signal }),
	});
}

export async function cancelWorkerWorkflowJob(
	credential: ServerCredential,
	jobId: string,
	requestFetch: RequestFetch = fetch,
): Promise<WorkflowJobReadResult> {
	return requestWorkerState({
		credential,
		path: `/workflow-jobs/${encodeURIComponent(jobId)}`,
		method: "DELETE",
		requestFetch,
		parseState: parseWorkflowJobState,
		unreachableError: "Could not cancel the Worker workflow.",
		invalidError: "The Worker returned an invalid workflow cancellation status.",
	});
}

export async function fetchWorkerCustomNodeSync(
	credential: ServerCredential,
	requestFetch: RequestFetch = fetch,
): Promise<SyncRequestResult> {
	return requestWorkerState({
		credential,
		path: "/sync",
		requestFetch,
		parseState: parseCustomNodeSyncServerState,
		unreachableError: "Could not load the Worker custom node sync status.",
		invalidError: "The Worker returned an invalid custom node sync status.",
	});
}

export async function startWorkerCustomNodeSync(
	credential: ServerCredential,
	managerVersion: string,
	nodes: CustomNodeSyncTarget[],
	requestFetch: RequestFetch = fetch,
): Promise<SyncRequestResult> {
	return requestWorkerState({
		credential,
		path: "/sync",
		body: { managerVersion, nodes },
		requestFetch,
		parseState: parseCustomNodeSyncServerState,
		unreachableError: "Could not load the Worker custom node sync status.",
		invalidError: "The Worker returned an invalid custom node sync status.",
	});
}

export async function startWorkerCustomNodeReinstall(
	credential: ServerCredential,
	managerVersion: string,
	node: CustomNodeSyncTarget,
	requestFetch: RequestFetch = fetch,
): Promise<SyncRequestResult> {
	return requestWorkerState({
		credential,
		path: "/sync/reinstall",
		body: { managerVersion, nodes: [node] },
		requestFetch,
		parseState: parseCustomNodeSyncServerState,
		unreachableError: "Could not reinstall the Worker custom node.",
		invalidError: "The Worker returned an invalid custom node reinstall status.",
	});
}

export async function startWorkerCustomNodeRemoval(
	credential: ServerCredential,
	target: CustomNodeSyncRequest,
	node: CustomNodeInventoryEntry,
	requestFetch: RequestFetch = fetch,
): Promise<SyncRequestResult> {
	return requestWorkerState({
		credential,
		path: "/sync/remove",
		body: { ...target, node },
		requestFetch,
		parseState: parseCustomNodeSyncServerState,
		unreachableError: "Could not remove the Worker custom node.",
		invalidError: "The Worker returned an invalid custom node removal status.",
	});
}

export async function cancelWorkerCustomNodeSync(
	credential: ServerCredential,
	operationId: string | null,
	requestFetch: RequestFetch = fetch,
): Promise<SyncRequestResult> {
	return requestWorkerState({
		credential,
		path: operationId === null ? "/sync" : `/sync/${encodeURIComponent(operationId)}`,
		method: "DELETE",
		requestFetch,
		parseState: parseCustomNodeSyncServerState,
		unreachableError: "Could not cancel Worker custom node synchronization.",
		invalidError: "The Worker returned an invalid custom node sync status.",
	});
}

export async function fetchWorkerModelSync(
	credential: ServerCredential,
	requestFetch: RequestFetch = fetch,
): Promise<ModelSyncRequestResult> {
	return requestWorkerState({
		credential,
		path: "/models/sync",
		requestFetch,
		parseState: parseModelSyncState,
		unreachableError: "Could not load the Worker model sync status.",
		invalidError: modelSyncInvalidError,
	});
}

export async function startWorkerModelSync(
	credential: ServerCredential,
	request: ModelSyncRequest,
	requestFetch: RequestFetch = fetch,
): Promise<ModelSyncRequestResult> {
	return requestWorkerState({
		credential,
		path: "/models/sync",
		body: request,
		requestFetch,
		parseState: parseModelSyncState,
		unreachableError: "Could not load the Worker model sync status.",
		invalidError: modelSyncInvalidError,
	});
}

export async function startWorkerModelRedownload(
	credential: ServerCredential,
	request: ModelSyncRequest,
	requestFetch: RequestFetch = fetch,
): Promise<ModelSyncRequestResult> {
	return requestWorkerState({
		credential,
		path: "/models/redownload",
		body: request,
		requestFetch,
		parseState: parseModelSyncState,
		unreachableError: "Could not redownload the Worker model.",
		invalidError: (value) =>
			modelSyncInvalidError(
				value,
				"The Worker returned an invalid model redownload status.",
			),
	});
}

export async function cancelWorkerModelSync(
	credential: ServerCredential,
	operationId: string | null,
	requestFetch: RequestFetch = fetch,
): Promise<ModelSyncRequestResult> {
	return requestWorkerState({
		credential,
		path:
			operationId === null
				? "/models/sync"
				: `/models/sync/${encodeURIComponent(operationId)}`,
		method: "DELETE",
		requestFetch,
		parseState: parseModelSyncState,
		unreachableError: "Could not cancel Worker model synchronization.",
		invalidError: modelSyncInvalidError,
	});
}

export async function verifyWorkerSynchronization(
	credential: ServerCredential,
	request: SyncVerificationRequest,
	requestFetch: RequestFetch = fetch,
): Promise<SyncVerificationRequestResult> {
	return requestWorkerState({
		credential,
		path: "/sync/verify",
		body: request,
		requestFetch,
		parseState: parseSyncVerification,
		unreachableError: "Could not verify the Worker synchronization status.",
		invalidError: "The Worker returned an invalid synchronization verification.",
	});
}

async function uploadWorkerWorkflowInput(
	credential: ServerCredential,
	jobId: string,
	input: WorkflowInputSnapshot["inputs"][number],
	requestFetch: RequestFetch,
	abortSignal?: AbortSignal,
): Promise<Extract<WorkflowJobStartResult, { outcome: "rejected" | "failed" }> | null> {
	let response: Response;
	try {
		const body = Readable.toWeb(createReadStream(input.path));
		response = await requestFetch(
			`${credential.serverUrl}/workflow-jobs/${encodeURIComponent(jobId)}/inputs/${input.id}`,
			{
				method: "PUT",
				body,
				duplex: "half",
				headers: {
					...connectionHeaders(credential),
					"Content-Length": String(input.size),
					"Content-Type": "application/octet-stream",
					"X-Kastard-Input-SHA256": input.sha256,
				},
				cache: "no-store",
				signal: requestSignal(15 * 60_000, abortSignal),
			} as RequestInit & { duplex: "half" },
		);
	} catch {
		return {
			outcome: "rejected",
			error: "Could not transfer workflow inputs to the Worker.",
			retry: "state-change",
		};
	}
	if (response.ok) return null;
	const payload: unknown = await response.json().catch(() => null);
	const message =
		isRecord(payload) && typeof payload.error === "string"
			? payload.error
			: `The Worker returned HTTP ${response.status} while transferring inputs.`;
	if (
		response.status === 408 ||
		response.status === 425 ||
		response.status === 429 ||
		response.status >= 500
	) {
		return { outcome: "rejected", error: message, retry: "state-change" };
	}
	return {
		outcome: "failed",
		error: {
			code: "input_failed",
			message: "Workflow input transfer failed.",
			problems: [
				{
					reason:
						response.status === 413
							? "too-large"
							: response.status === 422
								? "checksum-mismatch"
								: "transfer-failed",
					name: input.name,
				},
			],
		},
	};
}

function inputManifest(
	input: WorkflowInputSnapshot["inputs"][number],
): WorkflowInputManifestEntry {
	return {
		id: input.id,
		name: input.name,
		size: input.size,
		sha256: input.sha256,
		references: input.references,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectionHeaders(credential: {
	sessionCapability: string;
}): Record<string, string> {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${credential.sessionCapability}`,
	};
}

async function requestWorkerState<State>({
	credential,
	path,
	method,
	body,
	requestFetch,
	parseState,
	unreachableError,
	invalidError,
	signal,
	timeoutMs = CONNECTION_REQUEST_TIMEOUT_MS,
}: {
	credential: ServerCredential;
	path: string;
	method?: "GET" | "POST" | "DELETE";
	body?: unknown;
	requestFetch: RequestFetch;
	parseState: (value: unknown) => State | null;
	unreachableError: string;
	invalidError: string | ((value: unknown) => string);
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<WorkerRequestResult<State>> {
	let response: Response;
	try {
		response = await requestFetch(`${credential.serverUrl}${path}`, {
			method: method ?? (body === undefined ? "GET" : "POST"),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			headers: {
				...connectionHeaders(credential),
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			cache: "no-store",
			signal: requestSignal(timeoutMs, signal),
		});
	} catch {
		return { ok: false, error: unreachableError, retryable: true };
	}
	const payload: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const serverError = parseWorkerErrorResponse(payload);
		return {
			ok: false,
			error: serverError?.error ?? `The Worker returned HTTP ${response.status}.`,
			retryable: serverError?.retryable === true,
		};
	}
	const state = parseState(payload);
	return state !== null
		? { ok: true, state }
		: {
				ok: false,
				error: typeof invalidError === "string" ? invalidError : invalidError(payload),
				retryable: false,
			};
}

function modelSyncInvalidError(
	value: unknown,
	fallback = "The Worker returned an invalid model sync status.",
): string {
	return isUnsupportedModelSyncContract(value)
		? UNSUPPORTED_MODEL_SYNC_CONTRACT_ERROR
		: fallback;
}

function responseError(response: Response): string | null {
	return response.ok ? null : `The Worker returned HTTP ${response.status}.`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
