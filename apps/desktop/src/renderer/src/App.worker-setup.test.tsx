import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type {
	SyncVerificationResult,
	WorkerCustomNodeSyncState,
	WorkerModelSyncState,
} from "../../shared/api";
import { App } from "./App";
import {
	connectedState,
	emitConnection,
	emitWorkerBackend,
	emitWorkerComfy,
	emitWorkerCustomNodes,
	emitWorkerModels,
	emitWorkerSession,
	emitWorkerSetup,
	openConnectionDetails,
	setSyncAfterConnect,
} from "./App.test-harness";

const runtime = {
	cudaVersion: "12.8",
	pythonVersion: "3.12.13",
	torchVersion: "2.11.0+cu128",
	torchvisionVersion: "0.26.0+cu128",
	torchaudioVersion: "2.11.0+cu128",
	uvVersion: "0.12.4",
};

const syncedVerification = {
	status: "synced" as const,
	backend: {
		status: "synced" as const,
		expectedVersion: "0.33.1",
		actualVersion: "0.33.1",
	},
	models: { status: "synced" as const, total: 0 },
	customNodes: { status: "synced" as const, total: 0 },
};

async function openSyncStatus(
	area: "Backend" | "Nodes" | "Models",
): Promise<HTMLElement> {
	fireEvent.click(screen.getByRole("button", { name: `Open ${area} status` }));
	return screen.findByRole("dialog", { name: `${area} status` });
}

function syncingModels(
	completedBytes: number,
	totalBytes = 104_857_600,
): WorkerModelSyncState {
	return {
		status: "syncing",
		completed: 0,
		total: 2,
		completedBytes,
		totalBytes,
		present: 0,
		active: ["checkpoints/model.safetensors"],
	};
}

async function openSyncingModels(): Promise<void> {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerModels({ status: "idle", models: null });
	});
	await openSyncStatus("Models");
	vi.useFakeTimers();
}

function reportModels(state: WorkerModelSyncState, elapsedMs = 0): void {
	act(() => {
		emitWorkerModels(state);
	});
	if (elapsedMs > 0) {
		act(() => {
			vi.advanceTimersByTime(elapsedMs);
		});
	}
}

async function closePopover(popover: HTMLElement): Promise<void> {
	fireEvent.keyDown(document, { key: "Escape" });
	await waitFor(() => expect(popover).not.toBeInTheDocument());
}

test("opens the current Backend, Nodes, and Models status and closes on window blur", async () => {
	render(<App />);

	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [],
			unsupportedNodes: [],
		});
		emitWorkerModels({ status: "synced", models: [] });
	});

	const titlebar = within(screen.getByTestId("window-titlebar"));
	const openStatus = async (
		area: "Backend" | "Nodes" | "Models",
		expectedHeading: string,
	): Promise<void> => {
		const trigger = titlebar.getByRole("button", { name: `Open ${area} status` });
		expect(trigger).toHaveClass("rounded-full", "bg-sidebar-accent");
		trigger.focus();
		expect(trigger).toHaveFocus();
		fireEvent.pointerMove(trigger, { pointerType: "mouse" });
		const tooltip = await screen.findByRole("tooltip");
		fireEvent.click(trigger);
		const popover = await screen.findByRole("dialog", { name: `${area} status` });
		await waitFor(() => expect(tooltip).not.toBeInTheDocument());
		expect(trigger).toHaveClass("ring-1", "ring-inset", "ring-sidebar-ring/50");
		expect(within(popover).getByText(expectedHeading)).toBeVisible();
		expect(screen.queryByTestId("connection-popover")).not.toBeInTheDocument();
		trigger.blur();
		fireEvent(window, new Event("blur"));
		await waitFor(() => expect(popover).not.toBeInTheDocument());
		expect(trigger).not.toHaveFocus();
	};

	await openStatus("Backend", "ComfyUI backend");
	await openStatus("Nodes", "Custom nodes");
	await openStatus("Models", "Models");
});

test("closes every synchronization popover from a blank titlebar area", async () => {
	render(<App />);

	await act(async () => {
		emitConnection(connectedState());
	});

	const titlebar = screen.getByTestId("window-titlebar");
	for (const area of ["Backend", "Nodes", "Models"] as const) {
		const popover = await openSyncStatus(area);
		expect(titlebar).toHaveClass("[-webkit-app-region:no-drag]");

		fireEvent.pointerDown(titlebar, { pointerType: "mouse" });
		await waitFor(() => expect(popover).not.toBeInTheDocument());
		expect(titlebar).toHaveClass("[-webkit-app-region:drag]");
	}

	const backendPopover = await openSyncStatus("Backend");
	const nodesTrigger = screen.getByRole("button", { name: "Open Nodes status" });
	fireEvent.click(nodesTrigger);
	await waitFor(() => expect(backendPopover).not.toBeInTheDocument());
	expect(await screen.findByRole("dialog", { name: "Nodes status" })).toBeVisible();

	const settings = screen.getByRole("button", { name: "Settings" });
	fireEvent.pointerDown(settings, { pointerType: "mouse" });
	fireEvent.click(settings);
	await waitFor(() =>
		expect(
			screen.queryByRole("dialog", { name: "Nodes status" }),
		).not.toBeInTheDocument(),
	);
	expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("closes a pointer-opened synchronization tooltip from the content surface", async () => {
	render(<App />);

	await act(async () => {
		emitConnection(connectedState());
	});

	const trigger = screen.getByRole("button", { name: "Open Backend status" });
	fireEvent.pointerMove(trigger, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");
	expect(tooltip).toHaveTextContent("ComfyUI Backend");
	expect(tooltip).toHaveClass("select-text");
	const dismissSurface = await screen.findByTestId("hover-overlay-dismiss-surface");
	fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
	fireEvent.pointerEnter(dismissSurface, { pointerType: "mouse" });
	await waitFor(() => expect(tooltip).not.toBeInTheDocument());
	await waitFor(() => expect(dismissSurface).not.toBeInTheDocument());
});

test("keeps the content uncovered for a keyboard-opened synchronization tooltip", async () => {
	render(<App />);

	await act(async () => {
		emitConnection(connectedState());
	});

	const trigger = screen.getByRole("button", { name: "Open Backend status" });
	fireEvent.pointerMove(trigger, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");
	expect(
		await screen.findByTestId("hover-overlay-dismiss-surface"),
	).toBeInTheDocument();
	const matches = vi
		.spyOn(trigger, "matches")
		.mockImplementation((selector) =>
			selector === ":focus-visible"
				? true
				: Element.prototype.matches.call(trigger, selector),
		);
	fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
	trigger.focus();
	await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
	expect(tooltip).toHaveTextContent("ComfyUI Backend");
	await waitFor(() =>
		expect(
			screen.queryByTestId("hover-overlay-dismiss-surface"),
		).not.toBeInTheDocument(),
	);

	fireEvent(window, new Event("blur"));
	await waitFor(() => expect(tooltip).not.toBeInTheDocument());
	matches.mockRestore();
});

test("shows Worker setup progress and keeps completed target resync available", async () => {
	render(<App />);

	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [],
			unsupportedNodes: [],
		});
		emitWorkerModels({ status: "synced", models: [] });
	});
	let popover = await openConnectionDetails();
	expect(
		within(popover).getByRole("button", { name: "Check sync status" }),
	).toBeEnabled();
	expect(
		within(popover).queryByRole("button", { name: "Sync custom nodes again" }),
	).not.toBeInTheDocument();
	expect(
		within(popover).queryByRole("button", { name: "Sync models again" }),
	).not.toBeInTheDocument();
	await closePopover(popover);

	popover = await openSyncStatus("Nodes");
	expect(
		within(popover).getByRole("button", { name: "Sync custom nodes again" }),
	).toBeEnabled();
	await closePopover(popover);
	popover = await openSyncStatus("Models");
	expect(
		within(popover).getByRole("button", { name: "Sync models again" }),
	).toBeEnabled();
	await closePopover(popover);

	await act(async () => {
		emitWorkerSetup({ status: "running", phase: "preparation" });
	});
	const titlebar = within(screen.getByTestId("window-titlebar"));
	expect(titlebar.getByRole("listitem", { name: "Nodes: Synced, 0/0" })).toBeVisible();
	expect(titlebar.getByRole("listitem", { name: "Models: Synced, 0/0" })).toBeVisible();
	popover = await openConnectionDetails();
	expect(within(popover).getByText("Synchronization in progress…")).toBeVisible();
	expect(
		within(popover).getByRole("button", { name: "Check sync status" }),
	).toBeDisabled();
	await closePopover(popover);

	popover = await openSyncStatus("Nodes");
	const syncNodes = within(popover).getByRole("button", {
		name: "Sync custom nodes again",
	});
	expect(syncNodes).toBeEnabled();
	fireEvent.click(syncNodes);
	await waitFor(() =>
		expect(window.kastard.workerSession.syncCustomNodes).toHaveBeenCalledOnce(),
	);
	await closePopover(popover);
	popover = await openSyncStatus("Models");
	const syncModels = within(popover).getByRole("button", {
		name: "Sync models again",
	});
	expect(syncModels).toBeEnabled();
	fireEvent.click(syncModels);
	await waitFor(() =>
		expect(window.kastard.workerSession.syncModels).toHaveBeenCalledOnce(),
	);
	await closePopover(popover);

	await act(async () => {
		emitWorkerSetup({ status: "running", phase: "verification" });
	});
	popover = await openSyncStatus("Nodes");
	expect(
		within(popover).getByRole("button", { name: "Sync custom nodes again" }),
	).toBeDisabled();
	await closePopover(popover);
	popover = await openSyncStatus("Models");
	expect(
		within(popover).getByRole("button", { name: "Sync models again" }),
	).toBeDisabled();
	await closePopover(popover);

	await act(async () => {
		emitWorkerSetup({ status: "running", phase: "preparation" });
		emitWorkerComfy({ status: "starting" });
	});
	popover = await openSyncStatus("Nodes");
	expect(
		within(popover).getByRole("button", { name: "Sync custom nodes again" }),
	).toBeDisabled();
	await closePopover(popover);
	popover = await openSyncStatus("Models");
	expect(
		within(popover).getByRole("button", { name: "Sync models again" }),
	).toBeDisabled();
	await closePopover(popover);

	await act(async () => {
		emitWorkerComfy({ status: "ready" });
		emitWorkerSetup({
			status: "failed",
			error: "Model synchronization failed.",
		});
	});
	popover = await openConnectionDetails();
	expect(within(popover).getByText(/\d+ synchronization warnings?\./)).toBeVisible();
	const problems = within(popover).getByRole("list", {
		name: "Synchronization warnings",
	});
	expect(problems).toHaveClass("max-h-32", "overflow-y-auto", "text-warning");
	expect(problems).not.toHaveClass("text-destructive");
	expect(problems).toHaveAccessibleDescription(/\d+ synchronization warnings?\./);
	expect(problems).toHaveTextContent("Model synchronization failed.");
	expect(screen.getByRole("button", { name: /^Connected/ })).toBeVisible();
	expect(screen.getByTestId("connection-popover")).toHaveClass("select-text");
});

