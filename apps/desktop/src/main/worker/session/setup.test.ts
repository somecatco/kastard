// @vitest-environment node

import { expect, test, vi } from "vitest";
import type { ModelSyncRequest, ModelSyncServerState } from "../../../shared/api";
import type { CustomNodeSyncPlan } from "../sync-plan";
import {
	CUSTOM_NODE_TARGET,
	createHarness,
	currentCustomNodeIdleState,
	currentCustomNodeState,
	currentModelIdleState,
	currentModelState,
	deferred,
	initializeAndConnect,
	runtime,
	SERVER_URL,
	type SessionOptions,
	syncingCustomNodeState,
	syncingModelState,
	syncingSetupOptions,
	systemMetrics,
	verification,
	WORKER_ENDPOINT,
} from "./test-harness";

const authenticatedModelRequest: ModelSyncRequest = {
	models: [
		{
			name: "Private model",
			path: "checkpoints/private.safetensors",
			artifact: {
				provider: "huggingface",
				modelId: "owner/repository",
				versionId: "a".repeat(40),
				versionLabel: "version",
				fileId: "private.safetensors",
				fileName: "private.safetensors",
				sizeBytes: 1,
			},
		},
	],
	credentials: { huggingface: "provider-token" },
};

const setupUnavailableResult = {
	ok: false,
	error: "Individual synchronization is unavailable during this Worker setup phase.",
} as const;

test("uses model credentials through the encrypted Worker session", async () => {
	const serverUrl = SERVER_URL;
	const startModels = vi.fn().mockResolvedValue({
		ok: true,
		state: currentModelState({
			status: "synced",
			models: authenticatedModelRequest.models,
		}),
	});
	const { session } = createHarness(
		{ startModels },
		{ buildModelSyncPlan: async () => authenticatedModelRequest },
	);
	expect(await session.initialize()).toEqual({ ok: true });
	expect(
		await session.connect({
			provider: "other",
			serverUrl,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: false,
		}),
	).toEqual({
		ok: true,
	});
	await vi.waitFor(() => expect(session.getState().backend.status).toBe("ready"));

	await expect(session.syncModels()).resolves.toMatchObject({ ok: true });
	expect(startModels).toHaveBeenCalledWith(
		expect.objectContaining({ serverUrl: WORKER_ENDPOINT, workerUrl: serverUrl }),
		authenticatedModelRequest,
		expect.any(Function),
	);
	session.stop();
});

test("starts Worker ComfyUI after custom nodes settle while models continue", async () => {
	const customNodes =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startCustomNodes"]>>>>();
	const modelPoll =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["readModels"]>>>>();
	const startCustomNodes = vi.fn().mockReturnValue(customNodes.promise);
	const startModels = vi.fn().mockResolvedValue({
		ok: true,
		state: syncingModelState(),
	});
	const readModels = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			state: currentModelIdleState(),
		})
		.mockReturnValueOnce(modelPoll.promise);
	const { session, options } = createHarness({
		readModels,
		startCustomNodes,
		startModels,
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => {
		expect(startCustomNodes).toHaveBeenCalledOnce();
		expect(startModels).toHaveBeenCalledOnce();
	});
	expect(options.verify).not.toHaveBeenCalled();
	customNodes.resolve({
		ok: true,
		state: currentCustomNodeState({
			status: "ready",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		}),
	});

	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));
	expect(session.getState()).toMatchObject({
		models: { status: "syncing" },
		setup: { status: "running", phase: "preparation" },
	});
	expect(options.verify).not.toHaveBeenCalled();
	expect(options.startComfy).toHaveBeenCalledOnce();

	modelPoll.resolve({
		ok: true,
		state: currentModelState({ status: "synced", models: [] }),
	});

	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(options.verify).toHaveBeenCalledOnce();
	expect(options.startComfy).toHaveBeenCalledOnce();
	session.stop();
});

test("fails setup when started Worker ComfyUI stops before models finish", async () => {
	const syncedModels = {
		ok: true as const,
		state: currentModelState({ status: "synced" as const, models: [] }),
	};
	const modelPoll =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["readModels"]>>>>();
	const readModels = vi
		.fn<NonNullable<SessionOptions["readModels"]>>()
		.mockResolvedValueOnce({
			ok: true,
			state: currentModelIdleState(),
		})
		.mockReturnValueOnce(modelPoll.promise)
		.mockResolvedValue(syncedModels);
	const { session } = createHarness({
		readComfy: vi
			.fn()
			.mockResolvedValueOnce({ ok: true, state: { status: "stopped" } })
			.mockResolvedValue({ ok: true, state: { status: "stopped" } }),
		readCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: currentCustomNodeState({
				status: "ready",
				nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
			}),
		}),
		readModels,
		startModels: vi.fn().mockResolvedValue({
			ok: true,
			state: syncingModelState(),
		}),
		recheckMs: 100,
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() =>
		expect(session.getState()).toMatchObject({
			comfy: { status: "ready" },
			models: { status: "syncing" },
		}),
	);
	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("stopped"));
	modelPoll.resolve(syncedModels);

	await vi.waitFor(() => expect(session.getState().setup.status).toBe("failed"));
	expect(session.getState().setup).toMatchObject({
		status: "failed",
		phase: "comfy",
		error: "Worker ComfyUI is no longer ready.",
	});
	await session.stop();
});

