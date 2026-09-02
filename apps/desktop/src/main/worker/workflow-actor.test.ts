// @vitest-environment node

import { expect, test, vi } from "vitest";
import type { ConnectionState, WorkerComfyState } from "../../shared/api";
import type { ServerCredential } from "./client";
import {
	cancelCurrentWorkerWorkflow,
	clearPendingWorkerWorkflows,
	createWorkerWorkflowActor,
	deletePendingWorkerWorkflows,
	failWorkerWorkflowsForConnectionLoss,
	getWorkerWorkflowQueue,
	stopWorkerWorkflowActor,
	submitWorkerWorkflow,
	updateWorkerWorkflowReadiness,
	type WorkerWorkflowActorOptions,
	type WorkerWorkflowQueue,
} from "./workflow-actor";
import {
	type WorkflowInputSnapshot,
	WorkflowInputSnapshotError,
} from "./workflow-input-snapshot";

const credential: ServerCredential = {
	serverUrl: "https://kastard.example.com",
	sessionCapability: "test-session-capability",
};
const inputlessPrompt = {
	"1": { class_type: "KastardTestNode", inputs: {} },
};

test("submits one inputless workflow and reports the Worker's terminal state", async () => {
	vi.useFakeTimers();
	const terminal = vi.fn();
	const started = vi.fn();
	const queueChanged = vi.fn();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const read = vi.fn(async (_credential, id: string) => ({
		ok: true as const,
		state: { id, status: "completed" as const },
	}));
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			read,
			pollMs: 10,
			onQueueChanged: queueChanged,
			onStarted: started,
			onTerminal: terminal,
		},
	);

	const extraData = { extra_pnginfo: { workflow: { id: "workflow" } } };
	const result = await harness.submit(inputlessPrompt, "comfy-client", extraData);
	await flushMicrotasks();
	expect(start).toHaveBeenCalledOnce();
	expect(result.number).toBe(0);
	expect(start).toHaveBeenCalledWith(
		credential,
		result.id,
		{
			prompt: inputlessPrompt,
			inputs: [],
		},
		extraData,
		expect.anything(),
	);
	expect(started).toHaveBeenCalledWith(result.id, "comfy-client");
	expect(harness.getQueue()).toEqual({
		running: [
			{
				id: result.id,
				number: 0,
				createdAt: expect.any(Number),
				prompt: inputlessPrompt,
				clientId: "comfy-client",
			},
		],
		pending: [],
	});
	await vi.advanceTimersByTimeAsync(10);

	expect(read).toHaveBeenCalledWith(
		credential,
		result.id,
		undefined,
		expect.any(AbortSignal),
	);
	expect(terminal).toHaveBeenCalledWith({
		id: result.id,
		clientId: "comfy-client",
		status: "completed",
	});
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });
	expect(queueChanged).toHaveBeenLastCalledWith({ running: [], pending: [] });
	harness.stop();
	vi.useRealTimers();
});

test("preserves a Worker preflight failure and continues with the next queued workflow", async () => {
	vi.useFakeTimers();
	const terminal = vi.fn();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	let firstId = "";
	const failure = {
		code: "preflight_failed" as const,
		message: "Worker workflow preflight failed.",
		problems: [
			{
				kind: "node" as const,
				reason: "missing" as const,
				name: "MissingNode",
				expected: "Available on the Worker",
				actual: null,
				nodeId: "1",
			},
		],
	};
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			read: async (_credential, id) => ({
				ok: true,
				state:
					id === firstId
						? { id, status: "failed" as const, error: failure }
						: { id, status: "completed" as const },
			}),
			pollMs: 10,
			onTerminal: terminal,
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	firstId = first.id;
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	await vi.advanceTimersByTimeAsync(10);
	await flushMicrotasks();
	expect(terminal).toHaveBeenCalledWith({
		id: first.id,
		clientId: "first-client",
		status: "failed",
		error: failure,
	});
	expect(harness.getQueue().running[0]?.id).toBe(second.id);

	await vi.advanceTimersByTimeAsync(10);
	expect(terminal).toHaveBeenLastCalledWith({
		id: second.id,
		clientId: "second-client",
		status: "completed",
	});
	harness.stop();
	vi.useRealTimers();
});

test("rejects workflows until the Worker is ready", async () => {
	vi.useFakeTimers();
	const connection = new ConnectionHarness(null);
	const workerComfy = new StateHarness<WorkerComfyState>({ status: "disconnected" });
	const captureInputs = vi.fn(async () => ({ prompt: inputlessPrompt, inputs: [] }));
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const harness = new WorkerWorkflowHarness(connection, workerComfy, {
		captureInputs,
		start,
		read: async (_credential, id) => ({
			ok: true,
			state: { id, status: "completed" },
		}),
		pollMs: 10,
		onTerminal: vi.fn(),
	});

	await expect(harness.submit(inputlessPrompt, "first-client")).rejects.toMatchObject({
		message: "Worker is not ready.",
		statusCode: 503,
	});
	expect(start).not.toHaveBeenCalled();
	expect(captureInputs).not.toHaveBeenCalled();
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });

	connection.update(credential);
	expect(start).not.toHaveBeenCalled();
	workerComfy.update({ status: "ready" });
	await flushMicrotasks();
	expect(start).not.toHaveBeenCalled();

	const accepted = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	expect(accepted.number).toBe(0);
	expect(captureInputs).toHaveBeenCalledOnce();
	expect(start).toHaveBeenCalledOnce();
	expect(start.mock.calls[0]?.[1]).toBe(accepted.id);
	await vi.advanceTimersByTimeAsync(10);
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });

	harness.stop();
	vi.useRealTimers();
});

test("rejects submissions that exceed the pending prompt byte limit", async () => {
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			captureInputs: async () => new Promise<WorkflowInputSnapshot>(() => undefined),
			maxPendingPromptBytes: 100,
			onTerminal: vi.fn(),
		},
	);
	const prompt = {
		"1": { class_type: "KastardTestNode", inputs: { value: "x".repeat(30) } },
	};

	const first = await harness.submit(prompt, null);
	await expect(harness.submit(prompt, null)).rejects.toMatchObject({
		message: "Worker workflow queue is full.",
		statusCode: 409,
	});
	expect(harness.getQueue().pending.map(({ id }) => id)).toEqual([first.id]);

	harness.clearPending();
	await expect(harness.submit(prompt, null)).resolves.toMatchObject({ number: 1 });
	harness.stop();
});