test("keeps synchronization progress visible when custom node metadata is unsupported", async () => {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "syncing",
			phase: "install",
			current: 0,
			total: 0,
			currentNode: null,
			unsupportedNodes: [
				{ name: "local-git-node", reason: "Repository metadata is unavailable." },
			],
		});
		emitWorkerModels({ status: "synced", models: [] });
		emitWorkerSetup({ status: "running", phase: "preparation" });
	});

	const popover = within(await openConnectionDetails());
	expect(popover.getByText("Synchronization in progress…")).toBeVisible();
	expect(popover.queryByRole("alert")).not.toBeInTheDocument();
	expect(
		popover.queryByText("Repository metadata is unavailable."),
	).not.toBeInTheDocument();
});

test("shows current synchronization progress instead of stale errors", async () => {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerCustomNodes({
			status: "failed",
			nodes: null,
			unsupportedNodes: [],
			error: "Previous custom node synchronization failed.",
		});
		emitWorkerSetup({ status: "running", phase: "preparation" });
	});

	const popover = within(await openConnectionDetails());
	expect(popover.getByText("Synchronization in progress…")).toBeVisible();
	expect(
		popover.queryByText("Previous custom node synchronization failed."),
	).not.toBeInTheDocument();
});

test("shows individual model synchronization progress instead of a stale setup error", async () => {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerSetup({
			status: "failed",
			error: "Previous setup verification failed.",
		});
		emitWorkerModels(syncingModels(0));
	});

	const popover = within(await openConnectionDetails());
	expect(popover.getByText("Synchronization in progress…")).toBeVisible();
	expect(
		popover.queryByText("Previous setup verification failed."),
	).not.toBeInTheDocument();
});

test("shows the complete setup failure when Worker ComfyUI also fails", async () => {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerComfy({
			status: "failed",
			error: "Worker ComfyUI failed to start.",
		});
		emitWorkerSetup({
			status: "failed",
			error: "Model verification failed. Worker ComfyUI failed to start.",
		});
	});

	const popover = within(await openConnectionDetails());
	expect(popover.getByRole("alert")).toHaveTextContent(
		/\d+ synchronization problems?\./,
	);
	expect(popover.getByRole("list", { name: "Synchronization problems" })).toHaveClass(
		"text-destructive",
	);
	expect(
		popover.getByText("Model verification failed. Worker ComfyUI failed to start."),
	).toBeVisible();
	expect(
		popover.queryByText("Synchronization status has not been checked."),
	).not.toBeInTheDocument();
});

test("prepares the Editor ComfyUI version without changing the connected state", async () => {
	vi.mocked(window.kastard.workerSession.prepareBackend).mockImplementation(
		async () => {
			const state = {
				status: "preparing" as const,
				editorComfyVersion: "0.33.1",
				targetVersion: "0.33.1",
				phase: "download" as const,
				progress: 24,
				phaseElapsedMs: 2_000,
				totalElapsedMs: 5_000,
				runtime,
			};
			emitWorkerBackend(state);
			return { ok: true, state };
		},
	);
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "not-installed",
			editorComfyVersion: "0.33.1",
			runtime,
		});
	});

	await openSyncStatus("Backend");
	expect(screen.getByText("Required ComfyUI v0.33.1")).toBeVisible();
	expect(
		screen.getByText(/CUDA 12.8.*Python 3.12.13.*PyTorch 2.11.0\+cu128/),
	).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Prepare backend" }));

	await waitFor(() =>
		expect(window.kastard.workerSession.prepareBackend).toHaveBeenCalledOnce(),
	);
	expect(screen.getByText("Downloading")).toBeVisible();
	expect(screen.getByText("2s · 5s total")).toBeVisible();
	expect(screen.getByText("24%")).toBeVisible();
	expect(screen.getByRole("button", { name: /^Connected/ })).toBeVisible();
	expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
});

test("offers a restart from the backend popover when Worker ComfyUI fails", async () => {
	vi.mocked(window.kastard.workerSession.restartComfy).mockResolvedValue({
		ok: false,
		error: "Worker ComfyUI restart failed.",
	});
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerComfy({
			status: "failed",
			error: "ComfyUI stopped responding after 12 consecutive health checks.",
		});
	});

	const backendPopover = await openSyncStatus("Backend");
	expect(
		within(backendPopover).getByText(
			"ComfyUI stopped responding after 12 consecutive health checks.",
		),
	).toBeVisible();
	expect(
		within(backendPopover).getByText(
			"Worker logs include ComfyUI output from this connection.",
		),
	).toBeVisible();

	fireEvent.click(
		within(backendPopover).getByRole("button", {
			name: "Restart Worker ComfyUI",
		}),
	);
	await waitFor(() =>
		expect(window.kastard.workerSession.restartComfy).toHaveBeenCalledOnce(),
	);
	await waitFor(() =>
		expect(within(backendPopover).getByRole("alert")).toHaveTextContent(
			"Worker ComfyUI restart failed.",
		),
	);
	expect(
		within(backendPopover).queryByRole("button", { name: /^(Sync|Resync)$/ }),
	).not.toBeInTheDocument();
	expect(window.kastard.workerSession.startSetup).not.toHaveBeenCalled();
});

test("distinguishes the downloaded backend from Worker ComfyUI readiness", async () => {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerComfy({ status: "stopped" });
	});

	expect(screen.getByRole("listitem", { name: "Backend: Pending, 1/2" })).toBeVisible();
	const backendPopover = await openSyncStatus("Backend");
	expect(within(backendPopover).getByText("ComfyUI v0.33.1")).toBeVisible();
	expect(
		within(backendPopover).getByText("Downloaded · Waiting to start"),
	).toBeVisible();

	await act(async () => {
		emitWorkerComfy({ status: "starting" });
	});
	expect(screen.getByRole("listitem", { name: "Backend: Syncing, 1/2" })).toBeVisible();
	expect(within(backendPopover).getByText("Starting Worker ComfyUI…")).toBeVisible();
	const starting = within(backendPopover).getByRole("button", {
		name: "Starting Worker ComfyUI",
	});
	expect(starting).toBeDisabled();
	expect(starting).toHaveTextContent("Starting…");

	await act(async () => {
		emitWorkerComfy({ status: "ready" });
	});
	expect(screen.getByRole("listitem", { name: "Backend: Synced, 2/2" })).toBeVisible();
	expect(within(backendPopover).getByText("Running")).toBeVisible();
	expect(
		within(backendPopover).getByRole("button", {
			name: "Restart Worker ComfyUI",
		}),
	).toBeEnabled();

	await act(async () => {
		emitWorkerComfy({
			status: "failed",
			error: "CUDA initialization failed.",
		});
	});
	expect(
		screen.getByRole("listitem", { name: "Backend: Needs attention, 1/2" }),
	).toBeVisible();
	expect(within(backendPopover).getByRole("alert")).toHaveTextContent(
		"CUDA initialization failed.",
	);
});

test("keeps Worker ComfyUI running with visible custom node warnings", async () => {
	const warning =
		"ComfyUI could not initialize every custom node. 0.1 seconds (IMPORT FAILED): /workspace/kastard/custom_nodes/comfyui-impact-pack";
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerComfy({ status: "ready", warnings: [warning] });
	});

	expect(
		screen.getByRole("listitem", { name: "Backend: Needs attention, 2/2" }),
	).toBeVisible();
	const backendPopover = await openSyncStatus("Backend");
	expect(
		within(backendPopover).getByText("Running with custom node warnings"),
	).toHaveClass("text-success");
	const warnings = within(backendPopover).getByRole("list", {
		name: "Custom node startup warnings",
	});
	expect(warnings).toHaveTextContent(warning);
	expect(warnings.closest("div")).toHaveClass("select-text", "text-warning");
	expect(
		within(backendPopover).getByRole("button", {
			name: "Restart Worker ComfyUI",
		}),
	).toBeEnabled();
});

test("shows both ComfyUI versions only when the Worker backend needs an update", async () => {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.34.0",
			version: "0.33.1",
			runtime,
		});
		emitWorkerComfy({ status: "ready" });
	});

	const backendPopover = await openSyncStatus("Backend");
	expect(within(backendPopover).getByText("Update required")).toBeVisible();
	expect(within(backendPopover).getByText("Worker ComfyUI v0.33.1")).toBeVisible();
	expect(within(backendPopover).getByText("Kastard requires v0.34.0")).toBeVisible();
	expect(
		within(backendPopover).getByText(
			"Run Sync from Connected to install the required version.",
		),
	).toBeVisible();
	expect(
		within(backendPopover).queryByRole("button", {
			name: "Restart Worker ComfyUI",
		}),
	).not.toBeInTheDocument();
});

