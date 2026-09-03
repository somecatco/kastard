import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { WorkerSessionStateChange } from "../../shared/api";
import { App } from "./App";
import {
	connectedState,
	emitConnection,
	emitWorkerSession,
	getWorkerSessionState,
	openConnectionDetails,
	setSyncAfterConnect,
} from "./App.test-harness";
import { SERVER_LOG_POLL_MS } from "./components/ServerLogsDialog";

test("connects a selected RunPod Worker and shows its connected state", async () => {
	render(<App />);

	fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
	const dialog = screen.getByRole("dialog");
	expect(
		within(dialog).getByText("Select a provider to see its setup steps."),
	).toBeVisible();
	fireEvent.click(within(dialog).getByRole("button", { name: /^RunPod/ }));
	const connect = within(dialog).getByRole("button", { name: "Connect" });
	const address = within(dialog).getByLabelText("Worker address");
	expect(address).toHaveValue("");
	expect(
		within(dialog).getByText("RunPod templates are not available yet."),
	).toBeVisible();
	expect(within(dialog).queryByRole("link", { name: /template/ })).toBeNull();
	expect(screen.getByRole("switch", { name: /^Sync after connecting/ })).toBeChecked();
	fireEvent.change(address, {
		target: { value: "203.0.113.10:22001" },
	});
	fireEvent.change(within(dialog).getByLabelText("Authentication code"), {
		target: { value: "ABCD-EFGH-JKLM-NPQR" },
	});
	expect(connect).toBeEnabled();
	fireEvent.click(connect);

	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	const connected = screen.getByRole("button", { name: /^Connected/ });
	expect(connected).toBeVisible();
	expect(connected).toHaveClass("rounded-full", "bg-sidebar-accent");
	expect(connected.closest("[data-connection-control]")?.parentElement).toHaveClass(
		"col-start-1",
		"justify-self-start",
	);
	expect(connected).toHaveAccessibleName("Connected for 0 hours 0 minutes");
	expect(screen.getByText("0h 0m")).toBeVisible();
	const titlebar = within(screen.getByTestId("window-titlebar"));
	const synchronizationAreas = titlebar.getByRole("list", {
		name: "Synchronization areas",
	});
	expect(titlebar.getByRole("list", { name: "Worker status" })).toBeVisible();
	expect(
		within(synchronizationAreas).getByRole("listitem", {
			name: "Backend: Pending, 0/2",
		}),
	).toHaveTextContent("B0/2");
	expect(
		within(synchronizationAreas).getByRole("listitem", {
			name: "Nodes: Pending, 0/0",
		}),
	).toHaveTextContent("N0/0");
	expect(
		within(synchronizationAreas).getByRole("listitem", {
			name: "Models: Pending, 0/0",
		}),
	).toHaveTextContent("M0/0");
	expect(window.kastard.workerSession.connect).toHaveBeenCalledWith({
		provider: "runpod",
		serverUrl: "203.0.113.10:22001",
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: true,
	});

	const connectionPopover = await openConnectionDetails();
	expect(connected).toHaveClass("ring-1", "ring-inset", "ring-sidebar-ring/50");
	expect(connectionPopover).toHaveTextContent("203.0.113.10:22001");
	expect(within(connectionPopover).getByText("Synchronization status")).toBeVisible();
	expect(screen.getByRole("button", { name: "ComfyUI" })).toHaveAttribute(
		"aria-current",
		"page",
	);
	fireEvent(window, new Event("blur"));
	await waitFor(() => expect(connectionPopover).not.toBeInTheDocument());
	expect(connected).not.toHaveFocus();

	const reopenedPopover = await openConnectionDetails();
	expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
	fireEvent.click(within(reopenedPopover).getByRole("button", { name: "Disconnect" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Connect" })).toBeVisible(),
	);
	expect(
		screen.queryByRole("list", { name: "Synchronization areas" }),
	).not.toBeInTheDocument();
	expect(screen.queryByRole("list", { name: "Worker status" })).not.toBeInTheDocument();
	expect(window.kastard.workerSession.disconnect).toHaveBeenCalledOnce();
});

test("renders available Worker metrics from session state", async () => {
	render(<App />);

	await act(async () => {
		emitWorkerSession({
			connection: connectedState(),
			systemMetrics: {
				status: "available",
				metrics: {
					sampledAt: "2026-08-17T07:00:00.000Z",
					cpu: { usagePercent: 12 },
					ram: { usedBytes: 4, totalBytes: 8, usagePercent: 50 },
					disk: {
						path: "/workspace",
						usedBytes: 3,
						totalBytes: 10,
						usagePercent: 30,
					},
					gpus: [
						{
							index: 0,
							uuid: "GPU-a",
							name: "NVIDIA RTX 4090",
							usagePercent: 72,
							vramUsedBytes: 12,
							vramTotalBytes: 24,
							vramUsagePercent: 50,
							temperatureC: 68,
						},
					],
				},
			},
		});
	});

	const workerStatus = screen.getByRole("list", { name: "Worker status" });
	expect(
		within(workerStatus).getByRole("img", { name: /^GPU 0 usage: 72%/ }),
	).toBeVisible();
});

test("updates connected time by the minute and resets it for a recovered connection", async () => {
	const connectedAt = Date.parse("2026-08-22T00:00:00.000Z");
	vi.useFakeTimers();
	vi.setSystemTime(connectedAt);
	render(<App />);

	act(() => {
		emitConnection(connectedState({ connectedAt }));
	});
	expect(
		screen.getByRole("button", { name: "Connected for 0 hours 0 minutes" }),
	).toBeVisible();
	expect(screen.getByText("0h 0m")).toBeVisible();

	vi.setSystemTime(connectedAt + (2 * 60 + 6) * 60_000);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(
		screen.getByRole("button", { name: "Connected for 2 hours 7 minutes" }),
	).toBeVisible();
	expect(screen.getByText("2h 7m")).toBeVisible();

	act(() => {
		emitConnection({
			status: "offline",
			provider: "other",
			serverUrl: "worker.example.com:22001",
			message: "Worker unavailable.",
		});
	});
	expect(screen.getByRole("button", { name: "Offline" })).toBeVisible();
	expect(screen.queryByText("2h 7m")).not.toBeInTheDocument();

	act(() => {
		emitConnection(connectedState());
	});
	expect(
		screen.getByRole("button", { name: "Connected for 0 hours 0 minutes" }),
	).toBeVisible();
	expect(screen.getByText("0h 0m")).toBeVisible();
});

test("keeps workflow details out of the connection popover and shows ownership after disconnect", async () => {
	render(<App />);
	const workflow = {
		id: "019d2a56-3c30-7000-8000-000000000001",
		phase: "reconciling" as const,
		cancellation: "unconfirmed" as const,
		workerUrl: "https://original-worker.example.com",
		lastConfirmedStatus: "running" as const,
		lastConfirmedAt: 1_787_073_600_000,
	};

	await act(async () => {
		emitWorkerSession({
			connection: connectedState({
				serverUrl: "https://replacement-worker.example.com",
			}),
			workflow,
		});
	});
	const popover = await openConnectionDetails();
	expect(within(popover).queryByText("Current workflow")).not.toBeInTheDocument();
	expect(within(popover).queryByText(workflow.workerUrl)).not.toBeInTheDocument();

	await act(async () => {
		emitWorkerSession({
			connection: {
				status: "disconnected",
				recentProvider: "other",
				recentServerUrl: "https://replacement-worker.example.com",
			},
		});
	});
	await waitFor(() => expect(popover).not.toBeInTheDocument());
	expect(screen.getByRole("button", { name: "Connect" })).toBeVisible();
	const compactStatus = screen
		.getByText("Cancellation unconfirmed")
		.closest('[role="status"]');
	expect(compactStatus).toHaveClass("select-text");
	expect(compactStatus).toHaveTextContent(workflow.workerUrl);
});

test("shows current connection logs and refreshes them while the dialog is open", async () => {
	vi.mocked(window.kastard.connection.getLogs)
		.mockResolvedValueOnce({
			ok: true,
			logs: [
				{
					id: "server-one:1",
					timestamp: "2026-08-15T12:00:00.000Z",
					level: "info",
					message: "Editor connected.",
				},
			],
			truncated: false,
		})
		.mockResolvedValueOnce({
			ok: true,
			logs: [
				{
					id: "server-one:1",
					timestamp: "2026-08-15T12:00:00.000Z",
					level: "info",
					message: "Editor connected.",
				},
				{
					id: "server-one:2",
					timestamp: "2026-08-15T12:00:01.000Z",
					level: "warning",
					message: "Retrying download.",
				},
				{
					id: "server-one:3",
					timestamp: "2026-08-15T12:00:02.000Z",
					level: "info",
					message: "[stdout] Prompt executed.",
				},
			],
			truncated: true,
		});
	render(<App />);
	await screen.findByRole("button", { name: "Connect" });
	await act(async () => {
		emitConnection(connectedState());
	});
	vi.useFakeTimers();

	fireEvent.click(screen.getByRole("button", { name: /^Connected/ }));
	const connectionPopover = screen.getByRole("dialog", { name: "Connection details" });
	fireEvent.click(
		within(connectionPopover).getByRole("button", { name: "View Worker logs" }),
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});

	const logsDialog = screen.getByRole("dialog", { name: "Worker logs" });
	expect(logsDialog).toBeVisible();
	expect(
		within(logsDialog).getByText(
			"Worker activity and ComfyUI output recorded since this connection started.",
		),
	).toBeVisible();
	expect(screen.getByText("Editor connected.").closest("li")).toHaveClass(
		"select-text",
	);
	expect(window.kastard.connection.getLogs).toHaveBeenCalledOnce();

	await act(async () => {
		await vi.advanceTimersByTimeAsync(SERVER_LOG_POLL_MS);
	});

	expect(screen.getByText("Retrying download.")).toBeVisible();
	expect(screen.getByText("[stdout] Prompt executed.")).toBeVisible();
	expect(screen.getByText("Some older logs are no longer available.")).toBeVisible();
	expect(fireEvent.keyDown(logsDialog, { key: "a", metaKey: true })).toBe(false);
	const selectedLogs = window.getSelection()?.toString() ?? "";
	expect(selectedLogs).toContain("Editor connected.");
	expect(selectedLogs).toContain("Retrying download.");
	expect(selectedLogs).toContain("[stdout] Prompt executed.");
	expect(selectedLogs).not.toContain("Worker logs");
	expect(selectedLogs).not.toContain("Some older logs are no longer available.");

	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
		await Promise.resolve();
	});
	const copiedLogs = vi.mocked(window.kastard.connection.copyServerLogs).mock
		.calls[0]?.[0];
	expect(copiedLogs?.split("\n")).toHaveLength(3);
	expect(copiedLogs).toMatch(
		/INFO Editor connected\.\n.*WARNING Retrying download\.\n.*INFO \[stdout\] Prompt executed\.$/,
	);
	expect(screen.getByText("Worker logs copied.")).toHaveAttribute("role", "status");

	vi.mocked(window.kastard.connection.copyServerLogs).mockResolvedValueOnce({
		ok: false,
		error: "Could not copy Worker logs.",
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
		await Promise.resolve();
	});
	expect(screen.getByRole("alert")).toHaveTextContent("Could not copy Worker logs.");
	expect(screen.getByRole("alert")).toHaveClass("select-text");
	window.getSelection()?.removeAllRanges();

	const closeButtons = screen.getAllByRole("button", { name: "Close" });
	fireEvent.click(closeButtons.at(-1) as HTMLElement);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(SERVER_LOG_POLL_MS);
	});
	expect(window.kastard.connection.getLogs).toHaveBeenCalledTimes(2);
});

