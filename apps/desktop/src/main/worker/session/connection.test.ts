// @vitest-environment node

import { expect, test, vi } from "vitest";
import type { ConnectionAttemptResult, ServerCredential } from "../client";
import {
	createHarness,
	currentCustomNodeState,
	currentModelIdleState,
	currentModelState,
	deferred,
	initializeAndConnect,
	inputlessPrompt,
	runtime,
	SECOND_SERVER_URL,
	SERVER_URL,
	SESSION_CAPABILITY,
	type SessionOptions,
	syncingModelState,
	systemMetrics,
	WORKER_ENDPOINT,
	workerTunnel,
} from "./test-harness";

test("refreshes Worker resources after the connection becomes connected", async () => {
	const observedConnectionStatuses: string[] = [];
	const harness = createHarness({
		readBackend: vi.fn(async () => {
			observedConnectionStatuses.push(harness.session.getState().connection.status);
			return {
				ok: true as const,
				state: { status: "ready" as const, version: "0.33.1", runtime },
			};
		}),
	});

	await harness.session.initialize();
	expect(
		await harness.session.connect({
			provider: "other",
			serverUrl: SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: false,
		}),
	).toEqual({ ok: true });
	await vi.waitFor(() => expect(observedConnectionStatuses.length).toBeGreaterThan(0));
	expect(new Set(observedConnectionStatuses)).toEqual(new Set(["connected"]));
	expect(harness.store.save).toHaveBeenCalledWith({
		recentProvider: "other",
		recentServerUrl: SERVER_URL,
		syncAfterConnect: false,
		systemMetricsEnabled: true,
	});
	await harness.session.stop();
});

test("requests the same authentication code after the encrypted session ends", async () => {
	const tunnel = workerTunnel(SERVER_URL);
	const { session } = createHarness({
		connect: vi.fn().mockResolvedValue({
			ok: true,
			logCursor: "cursor-1",
			tunnel,
		}),
	});

	await initializeAndConnect(session);
	tunnel.emitClose();
	await vi.waitFor(() =>
		expect(session.getState().connection).toEqual({
			status: "offline",
			provider: "other",
			serverUrl: SERVER_URL,
			message:
				"The encrypted Worker session ended. Reconnect with the same authentication code while this Worker is running.",
			reconnectRequired: true,
		}),
	);
	await session.stop();
});

test("does not connect when the tunnel closed before its listener was registered", async () => {
	const tunnel = workerTunnel(SERVER_URL);
	tunnel.emitClose();
	const { session } = createHarness({
		connect: vi.fn().mockResolvedValue({
			ok: true,
			logCursor: "cursor-1",
			tunnel,
		}),
	});

	await session.initialize();
	expect(
		await session.connect({
			provider: "other",
			serverUrl: SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: false,
		}),
	).toEqual({
		ok: false,
		error:
			"The encrypted Worker session ended. Reconnect with the same authentication code while this Worker is running.",
	});
	expect(session.getState().connection.status).not.toBe("connected");
	await session.stop();
});

test("rejects workflows until Worker ComfyUI becomes ready", async () => {
	const modelPoll =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["readModels"]>>>>();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const { session } = createHarness({
		readModels: vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				state: currentModelIdleState(),
			})
			.mockReturnValueOnce(modelPoll.promise),
		startModels: vi.fn().mockResolvedValue({
			ok: true,
			state: syncingModelState(),
		}),
		workflow: {
			start,
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			pollMs: 1,
		},
	});

	expect(await session.initialize()).toEqual({ ok: true });
	await expect(
		session.submitWorkflow(inputlessPrompt, "before-connect"),
	).rejects.toMatchObject({
		message: "Worker is not ready.",
		statusCode: 503,
	});
	expect(session.getWorkflowQueue()).toEqual({ running: [], pending: [] });

	expect(
		await session.connect({
			provider: "other",
			serverUrl: SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: false,
		}),
	).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().backend.status).toBe("ready"));
	await expect(
		session.submitWorkflow(inputlessPrompt, "before-comfy"),
	).rejects.toMatchObject({
		message: "Worker is not ready.",
		statusCode: 503,
	});
	expect(start).not.toHaveBeenCalled();
	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));
	expect(session.getState()).toMatchObject({
		models: { status: "syncing" },
		setup: { status: "running", phase: "preparation" },
	});
	const first = await session.submitWorkflow(inputlessPrompt, "first-client");
	const second = await session.submitWorkflow(inputlessPrompt, "second-client");
	await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
	await vi.waitFor(() =>
		expect(session.getWorkflowQueue()).toEqual({ running: [], pending: [] }),
	);
	expect(start.mock.calls.map((call) => call[1])).toEqual([first.id, second.id]);
	modelPoll.resolve({
		ok: true,
		state: currentModelState({ status: "synced", models: [] }),
	});
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	await session.stop();
});