test("retries only retryable backend failures without changing the connection", async () => {
	vi.mocked(window.kastard.workerSession.prepareBackend).mockImplementation(
		async () => {
			const state = {
				status: "preparing" as const,
				editorComfyVersion: "0.33.1",
				targetVersion: "0.33.1",
				phase: "download" as const,
				progress: 0,
				phaseElapsedMs: 0,
				totalElapsedMs: 0,
				runtime,
			};
			emitWorkerBackend(state);
			return { ok: true, state };
		},
	);
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "failed",
			editorComfyVersion: "0.33.1",
			targetVersion: "0.33.1",
			error: "The fixed Worker runtime is incompatible.",
			retryable: false,
			runtime,
		});
	});
	expect(
		screen.getByRole("listitem", { name: "Backend: Needs attention, 0/2" }),
	).toBeVisible();

	const backendPopover = await openSyncStatus("Backend");
	expect(within(backendPopover).getByRole("alert")).toHaveTextContent(
		"The fixed Worker runtime is incompatible.",
	);
	expect(
		within(backendPopover).queryByRole("button", { name: "Retry backend" }),
	).not.toBeInTheDocument();

	await act(async () => {
		emitWorkerBackend({
			status: "failed",
			editorComfyVersion: "0.33.1",
			targetVersion: "0.33.1",
			error: "Download failed with HTTP 429.",
			retryable: true,
			runtime,
		});
	});

	expect(within(backendPopover).getByRole("alert")).toHaveTextContent(
		"Download failed with HTTP 429.",
	);
	fireEvent.click(
		within(backendPopover).getByRole("button", { name: "Retry backend" }),
	);

	await waitFor(() =>
		expect(window.kastard.workerSession.prepareBackend).toHaveBeenCalledOnce(),
	);
	expect(within(backendPopover).getByText("0s · 0s total")).toBeVisible();
	expect(within(backendPopover).getByText("0%")).toBeVisible();
	expect(screen.getByRole("button", { name: /^Connected/ })).toBeVisible();
});

test("clears a stale backend action error only when the backend state changes", async () => {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "not-installed",
			editorComfyVersion: "0.33.1",
			runtime,
		});
	});

	const backendPopover = await openSyncStatus("Backend");
	fireEvent.click(
		within(backendPopover).getByRole("button", { name: "Prepare backend" }),
	);
	await waitFor(() =>
		expect(within(backendPopover).getByRole("alert")).toHaveTextContent(
			"Unexpected backend preparation.",
		),
	);

	await act(async () => {
		emitWorkerComfy({ status: "stopped" });
	});
	expect(within(backendPopover).getByRole("alert")).toHaveTextContent(
		"Unexpected backend preparation.",
	);

	await act(async () => {
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
	});
	expect(within(backendPopover).queryByRole("alert")).not.toBeInTheDocument();
	expect(screen.getByRole("listitem", { name: "Backend: Pending, 1/2" })).toBeVisible();
});

test("starts custom node sync after the matching backend is ready", async () => {
	vi.mocked(window.kastard.workerSession.syncCustomNodes).mockImplementation(
		async () => {
			const state: WorkerCustomNodeSyncState = {
				status: "syncing",
				phase: "install",
				current: 1,
				total: 1,
				currentNode: "comfyui-kjnodes",
				unsupportedNodes: [
					{ name: "local-git-node", reason: "Repository metadata is unavailable." },
				],
				targetStatus: "stale",
			};
			emitWorkerCustomNodes(state);
			return { ok: true, state };
		},
	);
	vi.mocked(window.kastard.workerSession.cancelCustomNodes).mockImplementation(
		async () => {
			const state: WorkerCustomNodeSyncState = {
				status: "canceling",
				unsupportedNodes: [
					{ name: "local-git-node", reason: "Repository metadata is unavailable." },
				],
			};
			emitWorkerCustomNodes(state);
			return { ok: true, state };
		},
	);
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "idle",
			nodes: [{ name: "existing-node", managerId: null, version: null }],
			unsupportedNodes: [],
			targetStatus: "unknown",
		});
	});

	await openSyncStatus("Nodes");
	const sync = screen.getByRole("button", { name: "Sync custom nodes" });
	expect(sync).toBeEnabled();
	expect(screen.getByText("1 active Worker node before sync")).toBeVisible();
	expect(screen.getByText("existing-node@unknown")).toBeVisible();
	expect(
		screen.getByText(
			"This Worker does not report which Editor target produced this status.",
		),
	).toBeVisible();
	fireEvent.click(sync);

	await waitFor(() =>
		expect(window.kastard.workerSession.syncCustomNodes).toHaveBeenCalledOnce(),
	);
	expect(
		screen.getByRole("listitem", { name: "Nodes: Syncing, 1/2" }),
	).toHaveTextContent("N1/2");
	expect(screen.getByText("Installing comfyui-kjnodes")).toBeVisible();
	expect(
		screen.getByText("Worker status belongs to a previous Editor target."),
	).toBeVisible();
	expect(
		screen.getByText("local-git-node · Repository metadata is unavailable."),
	).toBeVisible();
	await act(async () => {
		emitWorkerCustomNodes({
			status: "syncing",
			phase: "install",
			current: 1,
			total: 1,
			currentNode: "comfyui-kjnodes",
			unsupportedNodes: [
				{ name: "local-git-node", reason: "Repository metadata is unavailable." },
			],
			targetStatus: "current",
		});
	});
	expect(screen.getByText("Installing comfyui-kjnodes")).toBeVisible();
	expect(
		screen.queryByText("Worker status matches the current Editor target."),
	).not.toBeInTheDocument();
	fireEvent.click(
		screen.getByRole("button", { name: "Cancel custom node synchronization" }),
	);
	await waitFor(() =>
		expect(window.kastard.workerSession.cancelCustomNodes).toHaveBeenCalledOnce(),
	);
	expect(screen.getByText("Canceling custom node synchronization…")).toBeVisible();
	expect(
		screen.getByRole("button", { name: "Canceling custom node synchronization" }),
	).toBeDisabled();
	await act(async () => {
		emitWorkerCustomNodes({
			status: "canceled",
			nodes: [],
			unsupportedNodes: [
				{ name: "local-git-node", reason: "Repository metadata is unavailable." },
			],
		});
	});
	expect(screen.getByText("0 active Worker nodes after cancellation")).toBeVisible();
	expect(screen.getByRole("button", { name: "Sync custom nodes again" })).toBeEnabled();
	await act(async () => {
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
			unsupportedNodes: [
				{ name: "local-git-node", reason: "Repository metadata is unavailable." },
			],
			targetStatus: "current",
		});
	});
	expect(screen.getByText("1 custom node synchronized")).toBeVisible();
	expect(
		screen.queryByText("Worker status matches the current Editor target."),
	).not.toBeInTheDocument();
	expect(screen.getByText("comfyui-kjnodes@1.5.0")).toBeVisible();
	await act(async () => {
		emitWorkerCustomNodes({
			status: "failed",
			nodes: [
				{
					name: "comfyui-kjnodes",
					managerId: "comfyui-kjnodes",
					version: "1.5.0",
				},
			],
			error: "ComfyUI could not import every custom node.",
			unsupportedNodes: [
				{ name: "local-git-node", reason: "Repository metadata is unavailable." },
			],
			targetStatus: "current",
		});
	});
	expect(screen.getByRole("alert")).toHaveTextContent(
		"ComfyUI could not import every custom node.",
	);
	expect(
		screen.queryByText("Worker status matches the current Editor target."),
	).not.toBeInTheDocument();
	expect(screen.getByText("1 active Worker node after failure")).toBeVisible();
	expect(screen.getByText("comfyui-kjnodes@1.5.0")).toBeVisible();
	await act(async () => {
		emitWorkerCustomNodes({
			status: "failed",
			nodes: null,
			error: "Could not read active Worker nodes.",
			unsupportedNodes: [
				{ name: "local-git-node", reason: "Repository metadata is unavailable." },
			],
		});
	});
	expect(screen.getByText("Active Worker node inventory unknown")).toBeVisible();
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Could not read active Worker nodes.",
	);
	expect(screen.getByRole("button", { name: "Sync custom nodes again" })).toBeEnabled();
});