test("does not overwrite a live connection update with an older initial read", async () => {
	let resolveInitialState: (
		snapshot: Awaited<ReturnType<typeof window.kastard.workerSession.getSnapshot>>,
	) => void = () => undefined;
	vi.mocked(window.kastard.workerSession.getSnapshot).mockReturnValue(
		new Promise((resolve) => {
			resolveInitialState = resolve;
		}),
	);
	render(<App />);

	await act(async () => {
		emitConnection(connectedState());
		resolveInitialState({
			revision: 0,
			state: {
				...getWorkerSessionState(),
				connection: {
					status: "disconnected",
					recentProvider: null,
					recentServerUrl: null,
				},
			},
		});
	});

	expect(screen.getByRole("button", { name: /^Connected/ })).toBeVisible();
});

test("reloads the Worker session snapshot after a skipped revision", async () => {
	let listener: ((change: WorkerSessionStateChange) => void) | null = null;
	let snapshot = {
		revision: 0,
		state: getWorkerSessionState(),
	};
	vi.mocked(window.kastard.workerSession.getSnapshot).mockImplementation(async () =>
		structuredClone(snapshot),
	);
	vi.mocked(window.kastard.workerSession.onStateChange).mockImplementation(
		(nextListener) => {
			listener = nextListener;
			return () => {
				listener = null;
			};
		},
	);
	render(<App />);

	await waitFor(() =>
		expect(window.kastard.workerSession.getSnapshot).toHaveBeenCalledOnce(),
	);
	const connected = connectedState();
	snapshot = {
		revision: 2,
		state: {
			...getWorkerSessionState(),
			connection: connected,
			systemMetrics: {
				status: "available",
				metrics: {
					sampledAt: "2026-08-30T14:00:00.000Z",
					cpu: { usagePercent: 12 },
					ram: { usedBytes: 4, totalBytes: 8, usagePercent: 50 },
					disk: {
						path: "/workspace",
						usedBytes: 3,
						totalBytes: 10,
						usagePercent: 30,
					},
					gpus: [],
				},
			},
		},
	};
	act(() => {
		listener?.({ revision: 2, type: "connection.changed", connection: connected });
	});

	await waitFor(() =>
		expect(window.kastard.workerSession.getSnapshot).toHaveBeenCalledTimes(2),
	);
	expect(screen.getByRole("button", { name: /^Connected/ })).toBeVisible();
	expect(screen.getByRole("img", { name: "CPU usage: 12%" })).toBeVisible();
});