test("rejects Worker ComfyUI restart while a workflow is running", async () => {
	const status = deferred<{
		ok: true;
		state: { id: string; status: "completed" };
	}>();
	const { session, options } = createHarness({
		workflow: {
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "running" },
			}),
			read: () => status.promise,
			pollMs: 1,
		},
	});
	await initializeAndConnect(session);
	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));
	const workflow = await session.submitWorkflow(inputlessPrompt, "active-client");
	await vi.waitFor(() =>
		expect(session.getState().workflow).toMatchObject({
			id: workflow.id,
			phase: "running",
		}),
	);

	await expect(session.restartComfy()).resolves.toEqual({
		ok: false,
		error: "Worker ComfyUI cannot restart while a workflow is running.",
	});
	expect(options.restartComfy).not.toHaveBeenCalled();

	status.resolve({ ok: true, state: { id: workflow.id, status: "completed" } });
	await session.stop();
});

test("pauses a pending workflow during Worker ComfyUI restart and resumes it when ready", async () => {
	const restart =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["restartComfy"]>>>>();
	const start = vi
		.fn()
		.mockResolvedValueOnce({
			outcome: "rejected" as const,
			error: "The Worker is busy.",
			retry: "state-change" as const,
		})
		.mockImplementation(async (_credential, id: string) => ({
			outcome: "accepted" as const,
			state: { id, status: "running" as const },
		}));
	const readComfy = vi
		.fn()
		.mockResolvedValueOnce({ ok: true, state: { status: "stopped" as const } })
		.mockResolvedValue({ ok: true, state: { status: "ready" as const } });
	const { session } = createHarness({
		readComfy,
		restartComfy: vi.fn().mockReturnValue(restart.promise),
		workflow: {
			start,
			read: async (_credential, id) => ({
				ok: true,
				state: { id, status: "completed" },
			}),
			pollMs: 1,
		},
	});
	await initializeAndConnect(session);
	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));
	const workflow = await session.submitWorkflow(inputlessPrompt, "pending-client");
	await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
	await vi.waitFor(() =>
		expect(session.getWorkflowQueue().pending).toEqual([
			expect.objectContaining({ id: workflow.id }),
		]),
	);

	const restarting = session.restartComfy();
	expect(session.getState().comfy).toEqual({ status: "loading" });
	expect(start).toHaveBeenCalledOnce();
	restart.resolve({ ok: true, state: { status: "starting" } });
	await expect(restarting).resolves.toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));
	await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
	await vi.waitFor(() =>
		expect(session.getWorkflowQueue()).toEqual({ running: [], pending: [] }),
	);
	await session.stop();
});

test("aborts Worker ComfyUI memory cleanup when the connection ends", async () => {
	const fetchMock = vi.fn(
		(_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted.", "AbortError"));
				});
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const { session } = createHarness({
		freeComfyMemory: vi.fn(async (_credential, _request, requestFetch) => {
			await requestFetch("https://worker.example.com/comfyui/runtime/free");
			return { ok: true as const, state: true as const };
		}),
	});

	try {
		await initializeAndConnect(session);
		const cleanup = session.freeComfyMemory({ unload_models: true });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		await session.disconnect();

		expect(await cleanup).toEqual({
			ok: false,
			error: "A newer Worker connection request replaced this one.",
		});
	} finally {
		session.stop();
		vi.unstubAllGlobals();
	}
});

test("lets concurrent Worker ComfyUI memory cleanup requests finish independently", async () => {
	const firstResult = deferred<{ ok: true; state: true }>();
	const secondResult = deferred<{ ok: true; state: true }>();
	const freeComfyMemory = vi
		.fn()
		.mockReturnValueOnce(firstResult.promise)
		.mockReturnValueOnce(secondResult.promise);
	const { session } = createHarness({ freeComfyMemory });
	await initializeAndConnect(session);

	const first = session.freeComfyMemory({
		unload_models: true,
		free_memory: true,
	});
	const second = session.freeComfyMemory({ unload_models: true });
	await vi.waitFor(() => expect(freeComfyMemory).toHaveBeenCalledTimes(2));

	secondResult.resolve({ ok: true, state: true });
	await expect(second).resolves.toEqual({ ok: true });
	firstResult.resolve({ ok: true, state: true });
	await expect(first).resolves.toEqual({ ok: true });

	await session.stop();
});