test("waits for an active model redownload before starting Worker ComfyUI", async () => {
	const redownloadPoll =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["readModels"]>>>>();
	const activeRedownload = {
		contractVersion: 2,
		capabilities: { forceRedownload: true },
		target: { models: authenticatedModelRequest.models },
		operationId: "model-redownload",
		operationKind: "redownload",
		status: "checking",
		total: 1,
		totalBytes: 1,
		modelSnapshot: {
			models: [
				{
					path: authenticatedModelRequest.models[0]?.path ?? "",
					status: "not-downloaded",
					downloadedBytes: 0,
				},
			],
		},
	} satisfies ModelSyncServerState;
	const completedRedownload = {
		...activeRedownload,
		status: "synced",
		models: authenticatedModelRequest.models,
		modelSnapshot: {
			models: [
				{
					path: authenticatedModelRequest.models[0]?.path ?? "",
					status: "ready",
					downloadedBytes: 1,
				},
			],
		},
	} satisfies ModelSyncServerState;
	const readModels = vi
		.fn<NonNullable<SessionOptions["readModels"]>>()
		.mockResolvedValueOnce({ ok: true, state: activeRedownload })
		.mockReturnValueOnce(redownloadPoll.promise);
	const { session, options } = createHarness(
		{ readModels },
		{ buildModelSyncPlan: async () => authenticatedModelRequest },
	);
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(readModels).toHaveBeenCalledTimes(2));
	await vi.waitFor(() => expect(session.getState().models.status).toBe("checking"));

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() =>
		expect(session.getState().setup).toEqual({
			status: "running",
			phase: "comfy",
		}),
	);
	expect(options.startComfy).not.toHaveBeenCalled();

	redownloadPoll.resolve({ ok: true, state: completedRedownload });
	await vi.waitFor(() => expect(options.startComfy).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	await session.stop();
});

test("waits for a model resync started during setup preparation", async () => {
	const customNodes =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startCustomNodes"]>>>>();
	const modelResync =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startModels"]>>>>();
	const startModels = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			state: currentModelState({ status: "synced", models: [] }),
		})
		.mockReturnValueOnce(modelResync.promise);
	const { session, options } = createHarness({
		startCustomNodes: vi.fn().mockReturnValue(customNodes.promise),
		startModels,
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(startModels).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(session.getState().models.status).toBe("synced"));

	const resync = session.syncModels();
	await vi.waitFor(() => expect(startModels).toHaveBeenCalledTimes(2));
	customNodes.resolve({
		ok: true,
		state: currentCustomNodeState({
			status: "ready",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		}),
	});
	await vi.waitFor(() => expect(session.getState().customNodes.status).toBe("ready"));
	expect(options.verify).not.toHaveBeenCalled();

	modelResync.resolve({
		ok: true,
		state: currentModelState({ status: "synced", models: [] }),
	});
	await expect(resync).resolves.toMatchObject({ ok: true });
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(options.verify).toHaveBeenCalledOnce();
	session.stop();
});

test("waits for a custom node resync started during setup preparation", async () => {
	const models =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startModels"]>>>>();
	const customNodeResync =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startCustomNodes"]>>>>();
	const startCustomNodes = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			state: currentCustomNodeState({
				status: "ready",
				nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
			}),
		})
		.mockReturnValueOnce(customNodeResync.promise);
	const { session, options } = createHarness({
		startCustomNodes,
		startModels: vi.fn().mockReturnValue(models.promise),
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(startCustomNodes).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(session.getState().customNodes.status).toBe("ready"));

	const resync = session.syncCustomNodes();
	await vi.waitFor(() => expect(startCustomNodes).toHaveBeenCalledTimes(2));
	models.resolve({
		ok: true,
		state: currentModelState({ status: "synced", models: [] }),
	});
	await vi.waitFor(() => expect(session.getState().models.status).toBe("synced"));
	expect(options.verify).not.toHaveBeenCalled();

	customNodeResync.resolve({
		ok: true,
		state: currentCustomNodeState({
			status: "ready",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		}),
	});
	await expect(resync).resolves.toMatchObject({ ok: true });
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(options.verify).toHaveBeenCalledOnce();
	session.stop();
});

test("rejects target resync requests after setup preparation completes", async () => {
	const verificationRequest =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["verify"]>>>>();
	const { session, options } = createHarness({
		verify: vi.fn().mockReturnValue(verificationRequest.promise),
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() =>
		expect(session.getState().setup).toEqual({
			status: "running",
			phase: "verification",
		}),
	);

	await expect(session.syncCustomNodes()).resolves.toEqual(setupUnavailableResult);
	await expect(session.syncModels()).resolves.toEqual(setupUnavailableResult);
	expect(options.startCustomNodes).toHaveBeenCalledOnce();
	expect(options.startModels).toHaveBeenCalledOnce();

	verificationRequest.resolve({ ok: true, state: verification });
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	session.stop();
});

test("resynchronizes and verifies without restarting ready Worker ComfyUI", async () => {
	const { session, options } = createHarness({
		readComfy: vi.fn().mockResolvedValue({ ok: true, state: { status: "ready" } }),
	});
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(session.getState().comfy.status).toBe("ready"));

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));

	expect(options.startCustomNodes).toHaveBeenCalledOnce();
	expect(options.startModels).toHaveBeenCalledOnce();
	expect(options.verify).toHaveBeenCalledOnce();
	expect(options.startComfy).not.toHaveBeenCalled();
	expect(session.getState().comfy).toEqual({ status: "ready" });
	session.stop();
});