test("keeps inputs local until the FIFO item is current and cleans terminal snapshots", async () => {
	vi.useFakeTimers();
	let resolveCapture:
		| ((snapshot: { prompt: Record<string, unknown>; inputs: [] }) => void)
		| undefined;
	const cleanupInputs = vi.fn(async () => undefined);
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			captureInputs: async () =>
				new Promise((resolve) => {
					resolveCapture = resolve;
				}),
			cleanupInputs,
			start,
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			pollMs: 10,
		},
	);

	const job = await harness.submit(inputlessPrompt, null);
	expect(harness.getQueue().pending[0]?.id).toBe(job.id);
	expect(start).not.toHaveBeenCalled();
	resolveCapture?.({ prompt: inputlessPrompt, inputs: [] });
	await flushMicrotasks();
	expect(start).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(10);
	expect(cleanupInputs).toHaveBeenCalledWith(job.id);

	harness.stop();
	vi.useRealTimers();
});

test("waits for an in-flight snapshot and cleans it when stopping", async () => {
	let resolveCapture:
		| ((snapshot: { prompt: Record<string, unknown>; inputs: [] }) => void)
		| undefined;
	const cleanupInputs = vi.fn(async (_jobId: string) => undefined);
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			captureInputs: async () =>
				new Promise((resolve) => {
					resolveCapture = resolve;
				}),
			cleanupInputs,
		},
	);
	const job = await harness.submit(inputlessPrompt, null);
	let stopped = false;
	const stopping = harness.stopAndCleanup().then(() => {
		stopped = true;
	});
	await flushMicrotasks();
	expect(stopped).toBe(false);

	resolveCapture?.({ prompt: inputlessPrompt, inputs: [] });
	await stopping;
	expect(cleanupInputs).toHaveBeenCalledOnce();
	expect(cleanupInputs).toHaveBeenCalledWith(job.id);
});

test("aborts a current dispatch and cleans its inputs when stopping", async () => {
	let aborted = false;
	const cleanupInputs = vi.fn(async (_jobId: string) => undefined);
	const discardInputs = vi.fn(
		async (_credential: ServerCredential, _jobId: string) => undefined,
	);
	const start = vi.fn(
		(
			_credential: ServerCredential,
			_id: string,
			_snapshot: WorkflowInputSnapshot,
			_extraData: Record<string, unknown>,
			signal?: AbortSignal,
		) =>
			new Promise<{
				outcome: "rejected";
				error: string;
				retry: "state-change";
			}>((resolve) => {
				signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve({
							outcome: "rejected",
							error: "Workflow dispatch canceled.",
							retry: "state-change",
						});
					},
					{ once: true },
				);
			}),
	);
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{ start, cleanupInputs, discardInputs },
	);
	const job = await harness.submit(inputlessPrompt, null);
	await flushMicrotasks();
	expect(harness.getQueue().running).toEqual([expect.objectContaining({ id: job.id })]);

	await harness.stopAndCleanup();
	expect(aborted).toBe(true);
	expect(cleanupInputs).toHaveBeenCalledWith(job.id);
	expect(discardInputs).toHaveBeenCalledWith(credential, job.id);
});

test("records snapshot failures on the workflow job and advances FIFO", async () => {
	vi.useFakeTimers();
	const terminal = vi.fn();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	let resolveFailureRecord: (() => void) | undefined;
	const recordFailure = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				resolveFailureRecord = resolve;
			}),
	);
	let captures = 0;
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			captureInputs: async (_jobId, prompt) => {
				captures += 1;
				if (captures === 1) {
					throw new WorkflowInputSnapshotError({
						code: "input_failed",
						message: "Workflow input file is missing.",
						problems: [{ reason: "missing", name: "missing.png" }],
					});
				}
				return { prompt, inputs: [] };
			},
			start,
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			pollMs: 10,
			recordFailure,
			onTerminal: terminal,
		},
	);

	const first = await harness.submit(inputlessPrompt, "first");
	const second = await harness.submit(inputlessPrompt, "second");
	await flushMicrotasks();
	expect(recordFailure).toHaveBeenCalledOnce();
	expect(terminal).not.toHaveBeenCalled();
	expect(start).not.toHaveBeenCalled();

	resolveFailureRecord?.();
	await flushMicrotasks();
	expect(terminal).toHaveBeenCalledWith({
		id: first.id,
		clientId: "first",
		status: "failed",
		error: {
			code: "input_failed",
			message: "Workflow input file is missing.",
			problems: [{ reason: "missing", name: "missing.png" }],
		},
	});
	expect(harness.getQueue().running[0]?.id).toBe(second.id);
	expect(start).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(10);

	harness.stop();
	vi.useRealTimers();
});

test("waits for a snapshot failure record while stopping", async () => {
	let resolveFailureRecord: (() => void) | undefined;
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			captureInputs: async () => {
				throw new WorkflowInputSnapshotError({
					code: "input_failed",
					message: "Workflow input file is missing.",
					problems: [{ reason: "missing", name: "missing.png" }],
				});
			},
			recordFailure: () =>
				new Promise<void>((resolve) => {
					resolveFailureRecord = resolve;
				}),
		},
	);

	await harness.submit(inputlessPrompt, null);
	await flushMicrotasks();
	let stopped = false;
	const stopping = harness.stopAndCleanup().then(() => {
		stopped = true;
	});
	await flushMicrotasks();
	expect(stopped).toBe(false);

	resolveFailureRecord?.();
	await stopping;
	expect(stopped).toBe(true);
});

test("reports a snapshot failure record error explicitly", async () => {
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			captureInputs: async () => {
				throw new WorkflowInputSnapshotError({
					code: "input_failed",
					message: "Workflow input file is missing.",
					problems: [{ reason: "missing", name: "missing.png" }],
				});
			},
			recordFailure: async () => {
				throw new Error("disk full");
			},
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	await flushMicrotasks();
	expect(terminal).toHaveBeenCalledWith({
		id: job.id,
		clientId: "comfy-client",
		status: "failed",
		error: {
			code: "result_failed",
			message:
				"Workflow input file is missing. Kastard could not record the workflow failure: disk full",
		},
	});
	harness.stop();
});

