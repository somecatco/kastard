import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ConnectionSettingsResult, WorkerSystemStatus } from "../../shared/api";
import { App } from "./App";
import {
	connectedState,
	emitWorkerSession,
	hasOpenSettingsListener,
	openSettingsFromMenu,
	openSettingsSection,
} from "./App.test-harness";

const workerSystemStatus: WorkerSystemStatus = {
	sampledAt: "2026-08-30T00:00:00.000Z",
	cpu: { usagePercent: 12 },
	ram: { usedBytes: 4, totalBytes: 8, usagePercent: 50 },
	disk: { path: "/workspace", usedBytes: 3, totalBytes: 10, usagePercent: 30 },
	gpus: [],
};

function submitOtherWorkerConnection(syncAfterConnect: boolean): void {
	const syncSetting = screen.getByRole("switch", { name: /^Sync after connecting/ });
	if ((syncSetting as HTMLInputElement).checked !== syncAfterConnect) {
		fireEvent.click(syncSetting);
	}
	fireEvent.click(screen.getByRole("button", { name: /^Other server/ }));
	fireEvent.change(screen.getByLabelText("Worker address"), {
		target: { value: "worker.example.com:22001" },
	});
	fireEvent.change(screen.getByLabelText("Authentication code"), {
		target: { value: "ABCD-EFGH-JKLM-NPQR" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

test("shares the sync-after-connect setting between Connect and Settings", async () => {
	render(<App />);

	fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
	const connectSetting = screen.getByRole("switch", {
		name: /^Sync after connecting/,
	});
	expect(connectSetting).toBeChecked();
	submitOtherWorkerConnection(false);

	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	expect(window.kastard.workerSession.connect).toHaveBeenCalledWith({
		provider: "other",
		serverUrl: "worker.example.com:22001",
		authenticationCode: "ABCD-EFGH-JKLM-NPQR",
		syncAfterConnect: false,
	});
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Connection");
	expect(
		screen.getByRole("switch", { name: /^Sync after connecting/ }),
	).not.toBeChecked();

	fireEvent.click(screen.getByRole("switch", { name: /^Sync after connecting/ }));
	await waitFor(() =>
		expect(window.kastard.connection.updateSettings).toHaveBeenCalledWith({
			syncAfterConnect: true,
			systemMetricsEnabled: true,
		}),
	);
});

test("keeps rapid connection setting selections optimistic while saving in order", async () => {
	const pending: Array<{
		syncAfterConnect: boolean;
		resolve: (result: ConnectionSettingsResult) => void;
	}> = [];
	vi.mocked(window.kastard.connection.updateSettings).mockImplementation(
		({ syncAfterConnect }) =>
			new Promise((resolve) => {
				pending.push({ syncAfterConnect, resolve });
			}),
	);
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Connection");
	const setting = screen.getByRole("switch", { name: /^Sync after connecting/ });
	await waitFor(() => expect(setting).toBeEnabled());
	fireEvent.click(setting);
	expect(setting).not.toBeChecked();
	expect(setting).toBeEnabled();
	fireEvent.click(setting);
	expect(setting).toBeChecked();

	await waitFor(() =>
		expect(window.kastard.connection.updateSettings).toHaveBeenCalledTimes(1),
	);
	const first = pending[0];
	if (!first) throw new Error("The first connection setting update was not started.");
	await act(async () => {
		first.resolve({
			ok: true,
			settings: {
				syncAfterConnect: first.syncAfterConnect,
				systemMetricsEnabled: true,
			},
		});
	});
	await waitFor(() =>
		expect(window.kastard.connection.updateSettings).toHaveBeenCalledTimes(2),
	);
	expect(setting).toBeChecked();

	const second = pending[1];
	if (!second) throw new Error("The second connection setting update was not started.");
	await act(async () => {
		second.resolve({
			ok: true,
			settings: {
				syncAfterConnect: second.syncAfterConnect,
				systemMetricsEnabled: true,
			},
		});
	});
	expect(first.syncAfterConnect).toBe(false);
	expect(second.syncAfterConnect).toBe(true);
});

test("restores the confirmed connection setting when saving fails", async () => {
	vi.mocked(window.kastard.connection.updateSettings).mockResolvedValueOnce({
		ok: false,
		error: "The connection setting could not be saved.",
	});
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Connection");
	const setting = screen.getByRole("switch", { name: /^Sync after connecting/ });
	await waitFor(() => expect(setting).toBeEnabled());
	fireEvent.click(setting);
	expect(setting).not.toBeChecked();

	expect(await screen.findByRole("alert")).toHaveTextContent(
		"The connection setting could not be saved.",
	);
	expect(setting).toBeChecked();
});

test("hides Worker system metrics optimistically without locking other settings", async () => {
	let finishUpdate = (_result: ConnectionSettingsResult): void => undefined;
	vi.mocked(window.kastard.connection.updateSettings).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishUpdate = resolve;
			}),
	);
	render(<App />);
	act(() => {
		emitWorkerSession({
			connection: connectedState(),
			systemMetrics: { status: "available", metrics: workerSystemStatus },
		});
	});
	expect(screen.getByRole("list", { name: "Worker status" })).toBeVisible();

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Connection");
	const setting = screen.getByRole("switch", { name: /^Worker system metrics/ });
	await waitFor(() => expect(setting).toBeEnabled());
	fireEvent.click(setting);

	expect(setting).not.toBeChecked();
	expect(screen.queryByRole("list", { name: "Worker status" })).not.toBeInTheDocument();
	expect(
		within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole(
			"button",
			{ name: "General" },
		),
	).not.toHaveAttribute("aria-disabled");
	await waitFor(() =>
		expect(window.kastard.connection.updateSettings).toHaveBeenCalledWith({
			syncAfterConnect: true,
			systemMetricsEnabled: false,
		}),
	);

	await act(async () => {
		finishUpdate({
			ok: true,
			settings: { syncAfterConnect: true, systemMetricsEnabled: false },
		});
	});
	expect(setting).not.toBeChecked();
});

test("restores Worker system metrics when saving the setting fails", async () => {
	vi.mocked(window.kastard.connection.updateSettings).mockResolvedValueOnce({
		ok: false,
		error: "The system metrics setting could not be saved.",
	});
	render(<App />);
	act(() => {
		emitWorkerSession({
			connection: connectedState(),
			systemMetrics: { status: "available", metrics: workerSystemStatus },
		});
	});

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Connection");
	const setting = screen.getByRole("switch", { name: /^Worker system metrics/ });
	await waitFor(() => expect(setting).toBeEnabled());
	fireEvent.click(setting);
	expect(setting).not.toBeChecked();

	expect(await screen.findByRole("alert")).toHaveTextContent(
		"The system metrics setting could not be saved.",
	);
	expect(setting).toBeChecked();
	expect(screen.getByRole("list", { name: "Worker status" })).toBeVisible();
});

test.each([
	{
		label: "successful",
		result: {
			ok: true,
			settings: { syncAfterConnect: true, systemMetricsEnabled: false },
		} satisfies ConnectionSettingsResult,
		expectedMetricsEnabled: false,
	},
	{
		label: "failed",
		result: {
			ok: false,
			error: "The metrics setting could not be saved.",
		} satisfies ConnectionSettingsResult,
		expectedMetricsEnabled: true,
	},
])(
	"waits for a $label metrics update before persisting connection settings",
	async ({ result, expectedMetricsEnabled }) => {
		let finishUpdate = (_result: ConnectionSettingsResult): void => undefined;
		vi.mocked(window.kastard.connection.updateSettings).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishUpdate = resolve;
				}),
		);
		render(<App />);
		fireEvent.click(screen.getByRole("button", { name: "Settings" }));
		openSettingsSection("Connection");
		const metricsSetting = screen.getByRole("switch", {
			name: /^Worker system metrics/,
		});
		await waitFor(() => expect(metricsSetting).toBeEnabled());
		fireEvent.click(metricsSetting);
		await waitFor(() =>
			expect(window.kastard.connection.updateSettings).toHaveBeenCalledOnce(),
		);

		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		submitOtherWorkerConnection(false);
		expect(window.kastard.workerSession.connect).not.toHaveBeenCalled();

		await act(async () => {
			finishUpdate(result);
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		fireEvent.click(screen.getByRole("button", { name: "Settings" }));
		openSettingsSection("Connection");
		expect(
			screen.getByRole("switch", { name: /^Sync after connecting/ }),
		).not.toBeChecked();
		expect(
			screen.getByRole("switch", { name: /^Worker system metrics/ }),
		).toHaveProperty("checked", expectedMetricsEnabled);
	},
);