test("shows the full custom node target list throughout synchronization", async () => {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "syncing",
			phase: "install",
			current: 2,
			total: 4,
			currentNode: "ComfyUI-KJNodes",
			unsupportedNodes: [
				{ name: "local-git-node", reason: "Repository metadata is unavailable." },
			],
			targetStatus: "current",
			targetNodes: [
				{
					id: "comfyui-obvpm",
					editorVersion: "1.0.3",
					workerVersion: "1.0.3",
					status: "installed",
				},
				{
					id: "ComfyUI-KJNodes",
					editorVersion: "1.5.0",
					workerVersion: null,
					status: "installing",
				},
				{
					id: "ComfyUI-GGUF",
					editorVersion: "1.1.2",
					workerVersion: null,
					status: "not-installed",
				},
				{
					id: "RES4LYF",
					editorVersion: "cdf2f4a",
					workerVersion: "8a109de",
					status: "version-mismatch",
				},
			],
			unselectedNodes: [
				{
					name: "ComfyUI-Impact-Pack",
					managerId: "ComfyUI-Impact-Pack",
					version: "8.19.1",
				},
			],
		});
	});

	await openSyncStatus("Nodes");
	expect(screen.getByText("Installing ComfyUI-KJNodes · 1/5")).toBeVisible();
	expect(
		screen.getByRole("listitem", { name: "Nodes: Syncing, 1/5" }),
	).toHaveTextContent("N1/5");
	const installingRow = screen.getByText("ComfyUI-KJNodes").closest("li");
	expect(installingRow).toHaveTextContent("Editor 1.5.0 · Worker not installed");
	expect(installingRow).toHaveTextContent("Installing");
	const mismatchRow = screen.getByText("RES4LYF").closest("li");
	expect(mismatchRow).toHaveTextContent("Editor cdf2f4a · Worker 8a109de");
	expect(mismatchRow).toHaveTextContent("Version mismatch");
	expect(screen.getByText("Not Selected for Sync")).toBeVisible();
	expect(screen.getByText("ComfyUI-Impact-Pack@8.19.1")).toBeVisible();
	expect(screen.getByText("Installed on Worker")).toBeVisible();
	expect(
		screen.getByText("local-git-node · Repository metadata is unavailable."),
	).toBeVisible();
	expect(
		screen.getByRole("progressbar", { name: "Custom node synchronization" }),
	).toHaveAttribute("aria-valuenow", "1");

	await act(async () => {
		emitWorkerCustomNodes({
			status: "failed",
			nodes: [],
			error: "Custom node synchronization did not complete.",
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes: [
				{
					id: "comfyui-obvpm",
					editorVersion: "1.0.3",
					workerVersion: "1.0.3",
					status: "installed",
				},
				{
					id: "ComfyUI-KJNodes",
					editorVersion: "1.5.0",
					workerVersion: "1.5.0",
					status: "installed",
				},
				{
					id: "ComfyUI-GGUF",
					editorVersion: "1.1.2",
					workerVersion: null,
					status: "failed",
					error: "Python dependency installation failed.",
				},
				{
					id: "RES4LYF",
					editorVersion: "cdf2f4a",
					workerVersion: "8a109de",
					status: "version-mismatch",
				},
			],
			unselectedNodes: [],
		});
	});

	expect(screen.getByText("Synchronization completed with errors · 2/4")).toBeVisible();
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Custom node synchronization did not complete. Affected: ComfyUI-GGUF and RES4LYF. Open Worker logs for details.",
	);
	expect(screen.getByText("ComfyUI-GGUF").closest("li")).toHaveTextContent("Failed");
	expect(screen.getByText("ComfyUI-GGUF").closest("li")).toHaveTextContent(
		"Python dependency installation failed.",
	);

	await act(async () => {
		emitWorkerSession({
			verification: {
				status: "out-of-sync",
				backend: {
					status: "synced",
					expectedVersion: "0.33.1",
					actualVersion: "0.33.1",
				},
				models: { status: "synced", total: 0 },
				customNodes: {
					status: "out-of-sync",
					total: 4,
					problems: [
						{
							reason: "missing",
							name: "ComfyUI-GGUF",
							expected: "1.1.2",
							actual: null,
						},
						{
							reason: "version-mismatch",
							name: "RES4LYF",
							expected: "cdf2f4a",
							actual: "8a109de",
						},
					],
				},
			},
		});
	});

	expect(screen.getByText("ComfyUI-GGUF").closest("li")).toHaveTextContent("Failed");
	expect(screen.getByText("ComfyUI-GGUF").closest("li")).toHaveTextContent(
		"Python dependency installation failed.",
	);
	expect(
		screen.getByRole("listitem", { name: "Nodes: Needs attention, 2/4" }),
	).toHaveTextContent("N2/4");
	expect(screen.getByRole("button", { name: "Sync custom nodes again" })).toBeEnabled();

	await act(async () => {
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [
				{ id: "comfyui-obvpm", version: "1.0.3" },
				{ id: "ComfyUI-KJNodes", version: "1.5.0" },
				{ id: "ComfyUI-GGUF", version: "1.1.2" },
				{ id: "RES4LYF", version: "cdf2f4a" },
			],
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes: [
				{
					id: "comfyui-obvpm",
					editorVersion: "1.0.3",
					workerVersion: "1.0.3",
					status: "installed",
				},
				{
					id: "ComfyUI-KJNodes",
					editorVersion: "1.5.0",
					workerVersion: "1.5.0",
					status: "installed",
				},
				{
					id: "ComfyUI-GGUF",
					editorVersion: "1.1.2",
					workerVersion: "1.1.2",
					status: "installed",
				},
				{
					id: "RES4LYF",
					editorVersion: "cdf2f4a",
					workerVersion: "cdf2f4a",
					status: "installed",
				},
			],
			unselectedNodes: [],
		});
	});
	expect(screen.getByText("4 custom nodes synchronized · 4/4")).toBeVisible();
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("force reinstalls only the selected custom node after its status popover closes", async () => {
	let resolveReinstall:
		| ((
				value: Awaited<
					ReturnType<typeof window.kastard.workerSession.reinstallCustomNode>
				>,
		  ) => void)
		| undefined;
	vi.mocked(window.kastard.workerSession.reinstallCustomNode).mockReturnValue(
		new Promise((resolve) => {
			resolveReinstall = resolve;
		}),
	);
	const targetNode = {
		id: "comfyui-easy-use",
		editorVersion: "1.3.6",
		workerVersion: "1.3.6",
		status: "installed" as const,
	};
	const otherTargetNode = {
		id: "ComfyUI-KJNodes",
		editorVersion: "1.5.0",
		workerVersion: "1.5.0",
		status: "installed" as const,
	};
	const targetNodes = [targetNode, otherTargetNode];
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "ready",
			nodes: targetNodes.map(({ id, editorVersion: version }) => ({ id, version })),
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes,
			unselectedNodes: [
				{
					name: "ComfyUI-Impact-Pack",
					managerId: "ComfyUI-Impact-Pack",
					version: "8.19.1",
				},
			],
		});
	});

	let nodesPopover = await openSyncStatus("Nodes");
	expect(
		within(nodesPopover).queryByLabelText(/^Actions for /),
	).not.toBeInTheDocument();
	await act(async () => {
		emitWorkerCustomNodes({
			status: "ready",
			nodes: targetNodes.map(({ id, editorVersion: version }) => ({ id, version })),
			capabilities: { forceReinstall: true },
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes,
			unselectedNodes: [
				{
					name: "ComfyUI-Impact-Pack",
					managerId: "ComfyUI-Impact-Pack",
					version: "8.19.1",
				},
			],
		});
	});

	let targetAction = within(nodesPopover).getByRole("button", {
		name: "Actions for comfyui-easy-use",
	});
	let otherAction = within(nodesPopover).getByRole("button", {
		name: "Actions for ComfyUI-KJNodes",
	});
	fireEvent.click(targetAction);
	expect(
		screen.getByRole("dialog", { name: "Actions for comfyui-easy-use" }),
	).toBeVisible();
	fireEvent.pointerDown(within(nodesPopover).getByText("Custom nodes"), {
		pointerType: "mouse",
	});
	await waitFor(() =>
		expect(
			screen.queryByRole("dialog", { name: "Actions for comfyui-easy-use" }),
		).not.toBeInTheDocument(),
	);
	expect(nodesPopover).toBeInTheDocument();

	fireEvent.click(targetAction);
	const reinstallAction = screen.getByRole("button", {
		name: "Force reinstall",
	});
	fireEvent.pointerDown(reinstallAction, { pointerType: "mouse" });
	expect(nodesPopover).toBeInTheDocument();
	expect(reinstallAction).toBeInTheDocument();
	fireEvent.click(reinstallAction);
	expect(window.kastard.workerSession.reinstallCustomNode).not.toHaveBeenCalled();
	const confirmation = screen.getByRole("dialog", {
		name: "Force reinstall custom node?",
	});
	expect(confirmation).toHaveTextContent(
		"If installation fails or is canceled after removal, the node will remain uninstalled.",
	);
	fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
	expect(window.kastard.workerSession.reinstallCustomNode).not.toHaveBeenCalled();

	fireEvent.click(targetAction);
	fireEvent.click(screen.getByRole("button", { name: "Force reinstall" }));
	const confirmedReinstall = screen.getByRole("dialog", {
		name: "Force reinstall custom node?",
	});
	const nodesTrigger = document.querySelector<HTMLButtonElement>(
		'button[aria-label="Open Nodes status"]',
	);
	expect(nodesTrigger).not.toBeNull();
	fireEvent.click(nodesTrigger as HTMLButtonElement);
	await waitFor(() => expect(nodesPopover).not.toBeInTheDocument());
	expect(confirmedReinstall).toBeVisible();
	fireEvent.click(
		within(confirmedReinstall).getByRole("button", { name: "Force reinstall" }),
	);
	expect(window.kastard.workerSession.reinstallCustomNode).toHaveBeenCalledWith({
		id: "comfyui-easy-use",
	});
	expect(
		screen.queryByRole("dialog", { name: "Actions for comfyui-easy-use" }),
	).not.toBeInTheDocument();
	expect(screen.getByLabelText("Nodes: Syncing, 2/2")).toBeVisible();
	nodesPopover = await openSyncStatus("Nodes");
	targetAction = within(nodesPopover).getByRole("button", {
		name: "Actions for comfyui-easy-use",
	});
	otherAction = within(nodesPopover).getByRole("button", {
		name: "Actions for ComfyUI-KJNodes",
	});
	expect(targetAction).toBeDisabled();
	expect(otherAction).toBeDisabled();
	expect(
		within(nodesPopover).getByRole("button", { name: "Sync custom nodes again" }),
	).toBeDisabled();
	expect(
		within(nodesPopover).getByText("Preparing reinstall comfyui-easy-use… · 2/2"),
	).toBeVisible();
	expect(screen.getByText("comfyui-easy-use").closest("li")).toHaveTextContent(
		"Preparing…",
	);

	await act(async () => {
		resolveReinstall?.({
			ok: true,
			state: {
				status: "syncing",
				operationKind: "reinstall",
				reinstallNodeId: "comfyui-easy-use",
				phase: "install",
				reinstallPhase: "prepare",
				current: 0,
				total: 1,
				currentNode: null,
				capabilities: { forceReinstall: true },
				unsupportedNodes: [],
				targetStatus: "current",
				targetNodes,
				unselectedNodes: [],
			},
		});
		emitWorkerCustomNodes({
			status: "syncing",
			operationKind: "reinstall",
			reinstallNodeId: "comfyui-easy-use",
			phase: "install",
			reinstallPhase: "prepare",
			current: 0,
			total: 1,
			currentNode: null,
			capabilities: { forceReinstall: true },
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes,
			unselectedNodes: [],
		});
	});
	expect(screen.getByText("Preparing reinstall comfyui-easy-use… · 2/2")).toBeVisible();

	await act(async () => {
		emitWorkerCustomNodes({
			status: "syncing",
			operationKind: "reinstall",
			reinstallNodeId: "comfyui-easy-use",
			phase: "install",
			reinstallPhase: "remove",
			current: 0,
			total: 1,
			currentNode: "comfyui-easy-use",
			capabilities: { forceReinstall: true },
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes: [{ ...targetNode, status: "installing" }, otherTargetNode],
			unselectedNodes: [],
		});
	});
	expect(screen.getByText("Removing comfyui-easy-use… · 1/2")).toBeVisible();
	expect(screen.getByText("comfyui-easy-use").closest("li")).toHaveTextContent(
		"Removing…",
	);

	await act(async () => {
		emitWorkerCustomNodes({
			status: "syncing",
			operationKind: "reinstall",
			reinstallNodeId: "comfyui-easy-use",
			phase: "install",
			reinstallPhase: "install",
			current: 0,
			total: 1,
			currentNode: "comfyui-easy-use",
			capabilities: { forceReinstall: true },
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes: [{ ...targetNode, status: "installing" }, otherTargetNode],
			unselectedNodes: [],
		});
	});
	expect(screen.getByText("Installing comfyui-easy-use… · 1/2")).toBeVisible();
	expect(screen.getByText("comfyui-easy-use").closest("li")).toHaveTextContent(
		"Installing…",
	);
	expect(screen.getByText("ComfyUI-KJNodes").closest("li")).toHaveTextContent(
		"Installed",
	);

	await act(async () => {
		emitWorkerCustomNodes({
			status: "failed",
			operationKind: "reinstall",
			reinstallNodeId: "comfyui-easy-use",
			nodes: [
				{
					name: "ComfyUI-KJNodes",
					managerId: "ComfyUI-KJNodes",
					version: "1.5.0",
				},
			],
			error: "Could not remove comfyui-easy-use for reinstall.",
			capabilities: { forceReinstall: true },
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes: [
				{ ...targetNode, workerVersion: null, status: "failed" },
				otherTargetNode,
			],
			unselectedNodes: [],
		});
	});
	expect(
		within(nodesPopover).getByText("Reinstall failed for comfyui-easy-use · 1/2"),
	).toBeVisible();
	expect(within(nodesPopover).getByRole("alert")).toHaveTextContent(
		"Could not remove comfyui-easy-use for reinstall. Open Worker logs for details.",
	);
});