test("starts Worker ComfyUI after custom node synchronization fails", async () => {
	const models =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startModels"]>>>>();
	const outOfSyncVerification = {
		...verification,
		status: "out-of-sync" as const,
		customNodes: {
			status: "out-of-sync" as const,
			total: 1,
			problems: [
				{
					reason: "missing" as const,
					name: "comfyui-kjnodes",
					expected: "1.5.0",
					actual: null,
				},
			],
		},
	};
	const { session, options } = createHarness({
		startCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: currentCustomNodeState({
				status: "failed",
				nodes: [],
				error: "comfyui-kjnodes could not be installed.",
			}),
		}),
		startModels: vi.fn().mockReturnValue(models.promise),
		verify: vi.fn().mockResolvedValue({ ok: true, state: outOfSyncVerification }),
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(options.startModels).toHaveBeenCalledOnce());
	expect(options.verify).not.toHaveBeenCalled();
	models.resolve({
		ok: true,
		state: currentModelState({ status: "synced", models: [] }),
	});

	await vi.waitFor(() => expect(session.getState().setup.status).toBe("failed"));
	expect(session.getState()).toMatchObject({
		comfy: { status: "ready" },
		setup: {
			status: "failed",
			phase: "preparation",
			error:
				"Worker ComfyUI started, but Worker setup is incomplete. Custom node synchronization failed. comfyui-kjnodes could not be installed.",
			verification: outOfSyncVerification,
		},
	});
	expect(options.verify).toHaveBeenCalledOnce();
	expect(options.startComfy).toHaveBeenCalledOnce();
	session.stop();
});

test("starts Worker ComfyUI after model synchronization fails", async () => {
	const outOfSyncVerification = {
		...verification,
		status: "out-of-sync" as const,
		models: {
			status: "out-of-sync" as const,
			total: 1,
			problems: [
				{
					reason: "missing" as const,
					name: "checkpoints/model.safetensors",
					expected: "selected model",
					actual: null,
				},
			],
		},
	};
	const { session, options } = createHarness({
		startModels: vi.fn().mockResolvedValue({
			ok: true,
			state: currentModelState({
				status: "failed",
				models: [],
				error: "Model provider unavailable.",
			}),
		}),
		verify: vi.fn().mockResolvedValue({ ok: true, state: outOfSyncVerification }),
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("failed"));
	expect(session.getState()).toMatchObject({
		customNodes: { status: "ready" },
		comfy: { status: "ready" },
		setup: {
			status: "failed",
			phase: "preparation",
			error:
				"Worker ComfyUI started, but Worker setup is incomplete. Model synchronization failed. Model provider unavailable.",
			verification: outOfSyncVerification,
		},
	});
	expect(options.startCustomNodes).toHaveBeenCalledOnce();
	expect(options.verify).toHaveBeenCalledOnce();
	expect(options.startComfy).toHaveBeenCalledOnce();
	session.stop();
});

test("starts models with backend preparation and waits for backend before custom nodes", async () => {
	const backend =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["prepareBackend"]>>>>();
	const models =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startModels"]>>>>();
	const prepareBackend = vi.fn().mockReturnValue(backend.promise);
	const startModels = vi.fn().mockReturnValue(models.promise);
	const { session, options } = createHarness({
		readBackend: vi.fn().mockResolvedValue({
			ok: true,
			state: { status: "not-installed", runtime },
		}),
		prepareBackend,
		startModels,
	});
	await session.initialize();
	await session.connect({
		provider: "other",
		serverUrl: SERVER_URL,
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: false,
	});
	await vi.waitFor(() =>
		expect(session.getState().backend.status).toBe("not-installed"),
	);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => {
		expect(prepareBackend).toHaveBeenCalledOnce();
		expect(startModels).toHaveBeenCalledOnce();
	});
	expect(options.startCustomNodes).not.toHaveBeenCalled();
	expect(options.verify).not.toHaveBeenCalled();

	backend.resolve({
		ok: true,
		state: { status: "ready", version: "0.33.1", runtime },
	});
	await vi.waitFor(() => expect(options.startCustomNodes).toHaveBeenCalledOnce());
	expect(options.verify).not.toHaveBeenCalled();

	models.resolve({
		ok: true,
		state: currentModelState({ status: "synced", models: [] }),
	});
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(options.verify).toHaveBeenCalledOnce();
	session.stop();
});