test("persists the final rapid Worker system metrics selection", async () => {
	const pending: Array<{
		enabled: boolean;
		resolve: (result: ConnectionSettingsResult) => void;
	}> = [];
	vi.mocked(window.kastard.connection.updateSettings).mockImplementation(
		({ systemMetricsEnabled }) =>
			new Promise((resolve) => {
				pending.push({ enabled: systemMetricsEnabled, resolve });
			}),
	);
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Connection");
	const setting = screen.getByRole("switch", { name: /^Worker system metrics/ });
	await waitFor(() => expect(setting).toBeEnabled());

	fireEvent.click(setting);
	expect(setting).not.toBeChecked();
	fireEvent.click(setting);
	expect(setting).toBeChecked();
	await waitFor(() =>
		expect(window.kastard.connection.updateSettings).toHaveBeenCalledTimes(1),
	);

	const first = pending[0];
	if (!first) throw new Error("The first system metrics update was not started.");
	await act(async () => {
		first.resolve({
			ok: true,
			settings: { syncAfterConnect: true, systemMetricsEnabled: first.enabled },
		});
	});
	await waitFor(() =>
		expect(window.kastard.connection.updateSettings).toHaveBeenCalledTimes(2),
	);
	expect(setting).toBeChecked();

	const second = pending[1];
	if (!second) throw new Error("The second system metrics update was not started.");
	await act(async () => {
		second.resolve({
			ok: true,
			settings: { syncAfterConnect: true, systemMetricsEnabled: second.enabled },
		});
	});
	expect(first.enabled).toBe(false);
	expect(second.enabled).toBe(true);
	expect(setting).toBeChecked();
});