test("disables titlebar dragging while the connection popover is open", async () => {
	render(<App />);

	await act(async () => {
		emitConnection(connectedState());
	});
	const connectionPopover = await openConnectionDetails();
	expect(connectionPopover).toBeVisible();
	expect(screen.getByTestId("window-titlebar")).toHaveClass(
		"[-webkit-app-region:no-drag]",
	);

	await act(async () => {
		emitConnection({ status: "error", message: "Credential storage failed." });
	});

	expect(screen.queryByTestId("connection-popover")).not.toBeInTheDocument();
	expect(screen.getByRole("alert")).toHaveTextContent("Credential storage failed.");
	expect(screen.getByRole("button", { name: "ComfyUI" })).toHaveAttribute(
		"aria-current",
		"page",
	);
	expect(screen.getByTestId("window-titlebar")).toHaveClass(
		"[-webkit-app-region:no-drag]",
	);
	fireEvent.keyDown(document, { key: "Escape" });
	await waitFor(() =>
		expect(screen.getByTestId("window-titlebar")).toHaveClass(
			"[-webkit-app-region:drag]",
		),
	);
});

test("prefills the recent server without connecting on startup", async () => {
	setSyncAfterConnect(false);
	vi.mocked(window.kastard.workerSession.getSnapshot).mockResolvedValue({
		revision: 0,
		state: {
			...getWorkerSessionState(),
			connection: {
				status: "disconnected",
				recentProvider: "other",
				recentServerUrl: "recent-worker.example.com:22001",
			},
		},
	});
	render(<App />);

	fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

	expect(screen.getByLabelText("Worker address")).toHaveValue(
		"recent-worker.example.com:22001",
	);
	expect(
		screen.getByRole("switch", { name: /^Sync after connecting/ }),
	).not.toBeChecked();
	expect(window.kastard.workerSession.connect).not.toHaveBeenCalled();
});

