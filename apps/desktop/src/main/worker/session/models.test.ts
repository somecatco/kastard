// @vitest-environment node

import { expect, test, vi } from "vitest";
import type {
	ModelSyncFileState,
	ModelSyncRequest,
	ModelSyncServerState,
	ModelSyncTarget,
} from "../../../shared/api";
import {
	createHarness,
	initializeAndConnect,
	type SessionOptions,
	WORKER_ENDPOINT,
} from "./test-harness";

const FIRST_MODEL = modelTarget("first", "huggingface");
const SECOND_MODEL = modelTarget("second", "civitai");
const MODEL_REQUEST: ModelSyncRequest = {
	models: [FIRST_MODEL, SECOND_MODEL],
	credentials: {
		huggingface: "huggingface-token",
		civitai: "civitai-token",
	},
};

test("projects the current Editor target from a Worker model snapshot", async () => {
	const { session } = createHarness(
		{ readModels: vi.fn().mockResolvedValue({ ok: true, state: idleModelState() }) },
		{ buildModelSyncPlan: async () => MODEL_REQUEST },
	);

	await initializeAndConnect(session);
	await vi.waitFor(() =>
		expect(session.getState().models).toMatchObject({
			status: "idle",
			targetStatus: "current",
			targetModels: [
				{ target: FIRST_MODEL, status: "ready", downloadedBytes: 10 },
				{ target: SECOND_MODEL, status: "needs-redownload", downloadedBytes: 0 },
			],
		}),
	);
	session.stop();
});

test("refreshes Editor model metadata without resetting Worker statuses", async () => {
	let request = MODEL_REQUEST;
	const renamed = { ...FIRST_MODEL, name: "Renamed first model" };
	const { session } = createHarness(
		{ readModels: vi.fn().mockResolvedValue({ ok: true, state: idleModelState() }) },
		{ buildModelSyncPlan: async () => request },
	);

	await initializeAndConnect(session);
	await vi.waitFor(() =>
		expect(session.getState().models).toMatchObject({
			targetModels: [
				{ target: FIRST_MODEL, status: "ready", downloadedBytes: 10 },
				{ target: SECOND_MODEL, status: "needs-redownload", downloadedBytes: 0 },
			],
		}),
	);
	request = { ...MODEL_REQUEST, models: [renamed, SECOND_MODEL] };
	session.refreshEditorModelTarget();

	await vi.waitFor(() =>
		expect(session.getState().models).toMatchObject({
			targetStatus: "current",
			targetModels: [
				{ target: renamed, status: "ready", downloadedBytes: 10 },
				{ target: SECOND_MODEL, status: "needs-redownload", downloadedBytes: 0 },
			],
		}),
	);
	session.stop();
});

test("shows the current Editor model list for a fresh Worker", async () => {
	const { session } = createHarness(
		{
			readModels: vi.fn().mockResolvedValue({
				ok: true,
				state: {
					contractVersion: 2,
					capabilities: { forceRedownload: true },
					target: null,
					operationId: null,
					status: "idle",
					models: null,
				},
			}),
		},
		{ buildModelSyncPlan: async () => MODEL_REQUEST },
	);

	await initializeAndConnect(session);
	await vi.waitFor(() =>
		expect(session.getState().models).toMatchObject({
			status: "idle",
			targetStatus: "unknown",
			targetModels: [
				{ target: FIRST_MODEL, status: "not-downloaded", downloadedBytes: 0 },
				{ target: SECOND_MODEL, status: "not-downloaded", downloadedBytes: 0 },
			],
		}),
	);
	session.stop();
});

test("merges a restored force redownload row into the current Editor model list", async () => {
	const restoredRedownload = modelOperationState(
		"redownload",
		[FIRST_MODEL],
		{ status: "synced", models: [FIRST_MODEL] },
		[{ path: FIRST_MODEL.path, status: "ready", downloadedBytes: 10 }],
	);
	const { session } = createHarness(
		{
			readModels: vi.fn().mockResolvedValue({ ok: true, state: restoredRedownload }),
		},
		{ buildModelSyncPlan: async () => MODEL_REQUEST },
	);

	await initializeAndConnect(session);
	await vi.waitFor(() =>
		expect(session.getState().models).toMatchObject({
			status: "synced",
			targetStatus: "current",
			targetModels: [
				{ target: FIRST_MODEL, status: "ready", downloadedBytes: 10 },
				{ target: SECOND_MODEL, status: "not-downloaded", downloadedBytes: 0 },
			],
		}),
	);
	session.stop();
});