test("deletes one unselected Worker custom node only after confirmation", async () => {
	let resolveRemoval:
		| ((
				value: Awaited<
					ReturnType<typeof window.kastard.workerSession.removeCustomNode>
				>,
		  ) => void)
		| undefined;
	vi.mocked(window.kastard.workerSession.removeCustomNode).mockReturnValue(
		new Promise((resolve) => {
			resolveRemoval = resolve;
		}),
	);
	const targetNode = {
		id: "comfyui-kjnodes",
		editorVersion: "1.5.0",
		workerVersion: "1.5.0",
		status: "installed" as const,
	};
	const manualNode = { name: "manual.py", managerId: null, version: null };
	const managerNode = {
		name: "ComfyUI-Impact-Pack",
		managerId: "ComfyUI-Impact-Pack",
		version: "8.19.1",
	};
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [{ id: targetNode.id, version: targetNode.editorVersion }],
			capabilities: { remove: true },
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes: [targetNode],
			unselectedNodes: [managerNode, manualNode],
		});
	});

	const nodesPopover = await openSyncStatus("Nodes");
	const manualAction = within(nodesPopover).getByRole("button", {
		name: "Actions for manual.py",
	});
	const managerAction = within(nodesPopover).getByRole("button", {
		name: "Actions for ComfyUI-Impact-Pack",
	});
	expect(managerAction).toBeEnabled();
	fireEvent.click(manualAction);
	fireEvent.click(screen.getByRole("button", { name: "Delete from Worker" }));
	expect(window.kastard.workerSession.removeCustomNode).not.toHaveBeenCalled();
	let confirmation = screen.getByRole("dialog", {
		name: "Delete custom node from Worker?",
	});
	expect(confirmation).toHaveTextContent(
		"This permanently deletes manual.py from the Worker only.",
	);
	fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
	expect(window.kastard.workerSession.removeCustomNode).not.toHaveBeenCalled();

	fireEvent.click(manualAction);
	fireEvent.click(screen.getByRole("button", { name: "Delete from Worker" }));
	confirmation = screen.getByRole("dialog", {
		name: "Delete custom node from Worker?",
	});
	fireEvent.click(
		within(confirmation).getByRole("button", { name: "Delete from Worker" }),
	);
	expect(window.kastard.workerSession.removeCustomNode).toHaveBeenCalledWith({
		node: manualNode,
	});
	expect(within(nodesPopover).getByText("Removing…")).toBeVisible();
	expect(
		within(nodesPopover).getByText("Preparing to remove manual.py… · 1/1"),
	).toBeVisible();
	expect(manualAction).toBeDisabled();
	const managerRow = within(nodesPopover)
		.getByText("ComfyUI-Impact-Pack@8.19.1")
		.closest("div");
	expect(managerRow).toHaveTextContent("Installed on Worker");
	expect(managerRow).not.toHaveTextContent("Removing…");
	expect(managerAction).toBeDisabled();

	await act(async () => {
		resolveRemoval?.({
			ok: true,
			state: {
				status: "syncing",
				operationKind: "remove",
				removalNode: manualNode,
				phase: "remove",
				removalPhase: "remove",
				current: 0,
				total: 1,
				currentNode: manualNode.name,
				capabilities: { remove: true },
				unsupportedNodes: [],
				targetStatus: "current",
				targetNodes: [targetNode],
				unselectedNodes: [managerNode, manualNode],
			},
		});
		emitWorkerCustomNodes({
			status: "failed",
			operationKind: "remove",
			removalNode: manualNode,
			nodes: [{ name: targetNode.id, managerId: targetNode.id, version: "1.5.0" }],
			error: "Could not remove manual.py from the Worker.",
			capabilities: { remove: true },
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes: [targetNode],
			unselectedNodes: [managerNode, manualNode],
		});
	});
	expect(
		within(nodesPopover).getByText("Removal failed for manual.py · 1/1"),
	).toBeVisible();
	expect(within(nodesPopover).queryByText("Removing…")).not.toBeInTheDocument();
	expect(within(nodesPopover).getAllByText("Installed on Worker")).toHaveLength(2);

	await act(async () => {
		emitWorkerCustomNodes({
			status: "ready",
			operationKind: "remove",
			removalNode: manualNode,
			nodes: [{ id: targetNode.id, version: targetNode.editorVersion }],
			capabilities: { remove: true },
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes: [targetNode],
			unselectedNodes: [managerNode],
		});
	});
	expect(
		within(nodesPopover).getByText(
			"Removed manual.py from Worker storage. Restart Worker ComfyUI if it is running · 1/1",
		),
	).toBeVisible();
	expect(within(nodesPopover).queryByText("manual.py@unknown")).not.toBeInTheDocument();
	expect(within(nodesPopover).getByText("ComfyUI-Impact-Pack@8.19.1")).toBeVisible();
});

test("allows custom-node and model synchronization while Worker ComfyUI is ready", async () => {
	vi.mocked(window.kastard.workerSession.syncCustomNodes).mockResolvedValue({
		ok: true,
		state: {
			status: "ready",
			nodes: [],
			unsupportedNodes: [],
			targetStatus: "current",
		},
	});
	vi.mocked(window.kastard.workerSession.syncModels).mockResolvedValue({
		ok: true,
		state: { status: "synced", models: [] },
	});
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerComfy({ status: "ready" });
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [],
			unsupportedNodes: [],
			targetStatus: "current",
		});
		emitWorkerModels({ status: "synced", models: [] });
	});

	const nodesPopover = await openSyncStatus("Nodes");
	const nodesSync = within(nodesPopover).getByRole("button", {
		name: "Sync custom nodes again",
	});
	expect(nodesSync).toBeEnabled();
	fireEvent.click(nodesSync);
	await waitFor(() =>
		expect(window.kastard.workerSession.syncCustomNodes).toHaveBeenCalledOnce(),
	);
	await closePopover(nodesPopover);

	const modelsPopover = await openSyncStatus("Models");
	const modelsSync = within(modelsPopover).getByRole("button", {
		name: "Sync models again",
	});
	expect(modelsSync).toBeEnabled();
	fireEvent.click(modelsSync);
	await waitFor(() =>
		expect(window.kastard.workerSession.syncModels).toHaveBeenCalledOnce(),
	);
});

test("reconciles models and shows selectable reuse and download progress", async () => {
	vi.mocked(window.kastard.workerSession.syncModels).mockImplementation(async () => {
		const state: WorkerModelSyncState = {
			status: "checking",
			total: 2,
			totalBytes: 123,
		};
		emitWorkerModels(state);
		return { ok: true, state };
	});
	vi.mocked(window.kastard.workerSession.cancelModels).mockImplementation(async () => {
		const state: WorkerModelSyncState = { status: "canceling" };
		emitWorkerModels(state);
		return { ok: true, state };
	});
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "not-installed",
			editorComfyVersion: "0.33.1",
			runtime,
		});
		emitWorkerModels({ status: "idle", models: null });
	});

	await openSyncStatus("Models");
	const sync = screen.getByRole("button", { name: "Sync models" });
	expect(sync).toBeEnabled();
	expect(screen.getByText("Not synced in this Worker session")).toBeVisible();
	fireEvent.click(sync);

	await waitFor(() =>
		expect(window.kastard.workerSession.syncModels).toHaveBeenCalledOnce(),
	);
	expect(screen.getByText("Checking 2 selected model files…")).toBeVisible();
	await act(async () => {
		emitWorkerModels({
			status: "syncing",
			completed: 1,
			total: 2,
			completedBytes: 61,
			totalBytes: 123,
			present: 1,
			active: ["checkpoints/model.safetensors"],
		});
	});
	expect(
		screen.getByRole("listitem", { name: "Models: Syncing, 1/2" }),
	).toHaveTextContent("M1/2");
	expect(screen.getByText("1 existing files reused")).toBeVisible();
	const progress = screen.getByText("Downloading checkpoints/model.safetensors");
	expect(progress).toBeVisible();
	expect(progress.closest("[role='dialog']")).toHaveClass("select-text");
	fireEvent.click(screen.getByRole("button", { name: "Cancel model synchronization" }));
	await waitFor(() =>
		expect(window.kastard.workerSession.cancelModels).toHaveBeenCalledOnce(),
	);
	expect(screen.getByText("Canceling model synchronization…")).toBeVisible();
	await act(async () => {
		emitWorkerModels({ status: "canceled", models: [] });
	});
	expect(screen.getByText("Canceled · 0 model files are ready")).toBeVisible();
	expect(screen.getByRole("button", { name: "Sync models again" })).toBeEnabled();
	await act(async () => {
		emitWorkerModels({
			status: "synced",
			models: [
				{
					name: "Model",
					path: "checkpoints/model.safetensors",
					artifact: {
						provider: "huggingface",
						modelId: "owner/model",
						versionId: "main",
						versionLabel: "main",
						fileId: "model.safetensors",
						fileName: "model.safetensors",
						sizeBytes: 123,
					},
				},
			],
		});
	});
	expect(screen.getByText("1 model file ready")).toBeVisible();
	expect(screen.getByRole("button", { name: "Sync models again" })).toBeEnabled();
});