test("keeps tracking an accepted Worker job after Editor disconnects", async () => {
	vi.useFakeTimers();
	const connection = new ConnectionHarness(credential);
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		connection,
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "running" },
			}),
			read: async (usedCredential, id) => {
				expect(usedCredential).toBe(credential);
				return { ok: true, state: { id, status: "completed" } };
			},
			pollMs: 10,
			onTerminal: terminal,
		},
	);

	const result = await harness.submit(inputlessPrompt, null);
	await flushMicrotasks();
	expect(harness.getQueue().running).toHaveLength(1);
	connection.update(null);
	await vi.advanceTimersByTimeAsync(10);

	expect(terminal).toHaveBeenCalledWith({
		id: result.id,
		clientId: null,
		status: "completed",
	});
	harness.stop();
	vi.useRealTimers();
});

test("fails the current and pending workflows after confirmed connection loss", async () => {
	vi.useFakeTimers();
	const connection = new ConnectionHarness(credential);
	const closeEvents = vi.fn();
	const cleanupInputs = vi.fn(async (_jobId: string) => undefined);
	const recordFailure = vi.fn(async () => undefined);
	const terminal = vi.fn();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const harness = new WorkerWorkflowHarness(
		connection,
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			cleanupInputs,
			openEvents: async () => ({ close: closeEvents }),
			start,
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			recordFailure,
			pollMs: 10,
			onTerminal: terminal,
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();

	harness.loseConnection();
	await flushMicrotasks();
	harness.loseConnection();
	await flushMicrotasks();
	expect(closeEvents).toHaveBeenCalledOnce();
	const connectionLost = {
		code: "connection_lost",
		message: "The Worker connection was lost, so the workflow failed.",
	};
	expect(recordFailure.mock.calls).toEqual(
		expect.arrayContaining([
			[expect.objectContaining({ id: first.id }), connectionLost],
			[expect.objectContaining({ id: second.id }), connectionLost],
		]),
	);
	expect(recordFailure).toHaveBeenCalledTimes(2);
	expect(terminal.mock.calls.map(([event]) => event)).toEqual(
		expect.arrayContaining([
			{
				id: first.id,
				clientId: "first-client",
				status: "failed",
				error: connectionLost,
			},
			{
				id: second.id,
				clientId: "second-client",
				status: "failed",
				error: connectionLost,
			},
		]),
	);
	expect(terminal).toHaveBeenCalledTimes(2);
	expect(start).toHaveBeenCalledTimes(1);
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });
	expect(cleanupInputs.mock.calls.map(([jobId]) => jobId)).toEqual(
		expect.arrayContaining([first.id, second.id]),
	);
	expect(cleanupInputs).toHaveBeenCalledTimes(2);

	connection.update(credential);
	await flushMicrotasks();
	expect(start.mock.calls.map(([, id]) => id)).toEqual([first.id]);

	harness.stop();
	vi.useRealTimers();
});

test("fails a pending workflow whose input snapshot is still being captured", async () => {
	let resolveCapture: ((snapshot: WorkflowInputSnapshot) => void) | undefined;
	const cleanupInputs = vi.fn(async (_jobId: string) => undefined);
	const recordFailure = vi.fn(async () => undefined);
	const terminal = vi.fn();
	const start = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			captureInputs: async () =>
				new Promise((resolve) => {
					resolveCapture = resolve;
				}),
			cleanupInputs,
			recordFailure,
			start,
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	expect(harness.getQueue().pending).toEqual([expect.objectContaining({ id: job.id })]);

	harness.loseConnection();
	await flushMicrotasks();
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });
	expect(recordFailure).toHaveBeenCalledOnce();
	expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), {
		code: "connection_lost",
		message: "The Worker connection was lost, so the workflow failed.",
	});
	expect(terminal).toHaveBeenCalledOnce();
	expect(start).not.toHaveBeenCalled();

	resolveCapture?.({ prompt: inputlessPrompt, inputs: [] });
	await flushMicrotasks();
	expect(cleanupInputs).toHaveBeenCalledWith(job.id);
	expect(terminal).toHaveBeenCalledOnce();

	harness.stop();
});

test("aborts result collection when connection loss is confirmed", async () => {
	let collectionSignal: AbortSignal | undefined;
	const collect = vi.fn(
		(_credential, _context, signal: AbortSignal) =>
			new Promise<void>((_resolve, reject) => {
				collectionSignal = signal;
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	);
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "completed" },
			}),
			collect,
			recordFailure: async () => undefined,
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	await flushMicrotasks();
	expect(collect).toHaveBeenCalledOnce();

	harness.loseConnection();
	await flushMicrotasks();
	expect(collectionSignal?.aborted).toBe(true);
	await vi.waitFor(() =>
		expect(terminal).toHaveBeenCalledWith({
			id: job.id,
			clientId: "comfy-client",
			status: "failed",
			error: {
				code: "connection_lost",
				message: "The Worker connection was lost, so the workflow failed.",
			},
		}),
	);

	harness.stop();
});

test("preserves the connection loss failure when stopping during collection abort", async () => {
	let rejectCollection: ((error: Error) => void) | undefined;
	const collect = vi.fn(
		() =>
			new Promise<void>((_resolve, reject) => {
				rejectCollection = reject;
			}),
	);
	let resolveFailureRecord: (() => void) | undefined;
	const recordFailure = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				resolveFailureRecord = resolve;
			}),
	);
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "completed" },
			}),
			collect,
			recordFailure,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	await flushMicrotasks();
	harness.loseConnection();
	const stopping = harness.stopAndCleanup();
	rejectCollection?.(new Error("This operation was aborted"));
	await vi.waitFor(() => {
		expect(recordFailure).toHaveBeenCalledOnce();
		expect(recordFailure).toHaveBeenCalledWith(
			expect.objectContaining({ id: job.id }),
			{
				code: "connection_lost",
				message: "The Worker connection was lost, so the workflow failed.",
			},
		);
	});

	resolveFailureRecord?.();
	await stopping;
});