test("rejoins backend preparation after a retryable start response failure", async () => {
	const readBackend = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			state: { status: "not-installed", runtime },
		})
		.mockResolvedValueOnce({
			ok: true,
			state: {
				status: "preparing",
				targetVersion: "0.33.1",
				phase: "extract",
				progress: 75,
				runtime,
			},
		})
		.mockResolvedValue({
			ok: true,
			state: { status: "ready", version: "0.33.1", runtime },
		});
	const { session, options } = createHarness({
		readBackend,
		prepareBackend: vi.fn().mockResolvedValue({
			ok: false,
			error: "Could not load the Worker ComfyUI backend status.",
			retryable: true,
		}),
	});

	expect(await session.initialize()).toEqual({ ok: true });
	expect(
		await session.connect({
			provider: "other",
			serverUrl: SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: true,
		}),
	).toEqual({ ok: true });

	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(readBackend).toHaveBeenCalledTimes(3);
	expect(options.startCustomNodes).toHaveBeenCalledOnce();
	expect(options.verify).toHaveBeenCalledOnce();
	expect(options.startComfy).toHaveBeenCalledOnce();
	session.stop();
});
test("does not restart a rejoined backend preparation that failed", async () => {
	const backendFailure =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["readBackend"]>>>>();
	const readBackend = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			state: {
				status: "preparing",
				targetVersion: "0.33.1",
				phase: "download",
				progress: 25,
				runtime,
			},
		})
		.mockReturnValueOnce(backendFailure.promise);
	const { session, options } = createHarness({ readBackend });

	expect(await session.initialize()).toEqual({ ok: true });
	expect(
		await session.connect({
			provider: "other",
			serverUrl: SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: false,
		}),
	).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().backend.status).toBe("preparing"));
	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(readBackend).toHaveBeenCalledTimes(2));
	backendFailure.resolve({
		ok: true,
		state: {
			status: "failed",
			targetVersion: "0.33.1",
			error: "Backend archive download failed.",
			retryable: true,
			runtime,
		},
	});

	await vi.waitFor(() => expect(session.getState().setup.status).toBe("failed"));
	expect(session.getState().setup).toMatchObject({
		status: "failed",
		phase: "preparation",
		error: "Backend archive download failed.",
	});
	expect(options.prepareBackend).not.toHaveBeenCalled();
	expect(options.startCustomNodes).not.toHaveBeenCalled();
	expect(options.verify).not.toHaveBeenCalled();
	expect(options.startComfy).not.toHaveBeenCalled();
	session.stop();
});

test("discards a backend rejoin after disconnect", async () => {
	const backendPoll =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["readBackend"]>>>>();
	const readBackend = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			state: { status: "not-installed", runtime },
		})
		.mockReturnValueOnce(backendPoll.promise);
	const { session, options } = createHarness({
		readBackend,
		prepareBackend: vi.fn().mockResolvedValue({
			ok: false,
			error: "Could not load the Worker ComfyUI backend status.",
			retryable: true,
		}),
	});

	expect(await session.initialize()).toEqual({ ok: true });
	expect(
		await session.connect({
			provider: "other",
			serverUrl: SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: true,
		}),
	).toEqual({ ok: true });
	await vi.waitFor(() => expect(readBackend).toHaveBeenCalledTimes(2));

	expect(await session.disconnect()).toEqual({ ok: true });
	backendPoll.resolve({
		ok: true,
		state: { status: "ready", version: "0.33.1", runtime },
	});
	await backendPoll.promise;
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(session.getState()).toMatchObject({
		connection: { status: "disconnected" },
		backend: { status: "disconnected" },
		setup: { status: "idle" },
	});
	expect(options.startCustomNodes).not.toHaveBeenCalled();
	expect(options.verify).not.toHaveBeenCalled();
	expect(options.startComfy).not.toHaveBeenCalled();
	session.stop();
});

test("keeps successful verification when Worker ComfyUI startup fails", async () => {
	const { session } = createHarness({
		startComfy: vi.fn().mockResolvedValue({
			ok: false,
			error: "Worker ComfyUI failed to start.",
			retryable: false,
		}),
	});
	await initializeAndConnect(session);

	session.startSetup();
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("failed"));
	expect(session.getState()).toMatchObject({
		verification,
		setup: {
			status: "failed",
			phase: "comfy",
			verification,
		},
	});
	session.stop();
});

test("reports synchronization and Worker ComfyUI startup failures together", async () => {
	const outOfSyncVerification = {
		...verification,
		status: "out-of-sync" as const,
		models: { status: "out-of-sync" as const, total: 1, problems: [] },
	};
	const { session } = createHarness({
		startModels: vi.fn().mockResolvedValue({
			ok: true,
			state: currentModelState({
				status: "failed",
				models: [],
				error: "Model provider unavailable.",
			}),
		}),
		verify: vi.fn().mockResolvedValue({ ok: true, state: outOfSyncVerification }),
		startComfy: vi.fn().mockResolvedValue({
			ok: false,
			error: "Worker ComfyUI failed to start.",
			retryable: false,
		}),
	});
	await initializeAndConnect(session);

	session.startSetup();
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("failed"));
	expect(session.getState().setup).toEqual({
		status: "failed",
		phase: "comfy",
		error:
			"Model synchronization failed. Model provider unavailable. Worker ComfyUI could not start. Worker ComfyUI failed to start.",
		verification: outOfSyncVerification,
	});
	session.stop();
});