test("keeps a stale Worker snapshot out of the current Editor model list", async () => {
	const stale = modelOperationState(
		"sync",
		[FIRST_MODEL],
		{ status: "synced", models: [FIRST_MODEL] },
		[{ path: FIRST_MODEL.path, status: "ready", downloadedBytes: 10 }],
	);
	const { session } = createHarness(
		{ readModels: vi.fn().mockResolvedValue({ ok: true, state: stale }) },
		{
			buildModelSyncPlan: async () => ({
				models: [SECOND_MODEL],
				credentials: {},
			}),
		},
	);

	await initializeAndConnect(session);
	await vi.waitFor(() =>
		expect(session.getState().models).toMatchObject({
			status: "synced",
			targetStatus: "stale",
			targetModels: [
				{ target: SECOND_MODEL, status: "not-downloaded", downloadedBytes: 0 },
			],
		}),
	);
	session.stop();
});

test("force redownload sends only the selected model credential and merges its row", async () => {
	const redownloadModel = vi.fn<NonNullable<SessionOptions["redownloadModel"]>>(
		async (_credential, request) => ({
			ok: true,
			state: modelOperationState(
				"redownload",
				request.models,
				{
					status: "checking",
					total: 1,
					totalBytes: request.models[0]?.artifact.sizeBytes ?? 0,
				},
				[{ path: FIRST_MODEL.path, status: "not-downloaded", downloadedBytes: 0 }],
			),
		}),
	);
	const { session } = createHarness(
		{
			readModels: vi.fn().mockResolvedValue({ ok: true, state: idleModelState() }),
			redownloadModel,
		},
		{ buildModelSyncPlan: async () => MODEL_REQUEST },
	);
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(session.getState().models.status).toBe("idle"));

	await expect(session.redownloadModel(FIRST_MODEL.path)).resolves.toMatchObject({
		ok: true,
		state: {
			targetStatus: "current",
			targetModels: [
				{ target: FIRST_MODEL, status: "redownloading", downloadedBytes: 0 },
				{ target: SECOND_MODEL, status: "needs-redownload", downloadedBytes: 0 },
			],
		},
	});
	expect(redownloadModel).toHaveBeenCalledWith(
		expect.objectContaining({ serverUrl: WORKER_ENDPOINT }),
		{
			models: [FIRST_MODEL],
			credentials: { huggingface: "huggingface-token" },
		},
		expect.any(Function),
	);
	session.stop();
});

test("preserves the confirmed model state when force redownload is rejected", async () => {
	const error = "Worker models cannot be redownloaded while a workflow is running.";
	const { session } = createHarness(
		{
			readModels: vi.fn().mockResolvedValue({ ok: true, state: idleModelState() }),
			redownloadModel: vi.fn().mockResolvedValue({
				ok: false,
				error,
				retryable: false,
			}),
		},
		{ buildModelSyncPlan: async () => MODEL_REQUEST },
	);
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(session.getState().models.status).toBe("idle"));
	const confirmed = session.getState().models;

	await expect(session.redownloadModel(FIRST_MODEL.path)).resolves.toEqual({
		ok: false,
		error,
		retryable: false,
	});
	expect(session.getState().models).toEqual(confirmed);
	session.stop();
});

test("projects a failed force redownload without restoring the removed model", async () => {
	const error = "Provider download failed.";
	const { session } = createHarness(
		{
			readModels: vi.fn().mockResolvedValue({ ok: true, state: idleModelState() }),
			redownloadModel: vi.fn().mockResolvedValue({
				ok: true,
				state: modelOperationState(
					"redownload",
					[FIRST_MODEL],
					{ status: "failed", models: [], total: 1, error },
					[
						{
							path: FIRST_MODEL.path,
							status: "not-downloaded",
							downloadedBytes: 0,
							error,
						},
					],
				),
			}),
		},
		{ buildModelSyncPlan: async () => MODEL_REQUEST },
	);
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(session.getState().models.status).toBe("idle"));

	await expect(session.redownloadModel(FIRST_MODEL.path)).resolves.toMatchObject({
		ok: true,
		state: {
			status: "failed",
			targetModels: [
				{
					target: FIRST_MODEL,
					status: "redownload-failed",
					downloadedBytes: 0,
					error,
				},
				{ target: SECOND_MODEL, status: "needs-redownload" },
			],
		},
	});
	session.stop();
});