test("aborts an in-flight status read when connection loss is confirmed", async () => {
	vi.useFakeTimers();
	let statusSignal: AbortSignal | undefined;
	const read = vi.fn(
		(_credential, _id, _requestFetch, signal?: AbortSignal) =>
			new Promise<never>((_resolve, reject) => {
				statusSignal = signal;
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	);
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "running" },
			}),
			read,
			recordFailure: async () => undefined,
			pollMs: 10,
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	await flushMicrotasks();
	await vi.advanceTimersByTimeAsync(10);
	expect(read).toHaveBeenCalledOnce();

	harness.loseConnection();
	await flushMicrotasks();
	expect(statusSignal?.aborted).toBe(true);
	expect(terminal).toHaveBeenCalledWith(
		expect.objectContaining({ id: job.id, status: "failed" }),
	);

	harness.stop();
	vi.useRealTimers();
});

test("cancels the current workflow on its original Worker and continues the FIFO", async () => {
	const terminal = vi.fn();
	const recordCanceled = vi.fn(async () => undefined);
	const cancel = vi.fn(async (_credential, id: string) => ({
		ok: true as const,
		state: { id, status: "canceled" as const },
	}));
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			cancel,
			recordCanceled,
			onTerminal: terminal,
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	expect(harness.cancelCurrent()).toBe(first.id);
	await flushMicrotasks();

	expect(cancel).toHaveBeenCalledWith(credential, first.id);
	expect(recordCanceled).toHaveBeenCalledWith(
		expect.objectContaining({ id: first.id }),
	);
	expect(terminal).toHaveBeenCalledWith({
		id: first.id,
		clientId: "first-client",
		status: "canceled",
	});
	expect(start.mock.calls.map(([, id]) => id)).toEqual([first.id, second.id]);
	expect(harness.getQueue().running[0]?.id).toBe(second.id);
	harness.stop();
});

test("does not dispatch after cancellation wins while the event stream is opening", async () => {
	let resolveEvents: ((connection: { close: () => void }) => void) | undefined;
	const close = vi.fn();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			openEvents: () =>
				new Promise((resolve) => {
					resolveEvents = resolve;
				}),
			start,
			cancel: async (_credential, id) => ({
				ok: true,
				state: { id, status: "canceled" },
			}),
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	await flushMicrotasks();
	expect(harness.cancelCurrent()).toBe(job.id);
	await flushMicrotasks();
	expect(terminal).toHaveBeenCalledWith({
		id: job.id,
		clientId: "comfy-client",
		status: "canceled",
	});

	resolveEvents?.({ close });
	await flushMicrotasks();
	expect(close).toHaveBeenCalledOnce();
	expect(start).not.toHaveBeenCalled();
	harness.stop();
});

test("keeps a confirmed cancellation current when its History record fails", async () => {
	const terminal = vi.fn();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			cancel: async (_credential, id) => ({
				ok: true,
				state: { id, status: "canceled" },
			}),
			recordCanceled: async () => {
				throw new Error("History is unavailable.");
			},
			onTerminal: terminal,
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	harness.cancelCurrent();
	await flushMicrotasks();

	expect(terminal).not.toHaveBeenCalled();
	expect(harness.getQueue().running[0]?.id).toBe(first.id);
	expect(harness.getQueue().pending[0]?.id).toBe(second.id);
	expect(start).toHaveBeenCalledTimes(1);
	harness.stop();
});

test("cancels the current workflow on its original Worker while disconnected", async () => {
	const connection = new ConnectionHarness(credential);
	const cancel = vi.fn(async (_credential, id: string) => ({
		ok: true as const,
		state: { id, status: "canceled" as const },
	}));
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		connection,
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "running" },
			}),
			cancel,
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	await flushMicrotasks();
	connection.update(null);
	expect(harness.cancelCurrent()).toBe(job.id);
	await flushMicrotasks();

	expect(cancel).toHaveBeenCalledWith(credential, job.id);
	expect(terminal).toHaveBeenCalledWith({
		id: job.id,
		clientId: "comfy-client",
		status: "canceled",
	});
	harness.stop();
});

test("keeps an unconfirmed cancellation current and blocks the FIFO", async () => {
	const connection = new ConnectionHarness(credential);
	const cancel = vi.fn(async () => ({
		ok: false as const,
		error: "Could not cancel the Worker workflow.",
		retryable: true,
	}));
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const harness = new WorkerWorkflowHarness(
		connection,
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			cancel,
			read: async () => ({
				ok: false,
				error: "Worker workflow status could not be loaded.",
				retryable: true,
			}),
			onTerminal: vi.fn(),
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	harness.cancelCurrent();
	await flushMicrotasks();

	expect(cancel).toHaveBeenCalledWith(credential, first.id);
	expect(harness.getQueue().running[0]?.id).toBe(first.id);
	expect(harness.getQueue().pending[0]?.id).toBe(second.id);
	connection.update({
		serverUrl: "https://replacement.example.com",
		sessionCapability: "replacement-session-capability",
	});
	await flushMicrotasks();
	expect(start).toHaveBeenCalledTimes(1);
	harness.stop();
});

test("fails an unconfirmed cancellation when connection loss is confirmed", async () => {
	const cancel = vi.fn(async () => ({
		ok: false as const,
		error: "Could not cancel the Worker workflow.",
		retryable: true,
	}));
	const recordFailure = vi.fn(async () => undefined);
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "running" },
			}),
			cancel,
			read: async () => ({
				ok: false,
				error: "Worker workflow status could not be loaded.",
				retryable: true,
			}),
			recordFailure,
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	await flushMicrotasks();
	harness.cancelCurrent();
	await flushMicrotasks();
	expect(cancel).toHaveBeenCalledWith(credential, job.id);

	harness.loseConnection();
	await flushMicrotasks();
	expect(recordFailure).toHaveBeenCalledWith(
		expect.objectContaining({ id: job.id }),
		expect.objectContaining({ code: "connection_lost" }),
	);
	expect(terminal).toHaveBeenCalledWith(
		expect.objectContaining({
			id: job.id,
			status: "failed",
			error: expect.objectContaining({ code: "connection_lost" }),
		}),
	);

	harness.stop();
});