test("reports a rejected lifecycle request as a setup failure", async () => {
	const { session, options } = createHarness({
		verify: vi.fn().mockRejectedValue(new Error("Worker verification request failed.")),
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() =>
		expect(session.getState().setup).toEqual({
			status: "failed",
			phase: "verification",
			error:
				"Worker ComfyUI started, but Worker setup is incomplete. Worker verification request failed.",
		}),
	);
	expect(options.startComfy).toHaveBeenCalledOnce();
	await session.stop();
});

test("keeps backend readiness separate from Worker ComfyUI readiness", async () => {
	const { session } = createHarness();
	await initializeAndConnect(session);

	expect(session.getState()).toMatchObject({
		backend: { status: "ready", version: "0.33.1", editorComfyVersion: "0.33.1" },
		comfy: { status: "stopped" },
	});
	session.stop();
});

test("does not wait for system metrics before running Worker setup", async () => {
	const metrics = deferred<{
		ok: true;
		state: typeof systemMetrics;
	}>();
	const { session, options } = createHarness({
		readSystemMetrics: vi.fn().mockReturnValue(metrics.promise),
	});
	expect(await session.initialize()).toEqual({ ok: true });

	expect(
		await session.connect({
			provider: "other",
			serverUrl: SERVER_URL,
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: true,
		}),
	).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(session.getState().systemMetrics).toEqual({ status: "loading" });
	expect(options.verify).toHaveBeenCalledOnce();
	expect(options.startComfy).toHaveBeenCalledOnce();

	await session.disconnect();
	metrics.resolve({ ok: true, state: systemMetrics });
	await metrics.promise;
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(session.getState().systemMetrics).toEqual({ status: "disconnected" });
	session.stop();
});

test("skips model synchronization when no model is selected", async () => {
	const { session, options } = createHarness(
		{
			readModels: vi.fn().mockResolvedValue({
				ok: true,
				state: currentModelState({ status: "canceled", models: [] }),
			}),
		},
		{ shouldSyncModels: () => false },
	);
	await initializeAndConnect(session);

	session.startSetup();
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(options.startModels).not.toHaveBeenCalled();
	expect(options.startCustomNodes).toHaveBeenCalledOnce();
	session.stop();
});

test("keeps the setup model decision stable when the selection changes", async () => {
	let modelsSelected = false;
	const customNodes =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startCustomNodes"]>>>>();
	const { session, options } = createHarness(
		{
			startCustomNodes: vi.fn().mockReturnValue(customNodes.promise),
		},
		{ shouldSyncModels: () => modelsSelected },
	);
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(options.startCustomNodes).toHaveBeenCalledOnce());
	expect(options.startModels).not.toHaveBeenCalled();
	modelsSelected = true;
	customNodes.resolve({
		ok: true,
		state: currentCustomNodeState({
			status: "ready",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		}),
	});

	await vi.waitFor(() => expect(session.getState().setup.status).not.toBe("running"));
	expect(session.getState().setup).toMatchObject({ status: "succeeded" });
	expect(options.startModels).not.toHaveBeenCalled();
	expect(options.verify).toHaveBeenCalledOnce();
	await session.stop();
});

test("waits for active model work even when no model is selected", async () => {
	const readModels = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			state: currentModelState({
				status: "checking",
				total: 1,
				totalBytes: 100,
			}),
		})
		.mockResolvedValueOnce({
			ok: true,
			state: currentModelState({ status: "canceled", models: [] }),
		});
	const { session, options } = createHarness(
		{ readModels },
		{ shouldSyncModels: () => false },
	);
	await initializeAndConnect(session);

	session.startSetup();
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(readModels).toHaveBeenCalledTimes(2);
	expect(options.startModels).not.toHaveBeenCalled();
	session.stop();
});

test("polls a retryable Worker ComfyUI start until it is ready", async () => {
	const readComfy = vi
		.fn()
		.mockResolvedValueOnce({ ok: true, state: { status: "stopped" } })
		.mockResolvedValueOnce({ ok: true, state: { status: "starting" } })
		.mockResolvedValueOnce({ ok: true, state: { status: "ready" } });
	const { session } = createHarness({
		readComfy,
		startComfy: vi.fn().mockResolvedValue({
			ok: false,
			error: "Worker ComfyUI is still starting.",
			retryable: true,
		}),
	});
	await initializeAndConnect(session);

	session.startSetup();
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(readComfy).toHaveBeenCalledTimes(3);
	session.stop();
});

test("stops setup when either parallel target is canceled", async () => {
	const { session, options } = createHarness({
		startCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: currentCustomNodeState({ status: "canceled", nodes: [] }),
		}),
	});
	await initializeAndConnect(session);

	session.startSetup();
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("canceled"));
	expect(options.verify).not.toHaveBeenCalled();
	expect(options.startComfy).not.toHaveBeenCalled();
	session.stop();
});