test("force redownload requires confirmation and sends only the selected model path", async () => {
	let resolveRedownload:
		| ((
				value: Awaited<ReturnType<typeof window.kastard.workerSession.redownloadModel>>,
		  ) => void)
		| undefined;
	const target = {
		name: "Model",
		path: "checkpoints/model.safetensors",
		artifact: {
			provider: "huggingface" as const,
			modelId: "owner/model",
			versionId: "0123456789abcdef0123456789abcdef01234567",
			versionLabel: "main",
			fileId: "model.safetensors",
			fileName: "model.safetensors",
			sizeBytes: 123,
		},
	};
	const otherTarget = {
		...target,
		name: "Other Model",
		path: "checkpoints/other-model.safetensors",
		artifact: {
			...target.artifact,
			fileId: "other-model.safetensors",
			fileName: "other-model.safetensors",
		},
	};
	const targetRow = {
		target,
		status: "ready" as const,
		downloadedBytes: target.artifact.sizeBytes,
	};
	const otherTargetRow = {
		target: otherTarget,
		status: "ready" as const,
		downloadedBytes: otherTarget.artifact.sizeBytes,
	};
	const targetModels = [targetRow, otherTargetRow];
	vi.mocked(window.kastard.workerSession.redownloadModel).mockReturnValue(
		new Promise((resolve) => {
			resolveRedownload = resolve;
		}),
	);
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerModels({
			status: "synced",
			operationKind: "sync",
			models: [target, otherTarget],
			targetStatus: "current",
			targetModels,
		});
	});

	const modelsPopover = await openSyncStatus("Models");
	expect(within(modelsPopover).getByText(target.path)).toBeVisible();
	expect(
		within(modelsPopover).queryByRole("button", { name: `Actions for ${target.name}` }),
	).not.toBeInTheDocument();
	await act(async () => {
		emitWorkerModels({
			status: "synced",
			operationKind: "sync",
			capabilities: { forceRedownload: true },
			models: [target, otherTarget],
			targetStatus: "current",
			targetModels,
		});
	});

	const actions = within(modelsPopover).getByRole("button", {
		name: `Actions for ${target.name}`,
	});
	fireEvent.click(actions);
	expect(
		screen.getByRole("dialog", { name: `Actions for ${target.name}` }),
	).toBeVisible();
	fireEvent.pointerDown(within(modelsPopover).getByText("Models"), {
		pointerType: "mouse",
	});
	await waitFor(() =>
		expect(
			screen.queryByRole("dialog", { name: `Actions for ${target.name}` }),
		).not.toBeInTheDocument(),
	);
	expect(modelsPopover).toBeInTheDocument();

	fireEvent.click(actions);
	fireEvent.click(screen.getByRole("button", { name: "Force redownload" }));
	let confirmation = screen.getByRole("dialog", { name: "Force redownload model?" });
	expect(confirmation).toHaveTextContent(
		"delete the current Worker file for Model before downloading a new copy",
	);
	expect(confirmation).toHaveTextContent(
		"If the download fails or is canceled, the model will remain unavailable.",
	);
	fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
	expect(window.kastard.workerSession.redownloadModel).not.toHaveBeenCalled();

	fireEvent.click(actions);
	fireEvent.click(screen.getByRole("button", { name: "Force redownload" }));
	confirmation = screen.getByRole("dialog", { name: "Force redownload model?" });
	fireEvent.click(
		within(confirmation).getByRole("button", { name: "Delete and redownload" }),
	);
	await waitFor(() =>
		expect(window.kastard.workerSession.redownloadModel).toHaveBeenCalledWith({
			path: target.path,
		}),
	);
	expect(
		within(modelsPopover).getByRole("listitem", {
			name: `${target.name}: Redownloading`,
		}),
	).toBeVisible();
	expect(
		within(modelsPopover).getByRole("listitem", {
			name: `${otherTarget.name}: Ready`,
		}),
	).toBeVisible();
	expect(actions).toBeDisabled();
	expect(
		within(modelsPopover).getByRole("button", {
			name: `Actions for ${otherTarget.name}`,
		}),
	).toBeDisabled();
	expect(
		within(modelsPopover).getByRole("button", { name: "Sync models again" }),
	).toBeDisabled();

	await act(async () => {
		resolveRedownload?.({
			ok: true,
			state: {
				status: "checking",
				operationKind: "redownload",
				capabilities: { forceRedownload: true },
				total: 1,
				totalBytes: target.artifact.sizeBytes,
				targetStatus: "current",
				targetModels: [
					{ target, status: "redownloading", downloadedBytes: 0 },
					otherTargetRow,
				],
			},
		});
	});
});

test("shows that a failed or canceled force redownload leaves the model absent", async () => {
	const target = {
		name: "Model",
		path: "checkpoints/model.safetensors",
		artifact: {
			provider: "civitai" as const,
			modelId: "1",
			versionId: "2",
			versionLabel: "v1",
			fileId: "3",
			fileName: "model.safetensors",
			sizeBytes: 123,
		},
	};
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerModels({
			status: "failed",
			operationKind: "redownload",
			capabilities: { forceRedownload: true },
			models: [],
			total: 1,
			error: "Provider download failed.",
			targetStatus: "current",
			targetModels: [
				{
					target,
					status: "redownload-failed",
					downloadedBytes: 0,
					error: "Provider download failed.",
				},
			],
		});
	});

	const modelsPopover = await openSyncStatus("Models");
	expect(within(modelsPopover).getByText("Redownload failed")).toBeVisible();
	expect(within(modelsPopover).getByText("Model file removed")).toBeVisible();
	expect(within(modelsPopover).getByRole("alert")).toHaveTextContent(
		"The previous Worker file was removed. Retry the download to use this model.",
	);

	await act(async () => {
		emitWorkerModels({
			status: "canceled",
			operationKind: "redownload",
			capabilities: { forceRedownload: true },
			models: [],
			targetStatus: "current",
			targetModels: [{ target, status: "not-downloaded", downloadedBytes: 0 }],
		});
	});
	expect(
		within(modelsPopover).getByText("Redownload canceled for Model · 0/1"),
	).toBeVisible();
	expect(within(modelsPopover).getByText("Not downloaded")).toBeVisible();
	expect(within(modelsPopover).getByRole("alert")).toHaveTextContent(
		"Redownload was canceled after the previous Worker file was removed. Retry the download to use this model.",
	);
});

test("does not report the full model selection as synced after one redownload", async () => {
	const selected = {
		name: "Selected",
		path: "checkpoints/selected.safetensors",
		artifact: {
			provider: "huggingface" as const,
			modelId: "owner/repository",
			versionId: "a".repeat(40),
			versionLabel: "main",
			fileId: "selected.safetensors",
			fileName: "selected.safetensors",
			sizeBytes: 10,
		},
	};
	const missing = {
		...selected,
		name: "Missing",
		path: "checkpoints/missing.safetensors",
		artifact: {
			...selected.artifact,
			fileId: "missing.safetensors",
			fileName: "missing.safetensors",
		},
	};
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerModels({
			capabilities: { forceRedownload: true },
			operationKind: "redownload",
			status: "checking",
			total: 1,
			totalBytes: 10,
			targetStatus: "current",
			targetModels: [
				{ target: selected, status: "redownloading", downloadedBytes: 0 },
				{ target: missing, status: "not-downloaded", downloadedBytes: 0 },
			],
		});
	});
	expect(screen.getByRole("listitem", { name: "Models: Syncing, 0/2" })).toBeVisible();

	await act(async () => {
		emitWorkerModels({
			capabilities: { forceRedownload: true },
			operationKind: "redownload",
			status: "synced",
			models: [selected],
			modelSnapshot: {
				models: [{ path: selected.path, status: "ready", downloadedBytes: 10 }],
			},
			targetStatus: "current",
			targetModels: [
				{ target: selected, status: "ready", downloadedBytes: 10 },
				{ target: missing, status: "not-downloaded", downloadedBytes: 0 },
			],
		});
	});

	expect(screen.getByRole("listitem", { name: "Models: Pending, 1/2" })).toBeVisible();
});

test("reports a restored idle model selection as synced when every file is ready", async () => {
	const target = {
		name: "Restored",
		path: "checkpoints/restored.safetensors",
		artifact: {
			provider: "huggingface" as const,
			modelId: "owner/repository",
			versionId: "a".repeat(40),
			versionLabel: "main",
			fileId: "restored.safetensors",
			fileName: "restored.safetensors",
			sizeBytes: 10,
		},
	};
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerModels({
			status: "idle",
			models: [target],
			targetStatus: "current",
			targetModels: [{ target, status: "ready", downloadedBytes: 10 }],
		});
	});

	expect(screen.getByRole("listitem", { name: "Models: Synced, 1/1" })).toBeVisible();
});

test("keeps partial model progress visible after synchronization fails", async () => {
	const models = Array.from({ length: 4 }, (_, index) => {
		const number = index + 1;
		return {
			name: `Model ${number}`,
			path: `checkpoints/model-${number}.safetensors`,
			artifact: {
				provider: "civitai" as const,
				modelId: "1",
				versionId: "1",
				versionLabel: "v1",
				fileId: String(number),
				fileName: `model-${number}.safetensors`,
				sizeBytes: 123,
			},
		};
	});
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerModels({
			status: "failed",
			models,
			total: 5,
			error:
				"Krea2 Text-Fusion Refusal Reduction: CivitAI access is blocked in this Worker's region due to legal restrictions. Use a Worker in a supported region.",
		});
	});

	expect(
		screen.getByRole("listitem", { name: "Models: Needs attention, 4/5" }),
	).toHaveTextContent("M4/5");
	const popover = await openSyncStatus("Models");
	expect(within(popover).getByText("4 model files are ready")).toBeVisible();
	expect(within(popover).getByRole("alert")).toHaveTextContent(
		"Krea2 Text-Fusion Refusal Reduction: CivitAI access is blocked in this Worker's region due to legal restrictions. Use a Worker in a supported region.",
	);
});