test("ignores an in-flight cancellation response after confirmed connection loss", async () => {
	type CancellationResult = Awaited<
		ReturnType<NonNullable<WorkerWorkflowActorOptions["cancel"]>>
	>;
	let resolveCancellation: ((result: CancellationResult) => void) | undefined;
	const cancel = vi.fn(
		() =>
			new Promise<CancellationResult>((resolve) => {
				resolveCancellation = resolve;
			}),
	);
	const recordFailure = vi.fn(async () => undefined);
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "running" },
			}),
			cancel,
			recordFailure,
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	await flushMicrotasks();
	harness.cancelCurrent();
	await flushMicrotasks();
	expect(cancel).toHaveBeenCalledWith(credential, job.id);

	harness.loseConnection();
	await flushMicrotasks();
	resolveCancellation?.({
		ok: false,
		error: "Could not cancel the Worker workflow.",
		retryable: true,
	});
	await flushMicrotasks();

	expect(recordFailure).toHaveBeenCalledOnce();
	expect(terminal).toHaveBeenCalledOnce();
	expect(terminal).toHaveBeenCalledWith(
		expect.objectContaining({
			id: job.id,
			status: "failed",
			error: expect.objectContaining({ code: "connection_lost" }),
		}),
	);
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });

	harness.stop();
});

test("keeps collecting a completed result when cancellation is unconfirmed", async () => {
	let resolveCollection: (() => void) | undefined;
	const collect = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				resolveCollection = resolve;
			}),
	);
	const terminal = vi.fn();
	const recordCanceled = vi.fn(async () => undefined);
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "completed" },
			}),
			cancel: async () => ({
				ok: false,
				error: "The cancellation response was lost.",
				retryable: true,
			}),
			collect,
			recordCanceled,
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, "comfy-client");
	await flushMicrotasks();
	expect(collect).toHaveBeenCalledOnce();
	expect(harness.cancelCurrent()).toBe(job.id);
	await flushMicrotasks();
	expect(harness.getQueue().running[0]?.id).toBe(job.id);

	resolveCollection?.();
	await flushMicrotasks();
	expect(terminal).toHaveBeenCalledWith({
		id: job.id,
		clientId: "comfy-client",
		status: "completed",
	});
	expect(recordCanceled).not.toHaveBeenCalled();
	harness.stop();
});

test("keeps an active workflow after repeated status failures until state changes", async () => {
	vi.useFakeTimers();
	const connection = new ConnectionHarness(credential);
	const terminal = vi.fn();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	let reads = 0;
	const harness = new WorkerWorkflowHarness(
		connection,
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			read: async (_credential, id) => {
				reads += 1;
				return reads <= 3
					? { ok: false as const, error: "Temporary failure.", retryable: true }
					: { ok: true as const, state: { id, status: "completed" as const } };
			},
			pollMs: 10,
			onTerminal: terminal,
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	await vi.advanceTimersByTimeAsync(30);
	expect(reads).toBe(3);
	expect(start).toHaveBeenCalledTimes(1);
	expect(harness.getQueue().running[0]?.id).toBe(first.id);
	expect(harness.getQueue().pending[0]?.id).toBe(second.id);
	expect(terminal).not.toHaveBeenCalled();

	await vi.advanceTimersByTimeAsync(100);
	expect(reads).toBe(3);
	connection.update(credential);
	await vi.advanceTimersByTimeAsync(0);
	expect(reads).toBe(4);
	expect(start).toHaveBeenCalledTimes(2);
	expect(start.mock.calls[1]?.[1]).toBe(second.id);
	await vi.advanceTimersByTimeAsync(10);

	expect(terminal.mock.calls.map(([event]) => event)).toEqual([
		{ id: first.id, clientId: "first-client", status: "completed" },
		{ id: second.id, clientId: "second-client", status: "completed" },
	]);
	harness.stop();
	vi.useRealTimers();
});

test("requeues a definitely rejected dispatch until connection state changes", async () => {
	vi.useFakeTimers();
	const connection = new ConnectionHarness(credential);
	const replacementCredential: ServerCredential = {
		serverUrl: "https://replacement.example.com",
		sessionCapability: "replacement-session-capability",
	};
	let starts = 0;
	const start = vi.fn(async (_usedCredential, id: string) => {
		starts += 1;
		if (starts === 1) {
			return {
				outcome: "rejected" as const,
				error: "The Worker is busy.",
				retry: "state-change" as const,
			};
		}
		return {
			outcome: "accepted" as const,
			state: { id, status: "running" as const },
		};
	});
	const harness = new WorkerWorkflowHarness(
		connection,
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			pollMs: 10,
			onTerminal: vi.fn(),
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	expect(start).toHaveBeenCalledTimes(1);
	expect(harness.getQueue().pending.map(({ id }) => id)).toEqual([first.id, second.id]);

	connection.update(replacementCredential);
	await flushMicrotasks();
	expect(start).toHaveBeenCalledTimes(1);

	connection.update(credential);
	await flushMicrotasks();
	expect(start).toHaveBeenCalledTimes(2);
	expect(start.mock.calls[1]?.[1]).toBe(first.id);
	await vi.advanceTimersByTimeAsync(10);
	await flushMicrotasks();
	expect(start).toHaveBeenCalledTimes(3);
	expect(start.mock.calls[2]?.[1]).toBe(second.id);
	await vi.advanceTimersByTimeAsync(10);
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });

	harness.stop();
	vi.useRealTimers();
});

test("discards remote staging when delete and clear remove retrying workflows", async () => {
	const cleanupInputs = vi.fn(async (_jobId: string) => undefined);
	const discardInputs = vi.fn(
		async (_credential: ServerCredential, _jobId: string) => undefined,
	);
	const start = vi.fn(async () => ({
		outcome: "rejected" as const,
		error: "The Worker is busy.",
		retry: "state-change" as const,
	}));
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			cleanupInputs,
			discardInputs,
			onTerminal: vi.fn(),
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	expect(start).toHaveBeenCalledTimes(1);

	harness.deletePending([first.id]);
	await flushMicrotasks();
	expect(discardInputs).toHaveBeenNthCalledWith(1, credential, first.id);
	expect(start).toHaveBeenCalledTimes(2);

	harness.clearPending();
	await flushMicrotasks();
	expect(discardInputs).toHaveBeenNthCalledWith(2, credential, second.id);
	expect(cleanupInputs.mock.calls.map(([jobId]) => jobId)).toEqual([
		first.id,
		second.id,
	]);
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });

	harness.stop();
});