test("waits for retrying workflow input cleanup when stopping", async () => {
	const discarded = deferred<void>();
	const cleanupInputs = vi.fn(async (_jobId: string) => undefined);
	const discardInputs = vi.fn(
		(_credential: ServerCredential, _jobId: string) => discarded.promise,
	);
	const start = vi.fn(async () => ({
		outcome: "rejected" as const,
		error: "The Worker is busy.",
		retry: "state-change" as const,
	}));
	const { session } = createHarness({
		workflow: { start, cleanupInputs, discardInputs },
	});
	await initializeAndConnect(session);
	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	const workflow = await session.submitWorkflow(inputlessPrompt, null);
	await vi.waitFor(() =>
		expect(session.getWorkflowQueue().pending).toEqual([
			expect.objectContaining({ id: workflow.id }),
		]),
	);

	let stopped = false;
	const stopping = session.stop().then(() => {
		stopped = true;
	});
	await vi.waitFor(() =>
		expect(discardInputs).toHaveBeenCalledWith(
			expect.objectContaining({ serverUrl: WORKER_ENDPOINT, workerUrl: SERVER_URL }),
			workflow.id,
		),
	);
	expect(cleanupInputs).toHaveBeenCalledWith(workflow.id);
	expect(stopped).toBe(false);

	discarded.resolve();
	await stopping;
	expect(stopped).toBe(true);
});

test("keeps current on its original Worker while a replacement Worker owns later jobs", async () => {
	const firstStatus = deferred<{
		ok: true;
		state: { id: string; status: "completed" };
	}>();
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const read = vi
		.fn()
		.mockReturnValueOnce(firstStatus.promise)
		.mockImplementation(async (_credential, id: string) => ({
			ok: true,
			state: { id, status: "completed" as const },
		}));
	const terminal = vi.fn();
	const { session } = createHarness({
		workflow: { start, read, pollMs: 1, onTerminal: terminal },
	});
	await initializeAndConnect(session);
	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));

	const first = await session.submitWorkflow(inputlessPrompt, "first-client");
	const second = await session.submitWorkflow(inputlessPrompt, "second-client");
	await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

	expect(
		await session.connect({
			provider: "other",
			serverUrl: SECOND_SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: false,
		}),
	).toEqual({ ok: true });
	firstStatus.resolve({
		ok: true,
		state: { id: first.id, status: "completed" },
	});
	await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
	expect(read.mock.calls[0]?.[0]).toMatchObject({
		serverUrl: WORKER_ENDPOINT,
		workerUrl: SERVER_URL,
	});
	expect(session.getWorkflowQueue()).toMatchObject({
		running: [],
		pending: [{ id: second.id }],
	});
	expect(start).toHaveBeenCalledTimes(1);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
	expect(start.mock.calls[1]?.[0]).toMatchObject({
		serverUrl: WORKER_ENDPOINT,
		workerUrl: SECOND_SERVER_URL,
	});
	await vi.waitFor(() =>
		expect(session.getWorkflowQueue()).toEqual({ running: [], pending: [] }),
	);
	session.stop();
});

test("keeps an unconfirmed cancellation visible after disconnect", async () => {
	const { session } = createHarness({
		workflow: {
			start: async (_credential, id) => ({
				outcome: "accepted",
				state: { id, status: "running" },
			}),
			cancel: async () => ({
				ok: false,
				error: "The Worker could not be reached.",
				retryable: true,
			}),
			read: async () => ({
				ok: false,
				error: "The Worker could not be reached.",
				retryable: true,
			}),
			pollMs: 60_000,
		},
	});
	await initializeAndConnect(session);
	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));

	const workflow = await session.submitWorkflow(inputlessPrompt, "comfy-client");
	await vi.waitFor(() =>
		expect(session.getState().workflow).toMatchObject({
			id: workflow.id,
			phase: "running",
			workerUrl: SERVER_URL,
		}),
	);
	expect(session.cancelCurrentWorkflow()).toBe(workflow.id);
	await vi.waitFor(() =>
		expect(session.getState().workflow).toMatchObject({
			id: workflow.id,
			cancellation: "unconfirmed",
		}),
	);

	await session.disconnect();
	expect(session.getState()).toMatchObject({
		connection: {
			status: "disconnected",
			recentProvider: "other",
			recentServerUrl: SERVER_URL,
		},
		workflow: {
			id: workflow.id,
			cancellation: "unconfirmed",
			workerUrl: SERVER_URL,
		},
	});
	await session.stop();
});

