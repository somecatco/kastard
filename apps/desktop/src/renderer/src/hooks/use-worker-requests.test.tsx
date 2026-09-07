import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { connectedState, emitConnection } from "@/App.test-harness";
import { ConnectionProvider } from "@/components/connection/ConnectionProvider";
import type { ConnectionResult, WorkerCustomNodeSyncResult } from "../../../shared/api";
import { useConnectionRequests } from "./use-connection-requests";
import { useNodesRequests } from "./use-worker-nodes-requests";

function wrapper({ children }: { children: ReactNode }) {
	return <ConnectionProvider closeRequest={0}>{children}</ConnectionProvider>;
}
function deferred<Value>() {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("retains the current request pending and error when an earlier connection replies late", async () => {
	const first = deferred<WorkerCustomNodeSyncResult>();
	const second = deferred<WorkerCustomNodeSyncResult>();
	vi.mocked(window.kastard.workerSession.syncCustomNodes)
		.mockReturnValueOnce(first.promise)
		.mockReturnValueOnce(second.promise);
	const { result } = renderHook(useNodesRequests, { wrapper });
	await act(async () => emitConnection(connectedState()));
	let previous!: Promise<void>;
	act(() => {
		previous = result.current.syncCustomNodes();
	});
	expect(result.current.syncAction).toBe(true);
	act(() => emitConnection(connectedState({ workerAddress: "203.0.113.20:5279" })));
	expect(result.current.syncAction).toBe(false);
	let current!: Promise<void>;
	act(() => {
		current = result.current.syncCustomNodes();
	});
	await act(async () => {
		first.resolve({ ok: false, error: "Previous Worker failed" });
		await previous;
	});
	expect(result.current.syncAction).toBe(true);
	expect(result.current.syncError).toBeNull();
	await act(async () => {
		second.resolve({ ok: false, error: "Current Worker failed" });
		await current;
	});
	expect(result.current.syncAction).toBe(false);
	expect(result.current.syncError).toBe("Current Worker failed");
});

test("preserves retry feedback through its own connection recovery", async () => {
	const request = deferred<ConnectionResult>();
	vi.mocked(window.kastard.workerSession.retry).mockReturnValue(request.promise);
	const { result } = renderHook(useConnectionRequests, { wrapper });
	const connected = connectedState();
	await act(async () =>
		emitConnection({
			status: "offline",
			provider: connected.provider,
			workerAddress: connected.workerAddress,
			message: "Connection lost",
		}),
	);
	let work!: Promise<void>;
	act(() => {
		work = result.current.retry();
	});
	act(() => emitConnection(connected));
	expect(result.current.connectionAction).toBe("retry");
	await act(async () => {
		request.resolve({ ok: true });
		await work;
	});
	expect(result.current.actionFeedback).toEqual({
		type: "success",
		message: "Connection restored.",
	});
	expect(result.current.connectionAction).toBeNull();
});