test("shows ComfyUI as the active desktop surface", async () => {
	render(<App />);

	const menuButton = screen.getByRole("button", { name: "ComfyUI" });

	expect(
		screen.getByRole("navigation", { name: "Primary navigation" }),
	).toContainElement(menuButton);
	expect(menuButton).toHaveAttribute("aria-current", "page");
	expect(await screen.findByTitle("ComfyUI")).toHaveAttribute("src", "about:blank");

	fireEvent.pointerMove(menuButton, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");
	expect(tooltip).toHaveTextContent("ComfyUI");
	expect(tooltip).toHaveClass("pointer-events-none");
	fireEvent.pointerLeave(menuButton, { pointerType: "mouse" });
	await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
});

test("shows Editor directories and opens the requested folder", async () => {
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");
	const comfyPath = await screen.findByText("/Users/test/Kastard/comfy/data");
	fireEvent.mouseDown(comfyPath, { button: 0, detail: 3 });
	expect(document.getSelection()?.toString()).toBe("/Users/test/Kastard/comfy/data");
	fireEvent.click(screen.getByRole("button", { name: "Open folder for ComfyUI" }));
	await waitFor(() =>
		expect(window.kastard.editorDirectories.open).toHaveBeenCalledWith("comfy"),
	);

	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	await screen.findByText("/Users/test/Kastard/comfy/data/custom_nodes");
	const customNodesDescription = screen.getByText(
		"Kastard detects Custom Nodes installed directly in this folder or through ComfyUI Manager.",
	);
	expect(customNodesDescription).toHaveClass(
		"cursor-text",
		"select-text",
		"text-muted-foreground",
	);
	const openCustomNodes = screen.getByRole("button", {
		name: "Open folder for Custom Nodes",
	});
	expect(openCustomNodes).toHaveAccessibleDescription(
		"Kastard detects Custom Nodes installed directly in this folder or through ComfyUI Manager.",
	);
	fireEvent.click(openCustomNodes);
	await waitFor(() =>
		expect(window.kastard.editorDirectories.open).toHaveBeenCalledWith("custom-nodes"),
	);

	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	expect(
		screen.getByText("Add models, including LoRAs, without downloading them locally."),
	).toBeVisible();
	await screen.findByText("/Users/test/Kastard/comfy/virtual-models");
	const modelLibraryDescription = screen.getByText(
		"Kastard manages this folder and replaces its contents during model sync. Do not add files here directly.",
	);
	expect(modelLibraryDescription).toHaveClass(
		"cursor-text",
		"select-text",
		"text-muted-foreground",
	);
	const openModelLibrary = screen.getByRole("button", {
		name: "Open folder for Model Library",
	});
	expect(openModelLibrary).toHaveAccessibleDescription(
		"Kastard manages this folder and replaces its contents during model sync. Do not add files here directly.",
	);
	fireEvent.click(openModelLibrary);
	await waitFor(() =>
		expect(window.kastard.editorDirectories.open).toHaveBeenCalledWith("model-library"),
	);
});

test("navigates to Settings from the header and native menu event", async () => {
	const { unmount } = render(<App />);

	const comfyButton = screen.getByRole("button", { name: "ComfyUI" });
	const settingsButton = screen.getByRole("button", { name: "Settings" });
	const comfyFrame = await screen.findByTitle("ComfyUI");
	fireEvent.click(settingsButton);

	expect(settingsButton).toHaveAttribute("aria-current", "page");
	expect(comfyButton).not.toHaveAttribute("aria-current");
	expect(screen.getByTestId("settings-surface")).toBeVisible();
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
	expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
	const settingsNavigation = screen.getByRole("navigation", {
		name: "Settings sections",
	});
	const generalSection = within(settingsNavigation).getByRole("button", {
		name: "General",
	});
	expect(generalSection).toHaveAttribute("aria-current", "page");
	expect(settingsNavigation).toHaveTextContent(
		"GeneralComfyUIConnectionModel ProvidersHelpAbout",
	);

	fireEvent.click(comfyButton);
	expect(screen.queryByTestId("settings-surface")).not.toBeInTheDocument();
	expect(screen.getByTitle("ComfyUI")).toBe(comfyFrame);

	act(() => openSettingsFromMenu());
	expect(settingsButton).toHaveAttribute("aria-current", "page");
	const settingsHeading = screen.getByRole("heading", { name: "Settings" });
	await waitFor(() => expect(settingsHeading).toHaveFocus());

	openSettingsSection("Connection");
	const connectionSetting = screen.getByRole("switch", {
		name: /^Sync after connecting/,
	});
	connectionSetting.focus();
	expect(connectionSetting).toHaveFocus();
	act(() => openSettingsFromMenu());
	await waitFor(() => expect(settingsHeading).toHaveFocus());
	expect(screen.getByRole("heading", { name: "Connection", level: 2 })).toBeVisible();

	fireEvent.click(comfyButton);
	fireEvent.click(screen.getByRole("button", { name: "Connect" }));
	expect(screen.getByRole("dialog")).toBeVisible();
	act(() => openSettingsFromMenu());
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	await waitFor(() =>
		expect(screen.getByRole("heading", { name: "Settings" })).toHaveFocus(),
	);

	unmount();
	expect(hasOpenSettingsListener()).toBe(false);
});