test("fails current and pending workflows only after five consecutive health check failures", async () => {
	const finalOfflineProbe =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const recoveredProbe =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const probe = vi.fn();
	for (let attempt = 0; attempt < 4; attempt += 1) {
		probe.mockResolvedValueOnce({ status: "offline", error: "Worker unavailable." });
	}
	probe
		.mockReturnValueOnce(finalOfflineProbe.promise)
		.mockReturnValue(recoveredProbe.promise);
	const start = vi.fn(async (_credential, id: string) => ({
		outcome: "accepted" as const,
		state: { id, status: "running" as const },
	}));
	const recordFailure = vi.fn(async () => undefined);
	const terminal = vi.fn();
	const { session } = createHarness({
		probe,
		recheckMs: 1,
		workflow: {
			start,
			read: async () => ({
				ok: false,
				error: "Worker workflow status could not be loaded.",
				retryable: true,
			}),
			recordFailure,
			pollMs: 60_000,
			onTerminal: terminal,
		},
	});

	try {
		await initializeAndConnect(session);
		expect(session.startSetup()).toEqual({ ok: true });
		await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));
		const first = await session.submitWorkflow(inputlessPrompt, "first-client");
		const second = await session.submitWorkflow(inputlessPrompt, "second-client");
		await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(5));

		expect(session.getState().connection.status).toBe("connected");
		expect(session.getWorkflowQueue()).toMatchObject({
			running: [{ id: first.id }],
			pending: [{ id: second.id }],
		});
		expect(terminal).not.toHaveBeenCalled();

		finalOfflineProbe.resolve({
			status: "offline",
			error: "Worker unavailable.",
		});
		await vi.waitFor(() =>
			expect(session.getState().connection.status).toBe("offline"),
		);
		await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(2));

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
		expect(start).toHaveBeenCalledOnce();
		expect(session.getWorkflowQueue()).toEqual({ running: [], pending: [] });
	} finally {
		await session.stop();
	}
});

test("initialization restores only the recent Worker address without auto-connecting", async () => {
	const { session, store, options } = createHarness();
	store.load.mockResolvedValue({
		recentProvider: "runpod",
		recentServerUrl: SERVER_URL,
		syncAfterConnect: true,
	});

	expect(await session.initialize()).toEqual({ ok: true });
	expect(session.getState()).toMatchObject({
		connection: {
			status: "disconnected",
			recentProvider: "runpod",
			recentServerUrl: SERVER_URL,
		},
		setup: { status: "idle" },
	});
	expect(options.connect).not.toHaveBeenCalled();
	session.stop();
});