test("shows the model download speed and the remaining time", async () => {
	await openSyncingModels();

	reportModels(syncingModels(0));
	expect(screen.getByText("Measuring speed…")).toBeVisible();

	reportModels(syncingModels(1_048_576), 1_000);
	expect(screen.getByText("Measuring speed…")).toBeVisible();

	reportModels(syncingModels(2_097_152), 1_000);
	expect(screen.getByText("1.0 MiB/s · 1m 38s left")).toBeVisible();

	reportModels({ status: "synced", models: [] });
	reportModels(syncingModels(3_145_728));
	expect(screen.getByText("Measuring speed…")).toBeVisible();
});

test("keeps the model download speed readable without a usable remaining time", async () => {
	await openSyncingModels();

	reportModels(syncingModels(2_097_152), 3_000);
	expect(screen.getByText("0 B/s")).toBeVisible();

	reportModels(syncingModels(0), 1_000);
	reportModels(syncingModels(20_480), 2_000);
	expect(screen.getByText("10 KiB/s · 2h 50m 38s left")).toBeVisible();

	reportModels(syncingModels(0, 10_995_116_277_760), 1_000);
	reportModels(syncingModels(524_288, 10_995_116_277_760), 2_000);
	expect(screen.getByText("256 KiB/s")).toBeVisible();
});

test("checks backend, models, and custom nodes as one selectable sync status", async () => {
	const result: SyncVerificationResult = {
		ok: true,
		verification: {
			status: "out-of-sync",
			backend: {
				status: "synced",
				expectedVersion: "0.33.1",
				actualVersion: "0.33.1",
			},
			models: {
				status: "out-of-sync",
				total: 1,
				problems: [
					{
						reason: "stale",
						name: "checkpoints/model.safetensors",
						expected: "huggingface:owner/model@new/model.safetensors",
						actual: "huggingface:owner/model@old/model.safetensors",
					},
				],
			},
			customNodes: {
				status: "out-of-sync",
				total: 1,
				problems: [
					{
						reason: "unsupported",
						name: "local-git-node",
						expected: "Manager-compatible package",
						actual: "Unsupported local package",
					},
				],
			},
		},
	};
	vi.mocked(window.kastard.workerSession.verify).mockImplementation(async () => {
		emitWorkerSession({ verification: result.verification });
		return result;
	});
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [],
			unsupportedNodes: [],
		});
		emitWorkerModels({ status: "synced", models: [] });
	});

	const connectionPopover = await openConnectionDetails();
	const check = within(connectionPopover).getByRole("button", {
		name: "Check sync status",
	});
	expect(check).toBeEnabled();
	fireEvent.click(check);

	await waitFor(() =>
		expect(window.kastard.workerSession.verify).toHaveBeenCalledOnce(),
	);
	expect(screen.getByRole("listitem", { name: "Backend: Pending, 1/2" })).toBeVisible();
	expect(
		screen.getByRole("listitem", { name: "Nodes: Needs attention, 0/1" }),
	).toBeVisible();
	expect(
		screen.getByRole("listitem", { name: "Models: Needs attention, 0/1" }),
	).toBeVisible();
	const staleError = screen.getByText(/Stale: checkpoints\/model\.safetensors/);
	expect(staleError).toBeVisible();
	expect(screen.getByText(/Unsupported: local-git-node/)).toBeVisible();
	expect(staleError.closest("[data-testid='connection-popover']")).toHaveClass(
		"select-text",
	);

	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [],
			unsupportedNodes: [],
		});
		emitWorkerModels({ status: "synced", models: [] });
	});
	expect(staleError).toBeVisible();

	await closePopover(connectionPopover);
	expect(staleError).not.toBeInTheDocument();
	expect(
		screen.getByRole("listitem", { name: "Nodes: Needs attention, 0/1" }),
	).toBeVisible();
	expect(
		screen.getByRole("listitem", { name: "Models: Needs attention, 0/1" }),
	).toBeVisible();
	const reopenedPopover = await openConnectionDetails();
	expect(
		within(reopenedPopover).getByText(/Stale: checkpoints\/model\.safetensors/),
	).toBeVisible();
	expect(
		within(reopenedPopover).getByText(/Unsupported: local-git-node/),
	).toBeVisible();
});

test("prefers verified target progress without subtracting unexpected Worker nodes", async () => {
	const result: SyncVerificationResult = {
		ok: true,
		verification: {
			status: "out-of-sync",
			backend: {
				status: "synced",
				expectedVersion: "0.33.1",
				actualVersion: "0.33.1",
			},
			models: { status: "synced", total: 0 },
			customNodes: {
				status: "out-of-sync",
				total: 2,
				problems: [
					{
						reason: "unexpected",
						name: "extra-node",
						expected: null,
						actual: "1.0.0",
					},
					{
						reason: "missing",
						name: "second-node",
						expected: "1.0.0",
						actual: null,
					},
				],
			},
		},
	};
	vi.mocked(window.kastard.workerSession.verify).mockImplementation(async () => {
		emitWorkerSession({ verification: result.verification });
		return result;
	});
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [
				{ id: "first-node", version: "1.0.0" },
				{ id: "second-node", version: "1.0.0" },
			],
			unsupportedNodes: [],
			targetStatus: "current",
			targetNodes: [
				{
					id: "first-node",
					editorVersion: "1.0.0",
					workerVersion: "1.0.0",
					status: "installed",
				},
				{
					id: "second-node",
					editorVersion: "1.0.0",
					workerVersion: "1.0.0",
					status: "installed",
				},
			],
			unselectedNodes: [],
		});
		emitWorkerModels({ status: "synced", models: [] });
	});

	const connectionPopover = await openConnectionDetails();
	fireEvent.click(
		within(connectionPopover).getByRole("button", { name: "Check sync status" }),
	);

	await waitFor(() =>
		expect(window.kastard.workerSession.verify).toHaveBeenCalledOnce(),
	);
	expect(
		screen.getByRole("listitem", { name: "Nodes: Needs attention, 1/2" }),
	).toBeVisible();
	expect(screen.getByText(/Unexpected: extra-node/)).toBeVisible();

	await closePopover(connectionPopover);
	const nodesPopover = await openSyncStatus("Nodes");
	expect(
		within(nodesPopover).getByText("1 custom node synchronized · 1/2"),
	).toBeVisible();
	expect(
		within(nodesPopover).getByRole("progressbar", {
			name: "Custom node synchronization",
		}),
	).toHaveAttribute("aria-valuenow", "1");
	const missingRow = within(nodesPopover).getByText("second-node").closest("li");
	expect(missingRow).toHaveTextContent("Editor 1.0.0 · Worker not installed");
	expect(missingRow).toHaveTextContent("Not installed");

	await act(async () => {
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [{ id: "previous-node", version: "1.0.0" }],
			unsupportedNodes: [
				{ name: "local-node", reason: "Repository metadata is unavailable." },
			],
			targetStatus: "stale",
			targetNodes: [
				{
					id: "previous-node",
					editorVersion: "1.0.0",
					workerVersion: "1.0.0",
					status: "installed",
				},
			],
			unselectedNodes: [],
		});
	});
	expect(
		screen.getByRole("listitem", { name: "Nodes: Needs attention, 1/2" }),
	).toBeVisible();
	expect(
		within(nodesPopover).getByText(
			"Worker status belongs to a previous Editor target.",
		),
	).toBeVisible();
	expect(
		within(nodesPopover).getByText("1 custom node synchronized · 1/2"),
	).toBeVisible();
	expect(
		within(nodesPopover).getByText("previous-node").closest("li"),
	).toHaveTextContent("Installed");
});

test("hides the initial automatic action and cancels active setup synchronization", async () => {
	let resolveCancellation: (
		result: Awaited<ReturnType<typeof window.kastard.workerSession.cancelSetup>>,
	) => void = () => undefined;
	vi.mocked(window.kastard.workerSession.cancelSetup).mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveCancellation = resolve;
			}),
	);
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerComfy({ status: "stopped" });
		emitWorkerSetup({ status: "idle", pendingAutomaticStart: true });
	});

	const connectionPopoverElement = await openConnectionDetails();
	const connectionPopover = within(connectionPopoverElement);
	expect(
		connectionPopover.getByRole("button", { name: "Check sync status" }).parentElement,
	).toHaveClass("flex", "justify-start");
	expect(
		connectionPopover.queryByRole("button", { name: "Sync" }),
	).not.toBeInTheDocument();
	await act(async () => {
		emitWorkerSetup({ status: "idle" });
	});
	expect(connectionPopover.getByRole("button", { name: "Sync" })).toBeEnabled();

	await act(async () => {
		emitWorkerSetup({ status: "running", phase: "preparation" });
		emitWorkerModels({ status: "checking", total: 1, totalBytes: 1 });
	});
	const cancel = connectionPopover.getByRole("button", {
		name: "Cancel sync",
	});
	expect(cancel).toHaveTextContent("Cancel sync");
	fireEvent.click(cancel);
	await waitFor(() =>
		expect(window.kastard.workerSession.cancelSetup).toHaveBeenCalledOnce(),
	);
	expect(
		connectionPopover.getByRole("button", {
			name: "Canceling Worker synchronization",
		}),
	).toBeDisabled();

	await act(async () => {
		emitWorkerModels({ status: "canceled", models: [] });
	});
	await closePopover(connectionPopoverElement);
	const modelPopover = await openSyncStatus("Models");
	expect(
		within(modelPopover).getByRole("button", { name: "Sync models again" }),
	).toBeDisabled();
	await closePopover(modelPopover);

	await act(async () => {
		emitWorkerSetup({ status: "canceled" });
		resolveCancellation({ ok: true });
	});
	const completedPopover = within(await openConnectionDetails());
	expect(completedPopover.getByRole("button", { name: "Resync" })).toBeEnabled();
});