test("cancels active setup synchronization and blocks resyncs", async () => {
	const modelCancellation =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["cancelModels"]>>>>();
	const { session, options } = createHarness({
		...syncingSetupOptions(),
		cancelModels: vi.fn().mockReturnValue(modelCancellation.promise),
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => {
		expect(session.getState().customNodes.status).toBe("syncing");
		expect(session.getState().models.status).toBe("syncing");
	});

	const cancellation = session.cancelSetup();
	await vi.waitFor(() => {
		expect(options.cancelCustomNodes).toHaveBeenCalledOnce();
		expect(options.cancelModels).toHaveBeenCalledOnce();
		expect(session.getState().customNodes.status).toBe("canceled");
	});

	await expect(session.syncCustomNodes()).resolves.toEqual(setupUnavailableResult);
	await expect(session.syncModels()).resolves.toEqual(setupUnavailableResult);
	expect(options.startCustomNodes).toHaveBeenCalledOnce();
	expect(options.startModels).toHaveBeenCalledOnce();

	modelCancellation.resolve({
		ok: true,
		state: currentModelState({ status: "canceled", models: [] }),
	});
	await expect(cancellation).resolves.toEqual({ ok: true });
	expect(session.getState().setup).toEqual({ status: "canceled" });
	expect(options.verify).not.toHaveBeenCalled();
	expect(options.startComfy).not.toHaveBeenCalled();
	session.stop();
});

test("cancels model synchronization after Worker ComfyUI becomes ready", async () => {
	const { session, options } = createHarness({
		startModels: vi.fn().mockResolvedValue({
			ok: true,
			state: syncingModelState(),
		}),
		pollMs: 60_000,
	});
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() =>
		expect(session.getState()).toMatchObject({
			comfy: { status: "ready" },
			models: { status: "syncing" },
			setup: { status: "running", phase: "preparation" },
		}),
	);

	await expect(session.cancelSetup()).resolves.toEqual({ ok: true });
	expect(options.cancelModels).toHaveBeenCalledOnce();
	expect(options.cancelCustomNodes).not.toHaveBeenCalled();
	expect(options.verify).not.toHaveBeenCalled();
	expect(session.getState()).toMatchObject({
		comfy: { status: "ready" },
		models: { status: "canceled" },
		setup: { status: "canceled" },
	});
	await session.stop();
});

test("waits for a starting setup target and cancels it too", async () => {
	const plan = deferred<CustomNodeSyncPlan>();
	const buildCustomNodeSyncPlan = vi
		.fn()
		.mockResolvedValueOnce({
			managerVersion: CUSTOM_NODE_TARGET.managerVersion,
			nodes: CUSTOM_NODE_TARGET.nodes,
			unsupportedNodes: [],
		})
		.mockReturnValueOnce(plan.promise);
	const { session, options } = createHarness(syncingSetupOptions(), {
		buildCustomNodeSyncPlan,
	});
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(buildCustomNodeSyncPlan).toHaveBeenCalledOnce());

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => {
		expect(buildCustomNodeSyncPlan).toHaveBeenCalledTimes(2);
		expect(session.getState().customNodes.status).toBe("loading");
		expect(session.getState().models.status).toBe("syncing");
	});

	const cancellation = session.cancelSetup();
	await vi.waitFor(() => expect(options.cancelModels).toHaveBeenCalledOnce());
	expect(options.cancelCustomNodes).not.toHaveBeenCalled();
	plan.resolve({
		managerVersion: CUSTOM_NODE_TARGET.managerVersion,
		nodes: CUSTOM_NODE_TARGET.nodes,
		unsupportedNodes: [],
	});

	expect(await cancellation).toEqual({ ok: true });
	expect(options.cancelCustomNodes).toHaveBeenCalledOnce();
	expect(session.getState().setup).toEqual({ status: "canceled" });
	expect(options.verify).not.toHaveBeenCalled();
	expect(options.startComfy).not.toHaveBeenCalled();
	session.stop();
});

test("attempts every setup cancellation and reports partial failure", async () => {
	const { session, options } = createHarness({
		startCustomNodes: vi.fn().mockResolvedValue({
			ok: true,
			state: syncingCustomNodeState(),
		}),
		startModels: vi.fn().mockResolvedValue({
			ok: true,
			state: currentModelState({
				status: "checking",
				total: 1,
				totalBytes: 1,
			}),
		}),
		cancelCustomNodes: vi.fn().mockResolvedValue({
			ok: false,
			error: "Worker rejected custom node cancellation.",
		}),
		pollMs: 60_000,
	});
	await initializeAndConnect(session);

	session.startSetup();
	await vi.waitFor(() => {
		expect(session.getState().customNodes.status).toBe("syncing");
		expect(session.getState().models.status).toBe("checking");
	});

	const result = await session.cancelSetup();
	expect(result).toEqual({
		ok: false,
		error:
			"Worker setup stopped, but synchronization cancellation failed. Custom node synchronization: Worker rejected custom node cancellation.",
	});
	expect(options.cancelCustomNodes).toHaveBeenCalledOnce();
	expect(options.cancelModels).toHaveBeenCalledOnce();
	expect(session.getState().setup).toMatchObject({
		status: "failed",
		phase: "preparation",
	});
	expect(options.verify).not.toHaveBeenCalled();
	expect(options.startComfy).not.toHaveBeenCalled();
	session.stop();
});