test("keeps the latest initialization when an older preference load finishes late", async () => {
	const firstLoad = deferred<{
		recentProvider: "runpod" | "vastai";
		recentServerUrl: string;
		syncAfterConnect: boolean;
	}>();
	const { session, store } = createHarness();
	store.load.mockReset().mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce({
		recentProvider: "vastai",
		recentServerUrl: SECOND_SERVER_URL,
		syncAfterConnect: false,
	});

	const first = session.initialize();
	const second = session.initialize();
	expect(await first).toEqual({
		ok: false,
		error: "A newer Worker connection request replaced this one.",
	});
	expect(await second).toEqual({ ok: true });

	firstLoad.resolve({
		recentProvider: "runpod",
		recentServerUrl: SERVER_URL,
		syncAfterConnect: true,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(session.getState().connection).toEqual({
		status: "disconnected",
		recentProvider: "vastai",
		recentServerUrl: SECOND_SERVER_URL,
	});
	await session.stop();
});

test("polls system metrics independently from Worker readiness", async () => {
	const failed = deferred<{
		ok: false;
		error: string;
	}>();
	const recovered = deferred<{
		ok: true;
		state: typeof systemMetrics;
	}>();
	const readSystemMetrics = vi
		.fn()
		.mockResolvedValueOnce({ ok: true, state: systemMetrics })
		.mockReturnValueOnce(failed.promise)
		.mockReturnValueOnce(recovered.promise)
		.mockResolvedValue({
			ok: true,
			state: { ...systemMetrics, cpu: { usagePercent: 24 } },
		});
	const { session } = createHarness({
		readSystemMetrics,
		systemMetricsPollMs: 1,
	});
	await initializeAndConnect(session);

	await vi.waitFor(() =>
		expect(session.getState().systemMetrics).toEqual({
			status: "available",
			metrics: systemMetrics,
		}),
	);
	expect(readSystemMetrics).toHaveBeenNthCalledWith(
		1,
		{
			serverUrl: WORKER_ENDPOINT,
			sessionCapability: SESSION_CAPABILITY,
			workerUrl: SERVER_URL,
		},
		expect.any(Function),
	);
	await vi.waitFor(() => expect(readSystemMetrics).toHaveBeenCalledTimes(2));
	failed.resolve({ ok: false, error: "Metrics temporarily unavailable." });
	await vi.waitFor(() =>
		expect(session.getState()).toMatchObject({
			connection: { status: "connected", serverUrl: SERVER_URL },
			systemMetrics: {
				status: "unavailable",
				error: "Metrics temporarily unavailable.",
			},
			backend: { status: "ready" },
			comfy: { status: "stopped" },
			setup: { status: "idle" },
		}),
	);
	await vi.waitFor(() => expect(readSystemMetrics).toHaveBeenCalledTimes(3));
	recovered.resolve({
		ok: true,
		state: { ...systemMetrics, cpu: { usagePercent: 24 } },
	});
	await vi.waitFor(() =>
		expect(session.getState().systemMetrics).toMatchObject({
			status: "available",
			metrics: { cpu: { usagePercent: 24 } },
		}),
	);

	await session.disconnect();
	expect(session.getState().systemMetrics).toEqual({ status: "disconnected" });
	const callsAfterDisconnect = readSystemMetrics.mock.calls.length;
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(readSystemMetrics).toHaveBeenCalledTimes(callsAfterDisconnect);
	session.stop();
});

test("does not poll system metrics when the saved setting is disabled", async () => {
	const readSystemMetrics = vi.fn();
	const { session, store } = createHarness({ readSystemMetrics });
	store.load.mockResolvedValue({
		recentProvider: null,
		recentServerUrl: null,
		syncAfterConnect: true,
		systemMetricsEnabled: false,
	});

	await initializeAndConnect(session);
	await vi.waitFor(() =>
		expect(session.getState().systemMetrics).toEqual({ status: "disabled" }),
	);
	expect(readSystemMetrics).not.toHaveBeenCalled();
	expect(session.getSettings()).toEqual({
		ok: true,
		settings: { syncAfterConnect: false, systemMetricsEnabled: false },
	});
	session.stop();
});

test("stops and resumes system metrics polling for the current Worker", async () => {
	const firstMetrics = deferred<{
		ok: true;
		state: typeof systemMetrics;
	}>();
	const readSystemMetrics = vi
		.fn()
		.mockReturnValueOnce(firstMetrics.promise)
		.mockResolvedValue({ ok: true, state: systemMetrics });
	const { session } = createHarness({ readSystemMetrics });

	await initializeAndConnect(session);
	await vi.waitFor(() => expect(readSystemMetrics).toHaveBeenCalledOnce());
	expect(session.getState().systemMetrics).toEqual({ status: "loading" });

	expect(
		await session.updateSettings({
			syncAfterConnect: false,
			systemMetricsEnabled: false,
		}),
	).toEqual({
		ok: true,
		settings: { syncAfterConnect: false, systemMetricsEnabled: false },
	});
	expect(session.getState().systemMetrics).toEqual({ status: "disabled" });

	firstMetrics.resolve({
		ok: true,
		state: { ...systemMetrics, cpu: { usagePercent: 99 } },
	});
	await firstMetrics.promise;
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(session.getState().systemMetrics).toEqual({ status: "disabled" });
	expect(readSystemMetrics).toHaveBeenCalledOnce();

	expect(
		await session.updateSettings({
			syncAfterConnect: false,
			systemMetricsEnabled: true,
		}),
	).toEqual({
		ok: true,
		settings: { syncAfterConnect: false, systemMetricsEnabled: true },
	});
	await vi.waitFor(() => expect(readSystemMetrics).toHaveBeenCalledTimes(2));
	await vi.waitFor(() =>
		expect(session.getState().systemMetrics).toEqual({
			status: "available",
			metrics: systemMetrics,
		}),
	);
	session.stop();
});

test("keeps system metrics polling unchanged when the setting cannot be saved", async () => {
	const { session, store, options } = createHarness();
	await initializeAndConnect(session);
	await vi.waitFor(() =>
		expect(session.getState().systemMetrics.status).toBe("available"),
	);
	store.save.mockRejectedValueOnce(new Error("disk unavailable"));

	expect(
		await session.updateSettings({
			syncAfterConnect: false,
			systemMetricsEnabled: false,
		}),
	).toEqual({
		ok: false,
		error: "The connection settings could not be saved. disk unavailable",
	});
	expect(session.getState().systemMetrics.status).toBe("available");
	expect(options.readSystemMetrics).toHaveBeenCalledOnce();
	session.stop();
});

test("discards system metrics returned by a replaced Worker", async () => {
	const firstMetrics = deferred<{
		ok: true;
		state: typeof systemMetrics;
	}>();
	const secondMetrics = deferred<{
		ok: true;
		state: typeof systemMetrics;
	}>();
	const readSystemMetrics = vi
		.fn()
		.mockReturnValueOnce(firstMetrics.promise)
		.mockReturnValueOnce(secondMetrics.promise);
	const { session } = createHarness({ readSystemMetrics });
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(readSystemMetrics).toHaveBeenCalledOnce());

	expect(
		await session.connect({
			provider: "other",
			serverUrl: SECOND_SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: false,
		}),
	).toEqual({ ok: true });
	await vi.waitFor(() => expect(readSystemMetrics).toHaveBeenCalledTimes(2));
	secondMetrics.resolve({
		ok: true,
		state: { ...systemMetrics, cpu: { usagePercent: 24 } },
	});
	await vi.waitFor(() =>
		expect(session.getState().systemMetrics).toMatchObject({
			status: "available",
			metrics: { cpu: { usagePercent: 24 } },
		}),
	);

	firstMetrics.resolve({
		ok: true,
		state: { ...systemMetrics, cpu: { usagePercent: 99 } },
	});
	await firstMetrics.promise;
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(session.getState()).toMatchObject({
		connection: { status: "connected", serverUrl: SECOND_SERVER_URL },
		systemMetrics: {
			status: "available",
			metrics: { cpu: { usagePercent: 24 } },
		},
	});
	session.stop();
});

test("does not replace active Worker work after a successful connection recheck", async () => {
	const preparation =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["prepareBackend"]>>>>();
	const probeResult =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const readBackend = vi.fn().mockResolvedValue({
		ok: true,
		state: { status: "ready" as const, version: "0.33.1", runtime },
	});
	const prepareBackend = vi.fn().mockReturnValue(preparation.promise);
	const { session, options } = createHarness({
		readBackend,
		prepareBackend,
		probe: vi.fn().mockReturnValue(probeResult.promise),
		recheckMs: 1,
	});
	await initializeAndConnect(session);

	const result = session.prepareBackend();
	await vi.waitFor(() => expect(options.probe).toHaveBeenCalled());
	probeResult.resolve({ status: "connected" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(readBackend).toHaveBeenCalledOnce();
	preparation.resolve({
		ok: true,
		state: { status: "ready", version: "0.33.1", runtime },
	});

	expect(await result).toEqual({
		ok: true,
		state: {
			status: "ready",
			version: "0.33.1",
			editorComfyVersion: "0.33.1",
			runtime,
		},
	});
	session.stop();
});

test("clears stale Worker identity when a connection recheck omits it", async () => {
	const recheck = deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const { session, options } = createHarness({
		connect: vi.fn().mockImplementation(async (serverUrl: string) => ({
			ok: true as const,
			logCursor: "cursor-1",
			tunnel: workerTunnel(serverUrl),
			worker: { version: "0.1.0", buildNumber: "15", channel: "beta" as const },
		})),
		probe: vi.fn().mockReturnValue(recheck.promise),
		recheckMs: 1,
	});

	await initializeAndConnect(session);
	expect(session.getState().connection).toMatchObject({
		status: "connected",
		worker: { version: "0.1.0", buildNumber: "15", channel: "beta" },
	});
	await vi.waitFor(() => expect(options.probe).toHaveBeenCalled());
	recheck.resolve({ status: "connected" });
	await vi.waitFor(() =>
		expect(session.getState().connection).toEqual({
			status: "connected",
			provider: "other",
			serverUrl: SERVER_URL,
			connectedAt: expect.any(Number),
		}),
	);
	await session.stop();
});

test("preserves connection time during rechecks and resets it after recovery", async () => {
	const stableProbe =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const offlineProbes = Array.from({ length: 5 }, () =>
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>(),
	);
	const recoveredProbe =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const probe = vi.fn().mockReturnValueOnce(stableProbe.promise);
	for (const offlineProbe of offlineProbes) {
		probe.mockReturnValueOnce(offlineProbe.promise);
	}
	probe.mockReturnValueOnce(recoveredProbe.promise).mockResolvedValue({
		status: "connected",
		worker: { version: "0.1.0", buildNumber: "15", channel: "beta" },
	});
	const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
	const { session } = createHarness({ probe, recheckMs: 1 });

	try {
		await initializeAndConnect(session);
		expect(session.getState().connection).toMatchObject({
			status: "connected",
			connectedAt: 1_000,
		});

		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
		now.mockReturnValue(2_000);
		stableProbe.resolve({ status: "connected" });
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
		expect(session.getState().connection).toMatchObject({
			status: "connected",
			connectedAt: 1_000,
		});

		for (const [index, offlineProbe] of offlineProbes.entries()) {
			offlineProbe.resolve({ status: "offline", error: "Worker unavailable." });
			if (index < offlineProbes.length - 1) {
				await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(index + 3));
				expect(session.getState().connection.status).toBe("connected");
			}
		}
		await vi.waitFor(() =>
			expect(session.getState().connection.status).toBe("offline"),
		);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(7));
		now.mockReturnValue(3_000);
		recoveredProbe.resolve({
			status: "connected",
			worker: { version: "0.1.0", buildNumber: "15", channel: "beta" },
		});
		await vi.waitFor(() =>
			expect(session.getState().connection).toMatchObject({
				status: "connected",
				connectedAt: 3_000,
				worker: { version: "0.1.0", buildNumber: "15", channel: "beta" },
			}),
		);
	} finally {
		await session.stop();
		now.mockRestore();
	}
});

test("allows setup after an automatic connection recovery", async () => {
	const recovery =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const probe = vi.fn();
	for (let attempt = 0; attempt < 5; attempt += 1) {
		probe.mockResolvedValueOnce({ status: "offline", error: "Worker unavailable." });
	}
	probe
		.mockReturnValueOnce(recovery.promise)
		.mockResolvedValue({ status: "connected" });
	const { session } = createHarness({ probe, recheckMs: 1 });

	try {
		await initializeAndConnect(session);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(6));
		expect(session.getState().connection.status).toBe("offline");

		recovery.resolve({ status: "connected" });
		await vi.waitFor(() =>
			expect(session.getState()).toMatchObject({
				connection: { status: "connected", serverUrl: SERVER_URL },
				backend: { status: "ready" },
				comfy: { status: "stopped" },
				customNodes: { status: "idle" },
				models: { status: "idle" },
			}),
		);
		expect(session.startSetup()).toEqual({ ok: true });
		await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	} finally {
		await session.stop();
	}
});