test("shows an active server as clickable Offline", async () => {
	render(<App />);

	await act(async () => {
		emitConnection({
			status: "offline",
			provider: "other",
			serverUrl: "worker.example.com:22001",
			message: "Could not reach the Worker.",
		});
	});
	const offlineButton = screen.getByRole("button", { name: "Offline" });
	expect(offlineButton).toBeVisible();
	fireEvent.click(offlineButton);

	const connectionPopover = await screen.findByRole("dialog", {
		name: "Connection details",
	});
	expect(within(connectionPopover).getByRole("alert")).toHaveTextContent(
		"Could not reach the Worker.",
	);
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() =>
		expect(window.kastard.workerSession.retry).toHaveBeenCalledOnce(),
	);
	expect(await screen.findByText("Connection restored.")).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Connect" })).toBeVisible(),
	);
});

test("opens a fresh authentication dialog after the encrypted session ends", async () => {
	render(<App />);

	await act(async () => {
		emitConnection({
			status: "offline",
			provider: "other",
			serverUrl: "worker.example.com:22001",
			message:
				"The encrypted Worker session ended. Reconnect with the same authentication code while this Worker is running.",
			reconnectRequired: true,
		});
	});
	fireEvent.click(screen.getByRole("button", { name: "Offline" }));
	fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));

	expect(
		await screen.findByRole("dialog", { name: "Connect to Worker" }),
	).toBeVisible();
	expect(screen.getByLabelText("Worker address")).toHaveValue(
		"worker.example.com:22001",
	);
	expect(screen.getByLabelText("Authentication code")).toHaveValue("");
	expect(window.kastard.workerSession.retry).not.toHaveBeenCalled();
});