test("revalidates the Editor selection before force redownload", async () => {
	const buildModelSyncPlan = vi
		.fn()
		.mockResolvedValueOnce(MODEL_REQUEST)
		.mockResolvedValueOnce({ models: [SECOND_MODEL], credentials: {} });
	const redownloadModel = vi.fn();
	const { session } = createHarness(
		{
			readModels: vi.fn().mockResolvedValue({ ok: true, state: idleModelState() }),
			redownloadModel,
		},
		{ buildModelSyncPlan },
	);
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(session.getState().models.status).toBe("idle"));

	await expect(session.redownloadModel(FIRST_MODEL.path)).resolves.toEqual({
		ok: false,
		error: "The selected model is no longer part of the Editor sync target.",
	});
	expect(redownloadModel).not.toHaveBeenCalled();
	session.stop();
});

test("cancels a stale model operation by its exact operation id", async () => {
	let request = MODEL_REQUEST;
	const active = modelOperationState(
		"sync",
		MODEL_REQUEST.models,
		{
			status: "syncing",
			completed: 0,
			total: 2,
			completedBytes: 0,
			totalBytes: 20,
			present: 0,
			active: [FIRST_MODEL.path],
		},
		[
			{ path: FIRST_MODEL.path, status: "downloading", downloadedBytes: 0 },
			{ path: SECOND_MODEL.path, status: "not-downloaded", downloadedBytes: 0 },
		],
	);
	const cancelModels = vi.fn<NonNullable<SessionOptions["cancelModels"]>>(
		async (_credential, _operationId) => ({
			ok: true,
			state: modelOperationState(
				"sync",
				MODEL_REQUEST.models,
				{ status: "canceling" },
				[
					{ path: FIRST_MODEL.path, status: "downloading", downloadedBytes: 0 },
					{ path: SECOND_MODEL.path, status: "not-downloaded", downloadedBytes: 0 },
				],
			),
		}),
	);
	const { session } = createHarness(
		{
			readModels: vi.fn().mockResolvedValue({ ok: true, state: active }),
			cancelModels,
		},
		{ buildModelSyncPlan: async () => request },
	);
	await initializeAndConnect(session);
	await vi.waitFor(() => expect(session.getState().models.status).toBe("syncing"));

	request = { models: [SECOND_MODEL], credentials: {} };
	session.refreshEditorModelTarget();
	await vi.waitFor(() => expect(cancelModels).toHaveBeenCalledOnce());
	expect(cancelModels).toHaveBeenCalledWith(
		expect.objectContaining({ serverUrl: WORKER_ENDPOINT }),
		"model-operation",
		expect.any(Function),
	);
	session.stop();
});

function modelTarget(
	name: string,
	provider: "huggingface" | "civitai",
): ModelSyncTarget {
	return {
		name,
		path: `checkpoints/${name}.safetensors`,
		artifact: {
			provider,
			modelId: provider === "civitai" ? "1" : "owner/repository",
			versionId: provider === "civitai" ? "2" : "a".repeat(40),
			versionLabel: "version",
			fileId: provider === "civitai" ? "3" : `${name}.safetensors`,
			fileName: `${name}.safetensors`,
			sizeBytes: 10,
		},
	};
}

function idleModelState(): ModelSyncServerState {
	return {
		contractVersion: 2,
		capabilities: { forceRedownload: true },
		target: { models: MODEL_REQUEST.models },
		operationId: null,
		status: "idle",
		models: MODEL_REQUEST.models,
		modelSnapshot: {
			models: [
				{ path: FIRST_MODEL.path, status: "ready", downloadedBytes: 10 },
				{
					path: SECOND_MODEL.path,
					status: "needs-redownload",
					downloadedBytes: 0,
				},
			],
		},
	};
}

function modelOperationState(
	kind: "sync" | "redownload",
	models: ModelSyncTarget[],
	state: {
		status: "checking" | "syncing" | "canceling" | "canceled" | "synced" | "failed";
		[key: string]: unknown;
	},
	snapshot: ModelSyncFileState[],
): ModelSyncServerState {
	return {
		...state,
		contractVersion: 2,
		capabilities: { forceRedownload: true },
		target: { models },
		operationId: "model-operation",
		operationKind: kind,
		modelSnapshot: { models: snapshot },
	} as ModelSyncServerState;
}
