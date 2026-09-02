import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { connectedState, createDesktopApiMock } from "./desktop-api-mock";
import {
	activateStoryDesktopApiMock,
	configureStoryServerLogs,
	configureStoryWorker,
	useConfigureStoryWorker,
} from "./stories/desktop-api-mock";

test("isolates mutable state and listeners between Desktop API mocks", async () => {
	const first = createDesktopApiMock();
	const second = createDesktopApiMock();
	const listener = vi.fn();
	const unsubscribe = first.api.workerSession.onStateChange(listener);

	second.emitConnection(connectedState());
	expect(listener).not.toHaveBeenCalled();
	expect((await first.api.workerSession.getSnapshot()).state.connection.status).toBe(
		"disconnected",
	);
	expect((await second.api.workerSession.getSnapshot()).state.connection.status).toBe(
		"connected",
	);

	first.emitConnection(connectedState());
	expect(listener).toHaveBeenCalledOnce();
	unsubscribe();
	first.emitConnection({
		status: "disconnected",
		recentProvider: null,
		recentServerUrl: null,
	});
	expect(listener).toHaveBeenCalledOnce();

	first.setServerLogsResult({ ok: false, error: "Unavailable." });
	expect(await first.api.connection.getLogs()).toEqual({
		ok: false,
		error: "Unavailable.",
	});
	expect(await second.api.connection.getLogs()).toEqual({
		ok: true,
		logs: [],
		truncated: false,
	});
});

test("retains a configured mock within a story and isolates the next story", async () => {
	const environment = globalThis as typeof globalThis & {
		kastard: ReturnType<typeof createDesktopApiMock>["api"];
	};
	activateStoryDesktopApiMock("desktop-api-mock-first");
	const firstApi = environment.kastard;
	const firstListener = vi.fn();
	firstApi.workerSession.onStateChange(firstListener);

	activateStoryDesktopApiMock("desktop-api-mock-first");
	expect(environment.kastard).toBe(firstApi);
	configureStoryWorker(connectedState());
	expect(firstListener).toHaveBeenCalledWith(
		expect.objectContaining({ revision: 1, type: "session.reset" }),
	);

	activateStoryDesktopApiMock("desktop-api-mock-second");
	const secondApi = environment.kastard;
	configureStoryWorker(connectedState());
	configureStoryServerLogs({ ok: false, error: "Unavailable." });

	expect(secondApi).not.toBe(firstApi);
	expect((await secondApi.workerSession.getSnapshot()).state.connection.status).toBe(
		"connected",
	);
	expect(await secondApi.connection.getLogs()).toEqual({
		ok: false,
		error: "Unavailable.",
	});
	expect(await secondApi.workerSession.retry()).toEqual({ ok: true });
	expect(await secondApi.connection.copyServerLogs("Worker log")).toEqual({ ok: true });
	expect((await firstApi.workerSession.getSnapshot()).state.connection.status).toBe(
		"connected",
	);
	expect(firstListener).toHaveBeenCalledOnce();
});

test("keeps Worker session revisions monotonic across story configuration", async () => {
	const desktopApiMock = createDesktopApiMock();
	await desktopApiMock.api.workerSession.connect({
		provider: "other",
		serverUrl: "worker.example.com:22001",
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: true,
	});
	desktopApiMock.setWorkerSessionState(
		(await createDesktopApiMock().api.workerSession.getSnapshot()).state,
	);
	await desktopApiMock.api.workerSession.disconnect();

	expect((await desktopApiMock.api.workerSession.getSnapshot()).revision).toBe(3);
});

test("publishes story Worker configuration after render", () => {
	const environment = globalThis as typeof globalThis & {
		kastard: ReturnType<typeof createDesktopApiMock>["api"];
	};
	activateStoryDesktopApiMock("desktop-api-mock-after-render");
	let rendering = false;
	const listener = vi.fn(() => expect(rendering).toBe(false));
	environment.kastard.workerSession.onStateChange(listener);
	const connection = connectedState();

	renderHook(() => {
		rendering = true;
		useConfigureStoryWorker(connection);
		rendering = false;
	});

	expect(listener).toHaveBeenCalledOnce();
});