test("does not resume setup when backend preparation finishes after cancellation", async () => {
	const backend =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["prepareBackend"]>>>>();
	const { session, options } = createHarness({
		readBackend: vi.fn().mockResolvedValue({
			ok: true,
			state: { status: "not-installed", runtime },
		}),
		prepareBackend: vi.fn().mockReturnValue(backend.promise),
		startModels: vi.fn().mockResolvedValue({
			ok: true,
			state: syncingModelState(),
		}),
		pollMs: 60_000,
	});
	await session.initialize();
	await session.connect({
		provider: "other",
		serverUrl: SERVER_URL,
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: false,
	});
	await vi.waitFor(() =>
		expect(session.getState().backend.status).toBe("not-installed"),
	);

	session.startSetup();
	await vi.waitFor(() => {
		expect(options.prepareBackend).toHaveBeenCalledOnce();
		expect(session.getState().models.status).toBe("syncing");
	});
	expect(await session.cancelSetup()).toEqual({ ok: true });

	backend.resolve({
		ok: true,
		state: { status: "ready", version: "0.33.1", runtime },
	});
	await backend.promise;
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(session.getState().setup).toEqual({ status: "canceled" });
	expect(options.startCustomNodes).not.toHaveBeenCalled();
	expect(options.verify).not.toHaveBeenCalled();
	expect(options.startComfy).not.toHaveBeenCalled();
	session.stop();
});

test("returns a replacement result when a newer request aborts active Worker work", async () => {
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
		startCustomNodes: vi.fn(
			async (_credential, _managerVersion, _nodes, requestFetch) => {
				await requestFetch("https://worker.example.com/custom-nodes");
				return {
					ok: true as const,
					state: currentCustomNodeState({ status: "ready" as const, nodes: [] }),
				};
			},
		),
	});

	try {
		await initializeAndConnect(session);
		const active = session.syncCustomNodes();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(await session.cancelCustomNodes()).toMatchObject({
			ok: true,
			state: { status: "canceled" },
		});
		expect(await active).toEqual({
			ok: false,
			error: "A newer Worker custom node request replaced this one.",
		});
	} finally {
		session.stop();
		vi.unstubAllGlobals();
	}
});

test("does not retain verification completed after Worker inputs change", async () => {
	const verificationResult =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["verify"]>>>>();
	const { session, options } = createHarness({
		verify: vi.fn().mockReturnValue(verificationResult.promise),
	});
	await initializeAndConnect(session);

	const pendingVerification = session.verify();
	await vi.waitFor(() => expect(options.verify).toHaveBeenCalled());
	expect(await session.syncCustomNodes()).toMatchObject({ ok: true });
	verificationResult.resolve({ ok: true, state: verification });

	expect(await pendingVerification).toEqual({
		ok: false,
		error: "A newer Worker verification replaced this one.",
	});
	expect(session.getState().verification).toBeNull();
	session.stop();
});

test("does not retry a backend rejected by the fixed Worker runtime", async () => {
	const prepareBackend = vi.fn().mockResolvedValue({
		ok: true,
		state: {
			status: "failed",
			targetVersion: "0.33.1",
			error: "Worker runtime is incompatible.",
			retryable: false,
			runtime,
		},
	});
	const { session, options } = createHarness({
		readBackend: vi.fn().mockResolvedValue({
			ok: true,
			state: { status: "not-installed", runtime },
		}),
		prepareBackend,
	});
	await session.initialize();
	await session.connect({
		provider: "other",
		serverUrl: SERVER_URL,
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: false,
	});
	await vi.waitFor(() =>
		expect(session.getState().backend.status).toBe("not-installed"),
	);

	session.startSetup();
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("failed"));
	expect(session.getState().setup).toMatchObject({
		status: "failed",
		phase: "preparation",
		error: "Worker runtime is incompatible.",
	});
	expect(prepareBackend).toHaveBeenCalledOnce();
	expect(options.startCustomNodes).not.toHaveBeenCalled();
	expect(options.startModels).toHaveBeenCalledOnce();
	session.stop();
});

test("rejoins Worker target work that won the start race and retries the current plan", async () => {
	const readCustomNodes = vi
		.fn()
		.mockResolvedValueOnce({ ok: true, state: currentCustomNodeIdleState() })
		.mockResolvedValueOnce({
			ok: true,
			state: currentCustomNodeState({ status: "ready", nodes: [] }),
		});
	const startCustomNodes = vi
		.fn()
		.mockResolvedValueOnce({
			ok: false,
			error: "Custom nodes are already synchronizing.",
		})
		.mockResolvedValueOnce({
			ok: true,
			state: currentCustomNodeState({ status: "ready", nodes: [] }),
		});
	const { session } = createHarness({ readCustomNodes, startCustomNodes });
	await initializeAndConnect(session);

	session.startSetup();
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(startCustomNodes).toHaveBeenCalledTimes(2);
	session.stop();
});

test("retries model synchronization after the Worker provisioner finishes initializing", async () => {
	const readModels = vi.fn().mockResolvedValue({
		ok: true,
		state: currentModelIdleState(),
	});
	const startModels = vi
		.fn()
		.mockResolvedValueOnce({
			ok: false,
			error: "Model synchronization is still initializing.",
			retryable: true,
		})
		.mockResolvedValueOnce({
			ok: true,
			state: currentModelState({ status: "synced", models: [] }),
		});
	const { session } = createHarness({ readModels, startModels });
	await initializeAndConnect(session);

	session.startSetup();
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("succeeded"));
	expect(startModels).toHaveBeenCalledTimes(2);
	session.stop();
});

