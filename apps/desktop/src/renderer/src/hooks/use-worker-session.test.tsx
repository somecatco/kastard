import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
	connectedState,
	emitConnection,
	emitWorkerSession,
	getWorkerSessionState as mockState,
} from "@/App.test-harness";
import { ConnectionProvider } from "@/components/connection/ConnectionProvider";
import { ConnectionWorkerStatus } from "@/components/connection/ConnectionWorkerStatus";
import { useConnectionSettings } from "@/hooks/use-connection-settings";
import type {
	WorkerSessionSnapshot,
	WorkerSessionStateChange,
} from "../../../shared/api";
import { useBackendControls } from "./use-synchronization-controls";
import {
	getWorkerSessionEpoch,
	sameFields,
	useWorkerSessionSelector,
} from "./use-worker-session";

test("isolates settings and custom node consumers from metrics while updating selected state", async () => {
	const settingsRender = vi.fn();
	const nodesRender = vi.fn();
	function Settings() {
		const settings = useConnectionSettings();
		settingsRender();
		return <span>{settings.settingsReady ? "Settings ready" : "Loading"}</span>;
	}
	function Nodes() {
		const state = useWorkerSessionSelector(
			(session) => ({
				connection: session.connection.status,
				nodes: session.customNodes.status,
			}),
			sameFields,
		);
		nodesRender();
		return (
			<span>
				{state.connection}:{state.nodes}
			</span>
		);
	}
	render(
		<ConnectionProvider closeRequest={0}>
			<Settings />
			<Nodes />
			<ConnectionWorkerStatus />
		</ConnectionProvider>,
	);
	await screen.findByText("Settings ready");
	act(() => emitConnection(connectedState()));
	const baseline = [settingsRender.mock.calls.length, nodesRender.mock.calls.length];
	for (const status of ["loading", "unavailable"] as const) {
		act(() =>
			emitWorkerSession({
				systemMetrics:
					status === "loading" ? { status } : { status, error: "Metrics unavailable" },
			}),
		);
		expect([settingsRender.mock.calls.length, nodesRender.mock.calls.length]).toEqual(
			baseline,
		);
	}
	act(() => emitWorkerSession({ customNodes: { status: "loading" } }));
	expect(screen.getByText("connected:loading")).toBeVisible();
	expect(nodesRender.mock.calls.length).toBeGreaterThan(baseline[1] ?? 0);
	expect(settingsRender).toHaveBeenCalledTimes(baseline[0] ?? 0);
	expect(window.kastard.workerSession.onStateChange).toHaveBeenCalledOnce();
});

test("keeps the shared session alive while every visible consumer is closed", async () => {
	function State() {
		return (
			<span>{useWorkerSessionSelector((session) => session.customNodes.status)}</span>
		);
	}
	const view = render(
		<ConnectionProvider closeRequest={0}>
			<State />
		</ConnectionProvider>,
	);
	await waitFor(() =>
		expect(window.kastard.workerSession.getSnapshot).toHaveBeenCalledOnce(),
	);
	view.rerender(<ConnectionProvider closeRequest={0}>{null}</ConnectionProvider>);
	act(() => emitWorkerSession({ customNodes: { status: "loading" } }));
	view.rerender(
		<ConnectionProvider closeRequest={0}>
			<State />
		</ConnectionProvider>,
	);
	expect(screen.getByText("loading")).toBeVisible();
	expect(window.kastard.workerSession.getSnapshot).toHaveBeenCalledOnce();
	expect(window.kastard.workerSession.onStateChange).toHaveBeenCalledOnce();
});

test("merges initialization events without invalidating the current connection twice and cleans up its subscription", async () => {
	let resolveSnapshot!: (snapshot: WorkerSessionSnapshot) => void;
	let receive!: (change: WorkerSessionStateChange) => void;
	const unsubscribe = vi.fn();
	const initial = mockState();
	vi.mocked(window.kastard.workerSession.getSnapshot).mockReturnValue(
		new Promise((resolve) => {
			resolveSnapshot = resolve;
		}),
	);
	vi.mocked(window.kastard.workerSession.onStateChange).mockImplementation(
		(listener) => {
			receive = listener;
			return unsubscribe;
		},
	);
	const { result, unmount } = renderHook(() =>
		useWorkerSessionSelector(
			(session) => ({ connection: session.connection, setup: session.setup }),
			sameFields,
		),
	);
	const connected = connectedState();
	act(() =>
		receive({
			revision: 1,
			type: "lifecycle.changed",
			connection: connected,
			setup: { status: "running", phase: "verification" },
		}),
	);
	const epoch = getWorkerSessionEpoch();
	await act(async () => resolveSnapshot({ revision: 0, state: initial }));
	expect(result.current).toEqual({
		connection: connected,
		setup: { status: "running", phase: "verification" },
	});
	expect(getWorkerSessionEpoch()).toBe(epoch);
	act(() =>
		receive({
			revision: 1,
			type: "connection.changed",
			connection: initial.connection,
		}),
	);
	expect(result.current.connection).toEqual(connected);
	unmount();
	expect(unsubscribe).toHaveBeenCalledOnce();
});

test("keeps backend controls stable while only model download progress changes", async () => {
	const renders = vi.fn();
	const { result } = renderHook(
		() => {
			renders();
			return useBackendControls();
		},
		{
			wrapper: ({ children }) => (
				<ConnectionProvider closeRequest={0}>{children}</ConnectionProvider>
			),
		},
	);
	await act(async () => emitConnection(connectedState()));
	const models = {
		status: "syncing" as const,
		completed: 0,
		total: 1,
		completedBytes: 0,
		totalBytes: 100,
		present: 0,
		active: ["checkpoints/example.safetensors"],
	};
	act(() => emitWorkerSession({ models }));
	const baseline = renders.mock.calls.length;
	act(() => emitWorkerSession({ models: { ...models, completedBytes: 50 } }));
	expect(renders).toHaveBeenCalledTimes(baseline);
	expect(result.current.state.canRestart).toBe(false);
});