test("retries failed remote staging cleanup when the original Worker reconnects", async () => {
	const connection = new ConnectionHarness(credential);
	let rejectCleanup: ((error: Error) => void) | undefined;
	const discardInputs = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectCleanup = reject;
				}),
		)
		.mockResolvedValueOnce(undefined);
	const harness = new WorkerWorkflowHarness(
		connection,
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async () => ({
				outcome: "rejected",
				error: "The Worker is busy.",
				retry: "state-change",
			}),
			discardInputs,
			onTerminal: vi.fn(),
		},
	);

	const job = await harness.submit(inputlessPrompt, null);
	await flushMicrotasks();
	harness.deletePending([job.id]);
	await flushMicrotasks();
	expect(discardInputs).toHaveBeenCalledOnce();

	connection.update({
		serverUrl: "https://replacement.example.com",
		sessionCapability: "replacement-session-capability",
	});
	await flushMicrotasks();
	expect(discardInputs).toHaveBeenCalledOnce();

	connection.update(null);
	connection.update(credential);
	await flushMicrotasks();
	expect(discardInputs).toHaveBeenCalledOnce();

	rejectCleanup?.(new Error("Worker unavailable."));
	await flushMicrotasks();
	expect(discardInputs).toHaveBeenCalledTimes(2);
	expect(discardInputs).toHaveBeenLastCalledWith(credential, job.id);

	await harness.stopAndCleanup();
});

test("retries failed remote staging cleanup while stopping", async () => {
	const discardInputs = vi
		.fn()
		.mockRejectedValueOnce(new Error("Worker unavailable."))
		.mockResolvedValueOnce(undefined);
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async () => ({
				outcome: "rejected",
				error: "The Worker is busy.",
				retry: "state-change",
			}),
			discardInputs,
			onTerminal: vi.fn(),
		},
	);

	const job = await harness.submit(inputlessPrompt, null);
	await flushMicrotasks();
	harness.deletePending([job.id]);
	await flushMicrotasks();
	expect(discardInputs).toHaveBeenCalledOnce();

	await harness.stopAndCleanup();
	expect(discardInputs).toHaveBeenCalledTimes(2);
	expect(discardInputs).toHaveBeenLastCalledWith(credential, job.id);
});

test("retains failed remote cleanup after an input transfer failure", async () => {
	const connection = new ConnectionHarness(credential);
	const discardInputs = vi
		.fn()
		.mockRejectedValueOnce(new Error("Worker unavailable."))
		.mockResolvedValueOnce(undefined);
	const terminal = vi.fn();
	const snapshot: WorkflowInputSnapshot = {
		prompt: inputlessPrompt,
		inputs: [
			{
				id: "a".repeat(64),
				name: "source.png",
				path: "/tmp/source.png",
				size: 1,
				sha256: "a".repeat(64),
				references: [],
			},
		],
	};
	const harness = new WorkerWorkflowHarness(
		connection,
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			captureInputs: async () => snapshot,
			start: async () => ({
				outcome: "failed",
				error: {
					code: "input_failed",
					message: "Could not transfer workflow inputs.",
					problems: [{ reason: "transfer-failed", name: "source.png" }],
				},
			}),
			discardInputs,
			onTerminal: terminal,
		},
	);

	const job = await harness.submit(inputlessPrompt, null);
	await flushMicrotasks();
	expect(terminal).toHaveBeenCalledWith(
		expect.objectContaining({ id: job.id, status: "failed" }),
	);
	expect(discardInputs).toHaveBeenCalledOnce();

	connection.update(null);
	connection.update(credential);
	await flushMicrotasks();
	expect(discardInputs).toHaveBeenCalledTimes(2);
	expect(discardInputs).toHaveBeenLastCalledWith(credential, job.id);

	await harness.stopAndCleanup();
});

test("reconciles an uncertain dispatch only by reading the same Worker job id", async () => {
	vi.useFakeTimers();
	const connection = new ConnectionHarness(credential);
	const replacementCredential: ServerCredential = {
		serverUrl: "https://replacement.example.com",
		sessionCapability: "replacement-session-capability",
	};
	let starts = 0;
	const start = vi.fn(async (_usedCredential, id: string) => {
		starts += 1;
		return starts === 1
			? { outcome: "unknown" as const, error: `Response lost for ${id}` }
			: {
					outcome: "accepted" as const,
					state: { id, status: "running" as const },
				};
	});
	let reads = 0;
	const read = vi.fn(async (usedCredential, id: string) => {
		reads += 1;
		expect(usedCredential).toBe(credential);
		return reads <= 3
			? { ok: false as const, error: "Worker unavailable.", retryable: false }
			: { ok: true as const, state: { id, status: "completed" as const } };
	});
	const harness = new WorkerWorkflowHarness(
		connection,
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			read,
			pollMs: 10,
			onTerminal: vi.fn(),
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	expect(start).toHaveBeenCalledTimes(1);
	expect(harness.getQueue().running[0]?.id).toBe(first.id);
	expect(harness.getQueue().pending[0]?.id).toBe(second.id);

	await vi.advanceTimersByTimeAsync(20);
	expect(read).toHaveBeenCalledTimes(3);
	expect(start).toHaveBeenCalledTimes(1);

	connection.update(replacementCredential);
	await vi.advanceTimersByTimeAsync(0);
	expect(read).toHaveBeenCalledTimes(4);
	expect(start).toHaveBeenCalledTimes(2);
	expect(start.mock.calls[1]?.[0]).toBe(replacementCredential);
	expect(start.mock.calls[1]?.[1]).toBe(second.id);

	harness.stop();
	vi.useRealTimers();
});

test("does not advance FIFO when the Worker returns a mismatched job id", async () => {
	vi.useFakeTimers();
	const start = vi.fn(async () => ({
		outcome: "accepted" as const,
		state: { id: "mismatched-job", status: "running" as const },
	}));
	const read = vi.fn(async () => ({
		ok: true as const,
		state: { id: "mismatched-job", status: "completed" as const },
	}));
	const terminal = vi.fn();
	const started = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			read,
			pollMs: 10,
			onStarted: started,
			onTerminal: terminal,
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	await vi.advanceTimersByTimeAsync(20);

	expect(start).toHaveBeenCalledTimes(1);
	expect(read).toHaveBeenCalledTimes(3);
	expect(harness.getQueue().running[0]?.id).toBe(first.id);
	expect(harness.getQueue().pending[0]?.id).toBe(second.id);
	expect(started).not.toHaveBeenCalled();
	expect(terminal).not.toHaveBeenCalled();

	harness.stop();
	vi.useRealTimers();
});

test("keeps a dispatching workflow current while delete and clear affect queued jobs", async () => {
	vi.useFakeTimers();
	let resolveStart:
		| ((value: {
				outcome: "accepted";
				state: { id: string; status: "running" };
		  }) => void)
		| undefined;
	const start = vi.fn(
		(_credential, _id: string) =>
			new Promise<{
				outcome: "accepted";
				state: { id: string; status: "running" };
			}>((resolve) => {
				resolveStart = resolve;
			}),
	);
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			pollMs: 10,
			onTerminal: vi.fn(),
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	expect(harness.getQueue().running[0]?.id).toBe(first.id);
	expect(harness.getQueue().pending[0]?.id).toBe(second.id);
	expect(() => harness.deletePending([first.id, second.id])).toThrowError(
		"The current Worker workflow cannot be deleted.",
	);
	expect(harness.getQueue().pending[0]?.id).toBe(second.id);

	harness.clearPending();
	expect(harness.getQueue().running[0]?.id).toBe(first.id);
	expect(harness.getQueue().pending).toEqual([]);
	resolveStart?.({
		outcome: "accepted",
		state: { id: first.id, status: "running" },
	});
	await flushMicrotasks();
	await vi.advanceTimersByTimeAsync(10);
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });

	harness.stop();
	vi.useRealTimers();
});