test("fails setup when a rejoined target poll returns a non-retryable error", async () => {
	const readCustomNodes = vi
		.fn()
		.mockResolvedValueOnce({ ok: true, state: { status: "idle", nodes: [] } })
		.mockResolvedValueOnce({
			ok: false,
			error: "Worker authentication failed.",
			retryable: false,
		});
	const startCustomNodes = vi.fn().mockResolvedValue({
		ok: false,
		error: "Custom nodes are already synchronizing.",
	});
	const { session, options } = createHarness({ readCustomNodes, startCustomNodes });
	await initializeAndConnect(session);

	expect(session.startSetup()).toEqual({ ok: true });
	await vi.waitFor(() => expect(session.getState().setup.status).toBe("failed"));
	expect(session.getState()).toMatchObject({
		customNodes: {
			status: "unavailable",
			error: "Worker authentication failed.",
			retryable: false,
		},
		setup: {
			status: "failed",
			phase: "preparation",
			error:
				"Worker ComfyUI started, but Worker setup is incomplete. Custom node synchronization failed. Worker authentication failed.",
		},
	});
	expect(options.startModels).toHaveBeenCalledOnce();
	expect(options.verify).toHaveBeenCalledOnce();
	expect(options.startComfy).toHaveBeenCalledOnce();
	session.stop();
});

test("discards setup work completed after disconnect", async () => {
	const customNodes =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startCustomNodes"]>>>>();
	const models =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startModels"]>>>>();
	const { session, options } = createHarness({
		startCustomNodes: vi.fn().mockReturnValue(customNodes.promise),
		startModels: vi.fn().mockReturnValue(models.promise),
	});
	await initializeAndConnect(session);
	session.startSetup();
	await vi.waitFor(() =>
		expect(session.getState().setup).toEqual({
			status: "running",
			phase: "preparation",
		}),
	);

	await session.disconnect();
	customNodes.resolve({
		ok: true,
		state: currentCustomNodeState({ status: "ready", nodes: [] }),
	});
	models.resolve({
		ok: true,
		state: currentModelState({ status: "synced", models: [] }),
	});
	await Promise.all([customNodes.promise, models.promise]);

	expect(session.getState()).toMatchObject({
		connection: { status: "disconnected", recentServerUrl: SERVER_URL },
		setup: { status: "idle" },
		verification: null,
	});
	expect(options.verify).not.toHaveBeenCalled();
	expect(options.startComfy).not.toHaveBeenCalled();
	session.stop();
});

test("discards setup work completed after the Worker goes offline", async () => {
	const customNodes =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startCustomNodes"]>>>>();
	const models =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["startModels"]>>>>();
	const probeResult =
		deferred<Awaited<ReturnType<NonNullable<SessionOptions["probe"]>>>>();
	const { session } = createHarness({
		startCustomNodes: vi.fn().mockReturnValue(customNodes.promise),
		startModels: vi.fn().mockReturnValue(models.promise),
		probe: vi.fn().mockReturnValue(probeResult.promise),
		recheckMs: 1,
	});
	await initializeAndConnect(session);
	session.startSetup();
	await vi.waitFor(() =>
		expect(session.getState().setup).toEqual({
			status: "running",
			phase: "preparation",
		}),
	);

	probeResult.resolve({ status: "offline", error: "Worker unavailable." });
	await vi.waitFor(() => expect(session.getState().connection.status).toBe("offline"));
	customNodes.resolve({
		ok: true,
		state: currentCustomNodeState({ status: "ready", nodes: [] }),
	});
	models.resolve({
		ok: true,
		state: currentModelState({ status: "synced", models: [] }),
	});
	await Promise.all([customNodes.promise, models.promise]);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(session.getState()).toMatchObject({
		connection: { status: "offline", serverUrl: SERVER_URL },
		customNodes: { status: "disconnected" },
		models: { status: "disconnected" },
		setup: { status: "idle" },
		verification: null,
	});
	session.stop();
});

test("reports the Worker as out of sync after the ComfyUI selection changes", async () => {
	let editorVersion = "0.33.1";
	const { session } = createHarness(
		{},
		{
			getBackendTarget: () => ({
				version: editorVersion,
				archiveUrl: `https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v${editorVersion}.zip`,
				sha256: "a".repeat(64),
			}),
		},
	);
	await initializeAndConnect(session);
	await session.prepareBackend();
	await vi.waitFor(() => expect(session.getState().backend.status).toBe("ready"));
	expect(session.getState().backend.editorComfyVersion).toBe("0.33.1");

	editorVersion = "0.34.0";
	session.refreshEditorComfyVersion();

	const { backend, verification } = session.getState();
	expect(backend).toMatchObject({ status: "ready", editorComfyVersion: "0.34.0" });
	expect(backend.status === "ready" && backend.version).toBe("0.33.1");
	expect(verification).toBeNull();
});