test("retries connection preference initialization from its error state", async () => {
	vi.mocked(window.kastard.workerSession.getSnapshot).mockResolvedValue({
		revision: 0,
		state: {
			...getWorkerSessionState(),
			connection: {
				status: "error",
				message: "Secure credential storage is temporarily unavailable.",
			},
		},
	});
	render(<App />);

	const errorButton = await screen.findByRole("button", {
		name: "Connection error",
	});
	fireEvent.click(errorButton);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Secure credential storage is temporarily unavailable.",
	);
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));

	await waitFor(() =>
		expect(window.kastard.workerSession.retryInitialization).toHaveBeenCalledOnce(),
	);
	expect(await screen.findByRole("button", { name: "Connect" })).toBeVisible();
});

test("keeps a failed initialization retry error open", async () => {
	vi.mocked(window.kastard.workerSession.getSnapshot).mockResolvedValue({
		revision: 0,
		state: {
			...getWorkerSessionState(),
			connection: {
				status: "error",
				message: "Secure credential storage is temporarily unavailable.",
			},
		},
	});
	vi.mocked(window.kastard.workerSession.retryInitialization).mockImplementation(
		async () => {
			emitConnection({
				status: "error",
				message: "Credential state is still unavailable.",
			});
			return { ok: false, error: "Credential retry still unavailable." };
		},
	);
	render(<App />);

	fireEvent.click(await screen.findByRole("button", { name: "Connection error" }));
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));

	await waitFor(() =>
		expect(window.kastard.workerSession.retryInitialization).toHaveBeenCalledOnce(),
	);
	expect(screen.getByRole("dialog")).toBeVisible();
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Credential retry still unavailable.",
	);
});

test("keeps a retry failure without a state change available after reopening", async () => {
	vi.mocked(window.kastard.workerSession.getSnapshot).mockResolvedValue({
		revision: 0,
		state: {
			...getWorkerSessionState(),
			connection: {
				status: "error",
				message: "Secure credential storage is temporarily unavailable.",
			},
		},
	});
	vi.mocked(window.kastard.workerSession.retryInitialization).mockResolvedValue({
		ok: false,
		error: "Credential retry request failed.",
	});
	render(<App />);

	const errorButton = await screen.findByRole("button", {
		name: "Connection error",
	});
	fireEvent.click(errorButton);
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));

	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Credential retry request failed.",
	);
	fireEvent.click(errorButton);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	fireEvent.click(errorButton);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Credential retry request failed.",
	);
});