test("fails a rejected dispatch and continues with the next queued workflow", async () => {
	vi.useFakeTimers();
	const terminal = vi.fn();
	let starts = 0;
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => {
				starts += 1;
				return starts === 1
					? {
							outcome: "rejected" as const,
							error: "Worker preflight failed.",
							retry: "never" as const,
						}
					: {
							outcome: "accepted" as const,
							state: { id, status: "running" as const },
						};
			},
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			pollMs: 10,
			onTerminal: terminal,
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	expect(harness.getQueue().running[0]?.id).toBe(second.id);
	expect(terminal).toHaveBeenCalledWith({
		id: first.id,
		clientId: "first-client",
		status: "failed",
		error: {
			code: "execution_failed",
			message: "Worker preflight failed.",
		},
	});
	await vi.advanceTimersByTimeAsync(10);
	expect(terminal).toHaveBeenLastCalledWith({
		id: second.id,
		clientId: "second-client",
		status: "completed",
	});

	harness.stop();
	vi.useRealTimers();
});

test("keeps draining when queue observers throw", async () => {
	vi.useFakeTimers();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			pollMs: 10,
			onQueueChanged: () => {
				throw new Error("queue observer failed");
			},
			onStarted: () => {
				throw new Error("started observer failed");
			},
			onTerminal: () => {
				throw new Error("terminal observer failed");
			},
		},
	);

	await harness.submit(inputlessPrompt, null);
	await harness.submit(inputlessPrompt, null);
	await flushMicrotasks();
	await vi.advanceTimersByTimeAsync(20);

	expect(start).toHaveBeenCalledTimes(2);
	expect(harness.getQueue()).toEqual({ running: [], pending: [] });
	harness.stop();
	vi.useRealTimers();
});

test("opens live events before dispatch and blocks FIFO while collecting results", async () => {
	vi.useFakeTimers();
	const order: string[] = [];
	const closeEvents = vi.fn();
	let liveHandlers:
		| Parameters<NonNullable<WorkerWorkflowActorOptions["openEvents"]>>[2]
		| undefined;
	const openEvents = vi.fn(async (_credential, _jobId, handlers) => {
		order.push("events");
		liveHandlers = handlers;
		return { close: closeEvents };
	});
	const start = vi.fn(async (_credential, id: string) => {
		order.push("start");
		return {
			outcome: "accepted" as const,
			state: { id, status: "running" as const },
		};
	});
	const read = vi.fn(async (_credential, id: string) => ({
		ok: true as const,
		state: { id, status: "completed" as const },
	}));
	let resolveCollection: (() => void) | undefined;
	const collect = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				resolveCollection = resolve;
			}),
	);
	const onLive = vi.fn();
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{ openEvents, start, read, collect, pollMs: 10, onLive, onTerminal: terminal },
	);

	const first = await harness.submit(inputlessPrompt, "comfy-client", {
		extra_pnginfo: { workflow: {} },
	});
	const second = await harness.submit(inputlessPrompt, null);
	await flushMicrotasks();
	expect(order).toEqual(["events", "start"]);
	liveHandlers?.onMessage({
		type: "progress",
		data: { prompt_id: first.id, node: "1", value: 1, max: 2 },
	});
	liveHandlers?.onPreview(new Uint8Array([1, 2, 3]));
	expect(onLive).toHaveBeenNthCalledWith(1, {
		id: first.id,
		clientId: "comfy-client",
		message: {
			type: "progress",
			data: { prompt_id: first.id, node: "1", value: 1, max: 2 },
		},
	});
	expect(onLive).toHaveBeenNthCalledWith(2, {
		id: first.id,
		clientId: "comfy-client",
		preview: new Uint8Array([1, 2, 3]),
	});

	await vi.advanceTimersByTimeAsync(10);
	expect(collect).toHaveBeenCalledWith(
		credential,
		expect.objectContaining({
			id: first.id,
			extraData: { extra_pnginfo: { workflow: {} } },
		}),
		expect.any(AbortSignal),
	);
	expect(start).toHaveBeenCalledTimes(1);
	expect(harness.getQueue()).toEqual({
		running: [expect.objectContaining({ id: first.id })],
		pending: [expect.objectContaining({ id: second.id })],
	});

	resolveCollection?.();
	await flushMicrotasks();
	expect(terminal).toHaveBeenCalledWith({
		id: first.id,
		clientId: "comfy-client",
		status: "completed",
	});
	expect(closeEvents).toHaveBeenCalledOnce();
	expect(start).toHaveBeenCalledTimes(2);
	harness.stop();
	vi.useRealTimers();
});