test("keeps a successful retry when an older health check finishes late", async () => {
	const olderCheck =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const probe = vi.fn();
	for (let attempt = 0; attempt < 5; attempt += 1) {
		probe.mockResolvedValueOnce({ status: "offline", error: "Worker unavailable." });
	}
	probe
		.mockReturnValueOnce(olderCheck.promise)
		.mockResolvedValue({ status: "connected" });
	const { session } = createHarness({ probe, recheckMs: 1 });

	try {
		await initializeAndConnect(session);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(6));
		expect(session.getState().connection.status).toBe("offline");

		expect(await session.retry()).toEqual({ ok: true });
		expect(session.getState().connection).toMatchObject({
			status: "connected",
			serverUrl: SERVER_URL,
		});
		olderCheck.resolve({ status: "offline", error: "Stale health result." });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session.getState().connection.status).toBe("connected");
	} finally {
		await session.stop();
	}
});

test("does not interrupt setup when retry is requested while connected", async () => {
	const customNodes =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startCustomNodes"]>>>>();
	const startCustomNodes = vi.fn().mockReturnValue(customNodes.promise);
	const { session, options } = createHarness({ startCustomNodes });

	await initializeAndConnect(session);
	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(startCustomNodes).toHaveBeenCalledOnce());

	expect(await session.retry()).toEqual({
		ok: false,
		error: "Worker connection retry is only available while offline.",
	});
	expect(session.getState().setup).toEqual({
		status: "running",
		phase: "preparation",
	});
	expect(options.probe).not.toHaveBeenCalled();

	customNodes.resolve({
		ok: true,
		state: currentCustomNodeState({
			status: "ready",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		}),
	});
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	await session.stop();
});