test("starts the complete Worker setup from the rightmost action and shows its state", async () => {
	const verification = {
		status: "synced" as const,
		backend: {
			status: "synced" as const,
			expectedVersion: "0.33.1",
			actualVersion: "0.33.1",
		},
		models: { status: "synced" as const, total: 0 },
		customNodes: { status: "synced" as const, total: 0 },
	};
	vi.mocked(window.kastard.workerSession.startSetup).mockImplementation(async () => {
		emitWorkerSetup({ status: "running", phase: "preparation" });
		return { ok: true };
	});
	setSyncAfterConnect(false);
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [],
			unsupportedNodes: [],
		});
		emitWorkerModels({ status: "synced", models: [] });
		emitWorkerComfy({ status: "stopped" });
	});
	expect(screen.getByRole("listitem", { name: "Backend: Pending, 1/2" })).toBeVisible();

	const connectionPopoverElement = await openConnectionDetails();
	const connectionPopover = within(connectionPopoverElement);
	const setup = connectionPopover.getByRole("button", { name: "Sync" });
	expect(setup).toBeEnabled();

	fireEvent.click(setup);
	await waitFor(() =>
		expect(window.kastard.workerSession.startSetup).toHaveBeenCalledOnce(),
	);
	await act(async () => {
		emitWorkerSetup({ status: "running", phase: "comfy" });
		emitWorkerComfy({ status: "starting" });
	});
	expect(screen.getByRole("listitem", { name: "Backend: Syncing, 1/2" })).toBeVisible();
	expect(
		connectionPopover.getByText("Synchronization verified. Starting Worker ComfyUI…"),
	).toBeVisible();
	expect(connectionPopover.getByRole("button", { name: "Resyncing…" })).toBeDisabled();

	await act(async () => {
		emitWorkerComfy({ status: "ready" });
		emitWorkerSetup({ status: "succeeded", verification });
	});
	expect(screen.getByRole("listitem", { name: "Backend: Synced, 2/2" })).toBeVisible();
	expect(
		screen.getByText("Backend, models, and custom nodes are synchronized."),
	).toBeVisible();
	expect(connectionPopover.getByRole("button", { name: "Resync" })).toBeEnabled();

	await act(async () => {
		emitWorkerComfy({
			status: "failed",
			error: "CUDA initialization failed.",
		});
	});
	expect(
		screen.getByRole("listitem", { name: "Backend: Needs attention, 1/2" }),
	).toBeVisible();
	await closePopover(connectionPopoverElement);
	const backendPopover = await openSyncStatus("Backend");
	const failure = within(backendPopover).getByRole("alert");
	expect(failure).toHaveTextContent("CUDA initialization failed.");
	expect(backendPopover).toHaveClass("select-text");
});

test("shows ready Worker ComfyUI while model synchronization continues", async () => {
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerComfy({ status: "ready" });
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [],
			unsupportedNodes: [],
		});
		emitWorkerModels(syncingModels(52_428_800));
		emitWorkerSetup({ status: "running", phase: "preparation" });
	});

	expect(screen.getByRole("listitem", { name: "Backend: Synced, 2/2" })).toBeVisible();
	expect(screen.getByRole("listitem", { name: "Models: Syncing, 0/2" })).toBeVisible();
	const popover = within(await openConnectionDetails());
	expect(popover.getByText("Synchronization in progress…")).toBeVisible();
	expect(popover.getByRole("button", { name: "Cancel sync" })).toBeEnabled();
	expect(popover.queryByRole("button", { name: "Resync" })).not.toBeInTheDocument();
});

test("keeps Worker ComfyUI restart separate from the complete resync action", async () => {
	let resolveRestart: (
		result: Awaited<ReturnType<typeof window.kastard.workerSession.restartComfy>>,
	) => void = () => undefined;
	vi.mocked(window.kastard.workerSession.restartComfy).mockReturnValue(
		new Promise((resolve) => {
			resolveRestart = resolve;
		}),
	);
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerComfy({ status: "ready" });
		emitWorkerSetup({ status: "succeeded", verification: syncedVerification });
	});

	const connectionPopoverElement = await openConnectionDetails();
	const connectionPopover = within(connectionPopoverElement);
	const resync = connectionPopover.getByRole("button", { name: "Resync" });
	expect(resync).toBeEnabled();
	expect(
		connectionPopover.queryByRole("button", {
			name: "Restart Worker ComfyUI",
		}),
	).not.toBeInTheDocument();
	await closePopover(connectionPopoverElement);

	const backendPopoverElement = await openSyncStatus("Backend");
	const backendPopover = within(backendPopoverElement);
	const restart = backendPopover.getByRole("button", {
		name: "Restart Worker ComfyUI",
	});
	expect(restart).toBeEnabled();
	expect(
		backendPopover.queryByRole("button", { name: /^(Sync|Resync)$/ }),
	).not.toBeInTheDocument();
	await act(async () => {
		emitWorkerSession({
			workflow: {
				id: "workflow-1",
				phase: "running",
				cancellation: "none",
				workerUrl: "https://worker.example.com",
				lastConfirmedStatus: "running",
				lastConfirmedAt: 1,
			},
		});
	});
	expect(restart).toBeDisabled();
	expect(
		backendPopover.getByText("Restart is unavailable while a workflow is active."),
	).toBeVisible();
	expect(restart).toHaveAccessibleDescription(
		"Restart is unavailable while a workflow is active.",
	);
	await act(async () => {
		emitWorkerSession({ workflow: null });
	});
	expect(restart).toBeEnabled();
	expect(
		backendPopover.queryByText("Restart is unavailable while a workflow is active."),
	).not.toBeInTheDocument();
	await act(async () => {
		emitWorkerComfy({
			status: "unavailable",
			error: "ComfyUI execution is unavailable.",
			retryable: false,
		});
	});
	expect(restart).toBeDisabled();
	await act(async () => {
		emitWorkerComfy({ status: "ready" });
	});
	expect(restart).toBeEnabled();
	await act(async () => {
		emitWorkerBackend({
			status: "failed",
			editorComfyVersion: "0.33.1",
			targetVersion: "0.34.0",
			error: "Backend download failed.",
			retryable: true,
			runtime,
		});
	});
	expect(
		backendPopover.queryByRole("button", {
			name: "Restart Worker ComfyUI",
		}),
	).not.toBeInTheDocument();
	expect(backendPopover.getByRole("button", { name: "Retry backend" })).toBeEnabled();
	await act(async () => {
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
	});
	const restoredRestart = backendPopover.getByRole("button", {
		name: "Restart Worker ComfyUI",
	});
	expect(restoredRestart).toBeEnabled();

	fireEvent.click(restoredRestart);
	await waitFor(() =>
		expect(window.kastard.workerSession.restartComfy).toHaveBeenCalledOnce(),
	);
	const starting = backendPopover.getByRole("button", {
		name: "Starting Worker ComfyUI",
	});
	expect(starting).toBeDisabled();
	expect(starting).toHaveTextContent("Starting…");
	await act(async () => resolveRestart({ ok: true }));
	expect(
		backendPopover.getByRole("button", { name: "Restart Worker ComfyUI" }),
	).toBeEnabled();
	expect(window.kastard.workerSession.startSetup).not.toHaveBeenCalled();

	await closePopover(backendPopoverElement);
	const reopenedConnectionPopover = within(await openConnectionDetails());
	const reopenedResync = reopenedConnectionPopover.getByRole("button", {
		name: "Resync",
	});
	expect(reopenedResync).toBeEnabled();
	fireEvent.click(reopenedResync);
	await waitFor(() =>
		expect(window.kastard.workerSession.startSetup).toHaveBeenCalledOnce(),
	);
	expect(window.kastard.workerSession.restartComfy).toHaveBeenCalledOnce();
});

test("does not restore an obsolete verification after the Worker state changes", async () => {
	let resolveVerification: (
		result: Awaited<ReturnType<typeof window.kastard.workerSession.verify>>,
	) => void = () => undefined;
	vi.mocked(window.kastard.workerSession.verify).mockReturnValue(
		new Promise((resolve) => {
			resolveVerification = resolve;
		}),
	);
	render(<App />);
	await act(async () => {
		emitConnection(connectedState());
		emitWorkerBackend({
			status: "ready",
			editorComfyVersion: "0.33.1",
			version: "0.33.1",
			runtime,
		});
		emitWorkerCustomNodes({
			status: "ready",
			nodes: [],
			unsupportedNodes: [],
		});
		emitWorkerModels({ status: "synced", models: [] });
	});

	const connectionPopover = await openConnectionDetails();
	fireEvent.click(
		within(connectionPopover).getByRole("button", { name: "Check sync status" }),
	);
	await waitFor(() =>
		expect(window.kastard.workerSession.verify).toHaveBeenCalledOnce(),
	);
	await act(async () => {
		emitWorkerBackend({
			status: "not-installed",
			editorComfyVersion: "0.33.1",
			runtime,
		});
		resolveVerification({
			ok: true,
			verification: {
				status: "synced",
				backend: {
					status: "synced",
					expectedVersion: "0.33.1",
					actualVersion: "0.33.1",
				},
				models: { status: "synced", total: 0 },
				customNodes: { status: "synced", total: 0 },
			},
		});
	});

	expect(
		screen.queryByText("Backend, models, and custom nodes are synchronized."),
	).not.toBeInTheDocument();
	await closePopover(connectionPopover);
	const backendPopover = await openSyncStatus("Backend");
	expect(within(backendPopover).getByText("Not installed on Worker")).toBeVisible();
});

test("restores titlebar dragging when an open synchronization popover unmounts", async () => {
	render(<App />);

	await act(async () => {
		emitConnection(connectedState());
	});
	const backendPopover = await openSyncStatus("Backend");
	const titlebar = screen.getByTestId("window-titlebar");
	expect(titlebar).toHaveClass("[-webkit-app-region:no-drag]");

	await act(async () => {
		emitConnection({ status: "error", message: "Credential storage failed." });
	});

	expect(backendPopover).not.toBeInTheDocument();
	await waitFor(() => expect(titlebar).toHaveClass("[-webkit-app-region:drag]"));
});