test("waits for a failed result collection to be recorded while stopping", async () => {
	let collectionSignal: AbortSignal | undefined;
	let rejectCollection: ((error: Error) => void) | undefined;
	const collect = vi.fn(
		(_credential, _context, signal: AbortSignal) =>
			new Promise<void>((_resolve, reject) => {
				collectionSignal = signal;
				rejectCollection = reject;
			}),
	);
	let resolveFailureRecord: (() => void) | undefined;
	const recordFailure = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				resolveFailureRecord = resolve;
			}),
	);
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "completed" },
			}),
			collect,
			recordFailure,
		},
	);

	const job = await harness.submit(inputlessPrompt, null);
	await flushMicrotasks();
	expect(collect).toHaveBeenCalledOnce();
	let stopped = false;
	const stopping = harness.stopAndCleanup().then(() => {
		stopped = true;
	});
	await flushMicrotasks();
	expect(stopped).toBe(false);
	expect(collectionSignal?.aborted).toBe(false);

	rejectCollection?.(new Error("download failed"));
	await flushMicrotasks();
	expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), {
		code: "result_failed",
		message: "Kastard result collection failed: download failed",
	});
	expect(stopped).toBe(false);

	resolveFailureRecord?.();
	await stopping;
	expect(stopped).toBe(true);
});

test("records a failed current workflow before advancing FIFO", async () => {
	vi.useFakeTimers();
	let starts = 0;
	const start = vi.fn(async (_credential, id: string) => {
		starts += 1;
		return starts === 1
			? {
					outcome: "accepted" as const,
					state: {
						id,
						status: "failed" as const,
						error: {
							code: "execution_failed" as const,
							message: "Worker workflow failed.",
						},
					},
				}
			: {
					outcome: "accepted" as const,
					state: { id, status: "running" as const },
				};
	});
	let resolveFailureRecord: (() => void) | undefined;
	const recordFailure = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				resolveFailureRecord = resolve;
			}),
	);
	const terminal = vi.fn();
	const harness = new WorkerWorkflowHarness(
		new ConnectionHarness(credential),
		new StateHarness<WorkerComfyState>({ status: "ready" }),
		{
			start,
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			recordFailure,
			pollMs: 10,
			onTerminal: terminal,
		},
	);

	const first = await harness.submit(inputlessPrompt, "first-client");
	const second = await harness.submit(inputlessPrompt, "second-client");
	await flushMicrotasks();
	expect(recordFailure).toHaveBeenCalledWith(
		expect.objectContaining({ id: first.id }),
		expect.objectContaining({ code: "execution_failed" }),
	);
	expect(terminal).not.toHaveBeenCalled();
	expect(start).toHaveBeenCalledTimes(1);
	expect(harness.getQueue()).toEqual({
		running: [expect.objectContaining({ id: first.id })],
		pending: [expect.objectContaining({ id: second.id })],
	});

	resolveFailureRecord?.();
	await flushMicrotasks();
	expect(terminal).toHaveBeenCalledWith(
		expect.objectContaining({ id: first.id, status: "failed" }),
	);
	expect(start).toHaveBeenCalledTimes(2);
	harness.stop();
	vi.useRealTimers();
});

class WorkerWorkflowHarness {
	private readonly actor: ReturnType<typeof createWorkerWorkflowActor>;
	private readonly unsubscribeConnection: () => void;
	private readonly unsubscribeComfy: () => void;

	constructor(
		private readonly connection: ConnectionHarness,
		private readonly workerComfy: StateHarness<WorkerComfyState>,
		options: WorkerWorkflowActorOptions,
	) {
		this.actor = createWorkerWorkflowActor(options);
		this.actor.start();
		this.unsubscribeConnection = connection.subscribe(() => this.syncReadiness());
		this.unsubscribeComfy = workerComfy.subscribe(() => this.syncReadiness());
		this.syncReadiness();
	}

	submit(
		prompt: Record<string, unknown>,
		clientId: string | null,
		extraData: Record<string, unknown> = {},
	) {
		return submitWorkerWorkflow(this.actor, prompt, clientId, extraData);
	}

	getQueue(): WorkerWorkflowQueue {
		return getWorkerWorkflowQueue(this.actor);
	}

	deletePending(ids: string[]): void {
		deletePendingWorkerWorkflows(this.actor, ids);
	}

	clearPending(): void {
		clearPendingWorkerWorkflows(this.actor);
	}

	cancelCurrent(): string | null {
		return cancelCurrentWorkerWorkflow(this.actor);
	}

	loseConnection(): void {
		failWorkerWorkflowsForConnectionLoss(this.actor);
		this.connection.update(null);
	}

	stop(): void {
		this.unsubscribeConnection();
		this.unsubscribeComfy();
		this.actor.stop();
	}

	stopAndCleanup(): Promise<void> {
		this.unsubscribeConnection();
		this.unsubscribeComfy();
		return stopWorkerWorkflowActor(this.actor);
	}

	private syncReadiness(): void {
		const credential =
			this.connection.getState().status === "connected" &&
			this.workerComfy.getState().status === "ready"
				? this.connection.getActiveCredential()
				: null;
		updateWorkerWorkflowReadiness(this.actor, credential);
	}
}

class ConnectionHarness {
	private readonly listeners = new Set<(state: ConnectionState) => void>();
	private credential: ServerCredential | null;
	private state: ConnectionState;

	constructor(initialCredential: ServerCredential | null) {
		this.credential = initialCredential;
		this.state = connectionState(initialCredential);
	}

	getState(): ConnectionState {
		return this.state;
	}

	getActiveCredential(): ServerCredential | null {
		return this.credential;
	}

	subscribe(listener: (state: ConnectionState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	update(nextCredential: ServerCredential | null): void {
		this.credential = nextCredential;
		this.state = connectionState(nextCredential);
		for (const listener of this.listeners) listener(this.state);
	}
}

class StateHarness<State> {
	private readonly listeners = new Set<(state: State) => void>();

	constructor(private state: State) {}

	getState(): State {
		return this.state;
	}

	subscribe(listener: (state: State) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	update(state: State): void {
		this.state = state;
		for (const listener of this.listeners) listener(state);
	}
}

function connectionState(value: ServerCredential | null): ConnectionState {
	return value === null
		? { status: "disconnected", recentProvider: null, recentServerUrl: null }
		: {
				status: "connected",
				provider: "other",
				serverUrl: value.serverUrl,
				connectedAt: Date.now(),
			};
}

async function flushMicrotasks(): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
}