test("resets consecutive recheck failures after one successful probe", async () => {
	const resetProbe =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const finalOfflineProbe =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const recoveredProbe =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const probe = vi.fn();
	for (let attempt = 0; attempt < 4; attempt += 1) {
		probe.mockResolvedValueOnce({ status: "offline", error: "Worker unavailable." });
	}
	probe.mockReturnValueOnce(resetProbe.promise);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		probe.mockResolvedValueOnce({ status: "offline", error: "Worker unavailable." });
	}
	probe
		.mockReturnValueOnce(finalOfflineProbe.promise)
		.mockReturnValue(recoveredProbe.promise);
	const { session } = createHarness({ probe, recheckMs: 1 });

	try {
		await initializeAndConnect(session);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(5));
		expect(session.getState().connection.status).toBe("connected");

		resetProbe.resolve({ status: "connected" });
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(10));
		expect(session.getState().connection.status).toBe("connected");

		finalOfflineProbe.resolve({ status: "offline", error: "Worker unavailable." });
		await vi.waitFor(() =>
			expect(session.getState().connection.status).toBe("offline"),
		);
	} finally {
		await session.stop();
	}
});

test("refreshes settled Worker state after a successful connection recheck", async () => {
	const readComfy = vi
		.fn()
		.mockResolvedValueOnce({ ok: true, state: { status: "stopped" } })
		.mockResolvedValue({ ok: true, state: { status: "ready" } });
	const { session } = createHarness({ readComfy, recheckMs: 1 });
	await initializeAndConnect(session);

	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));
	expect(readComfy.mock.calls.length).toBeGreaterThanOrEqual(2);
	session.stop();
});

test("ignores work completed after the Worker session was replaced", async () => {
	const first = deferred<Extract<ConnectionAttemptResult, { ok: true }>>();
	const second = deferred<Extract<ConnectionAttemptResult, { ok: true }>>();
	const connect = vi
		.fn()
		.mockReturnValueOnce(first.promise)
		.mockReturnValueOnce(second.promise);
	const { session } = createHarness({ connect });
	await session.initialize();

	const firstConnection = session.connect({
		provider: "other",
		serverUrl: SERVER_URL,
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: false,
	});
	const secondConnection = session.connect({
		provider: "other",
		serverUrl: SECOND_SERVER_URL,
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: false,
	});
	second.resolve({
		ok: true,
		logCursor: "second",
		tunnel: workerTunnel(SECOND_SERVER_URL),
		worker: { version: "0.2.0", buildNumber: "2", channel: "production" },
	});
	expect(await secondConnection).toEqual({ ok: true });
	first.resolve({
		ok: true,
		logCursor: "first",
		tunnel: workerTunnel(SERVER_URL),
		worker: { version: "0.1.0", buildNumber: "1", channel: "beta" },
	});
	expect(await firstConnection).toEqual({
		ok: false,
		error: "A newer Worker connection request replaced this one.",
	});
	expect(session.getState().connection).toEqual({
		status: "connected",
		provider: "other",
		serverUrl: SECOND_SERVER_URL,
		connectedAt: expect.any(Number),
		worker: { version: "0.2.0", buildNumber: "2", channel: "production" },
	});
	session.stop();
});

test("settles an active connection request when the session stops", async () => {
	const pending =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["connect"]>>>>();
	const { session } = createHarness({
		connect: vi.fn().mockReturnValue(pending.promise),
	});
	await session.initialize();

	const connection = session.connect({
		provider: "other",
		serverUrl: SERVER_URL,
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: false,
	});
	await session.stop();
	expect(await connection).toEqual({
		ok: false,
		error: "A newer Worker connection request replaced this one.",
	});
	pending.resolve({
		ok: true,
		logCursor: "late",
		tunnel: workerTunnel(SERVER_URL),
	});
});

test("replaces a completed connection result when disconnect wins before its reply", async () => {
	const { session } = createHarness();
	await session.initialize();
	vi.useFakeTimers();

	try {
		const connection = session.connect({
			provider: "other",
			serverUrl: SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: false,
		});
		for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
		expect(session.getState().connection.status).toBe("connected");

		await session.disconnect();
		expect(await connection).toEqual({
			ok: false,
			error: "A newer Worker connection request replaced this one.",
		});
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
		await session.stop();
	}
});

test("closes a connected tunnel when disconnect wins during preference persistence", async () => {
	const saved = deferred<void>();
	const tunnel = workerTunnel(SERVER_URL);
	const { session, store } = createHarness({
		connect: vi.fn().mockResolvedValue({
			ok: true,
			logCursor: "cursor-1",
			tunnel,
		}),
	});
	store.save.mockReturnValue(saved.promise);
	await session.initialize();

	const connection = session.connect({
		provider: "other",
		serverUrl: SERVER_URL,
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: false,
	});
	await vi.waitFor(() => expect(store.save).toHaveBeenCalledOnce());
	await session.disconnect();
	saved.resolve();

	await expect(connection).resolves.toEqual({
		ok: false,
		error: "A newer Worker connection request replaced this one.",
	});
	expect(tunnel.close).toHaveBeenCalledOnce();
	await session.stop();
});

test("clears Worker-specific state while replacing an active connection", async () => {
	const replacement =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["connect"]>>>>();
	const connect = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			logCursor: "first",
			tunnel: workerTunnel(SERVER_URL),
		})
		.mockReturnValueOnce(replacement.promise);
	const { session } = createHarness({ connect });
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(session.getState()).toMatchObject({
		connection: { status: "connected", serverUrl: SERVER_URL },
		comfy: { status: "ready" },
		verification: { status: "synced" },
	});

	const result = session.connect({
		provider: "other",
		serverUrl: SECOND_SERVER_URL,
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: false,
	});
	expect(session.getState()).toEqual({
		connection: {
			status: "connecting",
			provider: "other",
			serverUrl: SECOND_SERVER_URL,
		},
		systemMetrics: { status: "disconnected" },
		backend: { status: "disconnected", editorComfyVersion: "0.33.1" },
		comfy: { status: "disconnected" },
		customNodes: { status: "disconnected" },
		models: { status: "disconnected" },
		verification: null,
		setup: { status: "idle" },
	});

	replacement.resolve({ ok: false, error: "Worker unavailable." });
	expect(await result).toEqual({ ok: false, error: "Worker unavailable." });
	expect(session.getState()).toEqual({
		connection: {
			status: "disconnected",
			recentProvider: "other",
			recentServerUrl: SERVER_URL,
		},
		systemMetrics: { status: "disconnected" },
		backend: { status: "disconnected", editorComfyVersion: "0.33.1" },
		comfy: { status: "disconnected" },
		customNodes: { status: "disconnected" },
		models: { status: "disconnected" },
		verification: null,
		setup: { status: "idle" },
	});
	session.stop();
});
