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
	ConnectionResult,
	SyncCompletionNotificationSettingsResult,
} from "../../shared/api";
import { App } from "./App";
import {
	comfyVersionState,
	emitComfyRuntime,
	openSettingsSection,
} from "./App.test-harness";

test("shows external Help resources above About", () => {
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Help");

	expect(screen.getByRole("heading", { name: "Help", level: 2 })).toBeVisible();
	const resources = screen.getByRole("region", { name: "Help resources" });
	const expectedLinks = [
		["Docs", "https://github.com/somecatco/kastard/blob/main/docs/en/index.mdx"],
		["GitHub", "https://github.com/somecatco/kastard"],
		["Discord", "https://discord.gg/Z9eUBVFncN"],
	] as const;

	for (const [name, href] of expectedLinks) {
		const link = within(resources).getByRole("link", { name: new RegExp(`^${name}`) });
		expect(link).toHaveAttribute("href", href);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noreferrer");
		expect(link.firstElementChild?.querySelector("svg")).not.toBeNull();
		expect(link.lastElementChild?.tagName).toBe("svg");
	}
});

test("resets Settings content scroll position when changing sections", () => {
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	const content = screen.getByRole("heading", { name: "General" }).parentElement
		?.parentElement;
	if (content === null || content === undefined) {
		throw new Error("Settings content container was not found.");
	}
	content.scrollTop = 240;

	openSettingsSection("About");

	expect(content).toHaveProperty("scrollTop", 0);
});

test("associates Settings selects with selectable descriptions", async () => {
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	const theme = screen.getByRole("combobox", { name: "Theme" });
	expect(theme).toHaveAccessibleDescription(
		"Follow the system appearance or always use light or dark.",
	);
	expect(
		screen.getByText("Follow the system appearance or always use light or dark."),
	).toHaveClass("select-text");

	openSettingsSection("ComfyUI");
	const backend = screen.getByRole("combobox", { name: "Backend" });
	await waitFor(() => expect(backend).toBeEnabled());
	expect(backend).toHaveAccessibleDescription(
		"The ComfyUI that supplies nodes here and that a connected Worker is synchronized to.",
	);
	expect(
		screen.getByText(
			"The ComfyUI that supplies nodes here and that a connected Worker is synchronized to.",
		),
	).toHaveClass("select-text");
});

test("keeps Settings usable when application information is unavailable", async () => {
	vi.mocked(window.kastard.appInfo.get).mockRejectedValueOnce(
		new Error("Application information unavailable."),
	);
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("About");

	const application = screen.getByRole("region", {
		name: "Application information",
	});
	const applicationError = await within(application).findByRole("alert");
	expect(applicationError).toHaveTextContent("Application information unavailable.");
	expect(applicationError).toHaveClass("select-text");
	expect(applicationError).toHaveAttribute("aria-atomic", "true");
	expect(within(application).getAllByText("Unavailable")).toHaveLength(5);
	openSettingsSection("Connection");
	expect(screen.getByRole("switch", { name: /^Sync after connecting/ })).toBeEnabled();
});

test("copies a sanitized debug snapshot from About", async () => {
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("About");
	const application = screen.getByRole("region", {
		name: "Application information",
	});
	expect(await within(application).findByText("0.1.0")).toBeVisible();
	expect(await within(application).findByText("1")).toBeVisible();
	expect(await within(application).findByText("Production")).toBeVisible();
	expect(within(application).getByText("macOS 25.0.0 · arm64")).toHaveClass(
		"select-text",
	);
	expect(
		within(application).getByText(
			"Electron 43.4.0 · Chrome 144.0.7559.220 · Node 24.13.0",
		),
	).toHaveClass("select-text");
	fireEvent.click(screen.getByRole("button", { name: "Copy debug info" }));

	await waitFor(() => expect(window.kastard.debugInfo.copy).toHaveBeenCalledOnce());
	const report = vi.mocked(window.kastard.debugInfo.copy).mock.calls[0]?.[0];
	expect(report).toContain(
		"Application\nApp Version: 0.1.0\nApp Build: 1\nChannel: Production",
	);
	expect(report).toContain("Platform: macOS 25.0.0 · arm64");
	expect(report).toContain("Editor ComfyUI\nFrontend: v1.49.6 (bundled)");
	expect(report).toContain("Worker\nConnection: disconnected");
	expect(
		screen.getByRole("button", { name: "Copied — copy debug info" }),
	).toBeVisible();
	expect(screen.getByText("Debug information copied.")).toHaveClass("select-text");
});

test("shows a selectable debug info copy error", async () => {
	vi.mocked(window.kastard.debugInfo.copy).mockResolvedValueOnce({
		ok: false,
		error: "Could not copy debug information.",
	});
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("About");
	fireEvent.click(screen.getByRole("button", { name: "Copy debug info" }));

	const alert = await screen.findByRole("alert");
	expect(alert).toHaveTextContent("Could not copy debug information.");
	expect(alert).toHaveClass("select-text");
	expect(alert).toHaveAttribute("aria-atomic", "true");
});

test("marks which ComfyUI versions are installed", async () => {
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const backend = screen.getByRole("combobox", { name: "Backend" });
	await waitFor(() => expect(backend).toBeEnabled());
	expect(backend).toHaveValue("0.34.0");
	expect(screen.getByRole("combobox", { name: "Frontend" })).toHaveValue("v1.49.6");
	expect(screen.getByRole("combobox", { name: "Manager" })).toHaveValue("");
	expect(
		screen.getByRole("option", { name: "Follow Backend pin · 4.2.2" }),
	).toBeInTheDocument();
	expect(
		screen.getByRole("option", { name: "0.34.0 · installed" }),
	).toBeInTheDocument();
	expect(screen.getByRole("option", { name: "0.33.1" })).toBeInTheDocument();
	expect(screen.getByRole("option", { name: "4.3.0" })).toBeInTheDocument();
	expect(screen.getByText(/Backend 0\.34\.0 pins/)).toHaveTextContent(
		"Backend 0.34.0 pins 4.2.2.",
	);
});

test("restarts ComfyUI and blocks version changes until it is ready", async () => {
	let resolveRestart: (result: ConnectionResult) => void = () => undefined;
	vi.mocked(window.kastard.comfy.restart).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveRestart = resolve;
			}),
	);
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const backend = screen.getByRole("combobox", { name: "Backend" });
	const restart = screen.getByRole("button", { name: "Restart" });
	await waitFor(() => expect(backend).toBeEnabled());
	const restartLabel = screen.getByText("Restart ComfyUI");
	const locationLabel = screen.getByText("Location");
	expect(restartLabel).toBeVisible();
	expect(
		restartLabel.compareDocumentPosition(locationLabel) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		locationLabel.compareDocumentPosition(backend) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		screen.getByText("Restart ComfyUI to apply newly installed custom nodes."),
	).toHaveClass("select-text");
	fireEvent.click(restart);

	await waitFor(() => expect(window.kastard.comfy.restart).toHaveBeenCalledOnce());
	expect(restart).toBeDisabled();
	expect(restart).toHaveTextContent("Restarting…");
	expect(backend).toBeDisabled();
	expect(screen.getByRole("combobox", { name: "Frontend" })).toBeDisabled();
	expect(screen.getByRole("combobox", { name: "Manager" })).toBeDisabled();
	fireEvent.click(
		within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole(
			"button",
			{ name: "ComfyUI" },
		),
	);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const resumedRestart = screen.getByRole("button", { name: "Restarting…" });
	const resumedBackend = screen.getByRole("combobox", { name: "Backend" });
	expect(resumedRestart).toBeDisabled();
	expect(resumedBackend).toBeDisabled();
	fireEvent.click(resumedRestart);
	expect(window.kastard.comfy.restart).toHaveBeenCalledOnce();

	await act(async () => resolveRestart({ ok: true }));

	await waitFor(() =>
		expect(screen.getByRole("status")).toHaveTextContent("ComfyUI restarted."),
	);
	expect(screen.getByRole("status")).toHaveClass("select-text");
	expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
	expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
	expect(resumedBackend).toBeEnabled();
});

test("shows a selectable ComfyUI restart error", async () => {
	vi.mocked(window.kastard.comfy.restart).mockResolvedValueOnce({
		ok: false,
		error: "ComfyUI could not restart.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const restart = screen.getByRole("button", { name: "Restart" });
	await waitFor(() => expect(restart).toBeEnabled());
	fireEvent.click(restart);

	await waitFor(() =>
		expect(screen.getByRole("alert")).toHaveTextContent("ComfyUI could not restart."),
	);
	const alert = screen.getByRole("alert");
	expect(alert).toHaveTextContent("ComfyUI could not restart.");
	expect(alert).toHaveClass("select-text");
	expect(alert).toHaveAttribute("aria-atomic", "true");
	expect(restart).toBeEnabled();
});

test("blocks restart and version changes while ComfyUI restarts elsewhere", async () => {
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const restart = screen.getByRole("button", { name: "Restart" });
	const backend = screen.getByRole("combobox", { name: "Backend" });
	await waitFor(() => expect(restart).toBeEnabled());
	act(() => emitComfyRuntime({ status: "idle" }));

	expect(restart).toBeDisabled();
	expect(backend).toBeDisabled();

	act(() => emitComfyRuntime({ status: "ready", url: "about:blank" }));
	expect(restart).toBeEnabled();
	expect(backend).toBeEnabled();
});

test("switches the ComfyUI version only after it is confirmed", async () => {
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const backend = screen.getByRole("combobox", { name: "Backend" });
	await waitFor(() => expect(backend).toBeEnabled());
	fireEvent.change(backend, { target: { value: "0.33.1" } });

	const dialog = await screen.findByRole("dialog");
	expect(dialog).toHaveTextContent("Kastard will download 0.33.1 from GitHub");
	expect(window.kastard.comfyVersions.select).not.toHaveBeenCalled();

	fireEvent.click(within(dialog).getByRole("button", { name: "Download and switch" }));

	await waitFor(() =>
		expect(window.kastard.comfyVersions.select).toHaveBeenCalledWith({
			component: "backend",
			version: "0.33.1",
		}),
	);
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

test("installs and switches ComfyUI Manager only after it is confirmed", async () => {
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const manager = screen.getByRole("combobox", { name: "Manager" });
	await waitFor(() => expect(manager).toBeEnabled());
	fireEvent.change(manager, { target: { value: "4.3.0" } });

	const dialog = await screen.findByRole("dialog");
	expect(dialog).toHaveTextContent("install Manager 4.3.0 from PyPI");
	expect(window.kastard.comfyVersions.select).not.toHaveBeenCalled();

	fireEvent.click(within(dialog).getByRole("button", { name: "Install and switch" }));

	await waitFor(() =>
		expect(window.kastard.comfyVersions.select).toHaveBeenCalledWith({
			component: "manager",
			version: "4.3.0",
		}),
	);
});

test("returns an explicit Manager override to the Backend pin", async () => {
	vi.mocked(window.kastard.comfyVersions.getState).mockResolvedValue({
		ok: true,
		state: {
			...comfyVersionState,
			selection: { frontend: null, backend: null, manager: "4.2.2" },
		},
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const manager = screen.getByRole("combobox", { name: "Manager" });
	await waitFor(() => expect(manager).toHaveValue("4.2.2"));
	fireEvent.change(manager, { target: { value: "" } });

	const dialog = await screen.findByRole("dialog");
	expect(dialog).toHaveTextContent("follow the Backend-pinned Manager 4.2.2");
	fireEvent.click(within(dialog).getByRole("button", { name: "Switch" }));

	await waitFor(() =>
		expect(window.kastard.comfyVersions.select).toHaveBeenCalledWith({
			component: "manager",
			version: null,
		}),
	);
});

test("warns that the replaced ComfyUI release is removed", async () => {
	vi.mocked(window.kastard.comfyVersions.getState).mockResolvedValue({
		ok: true,
		state: {
			...comfyVersionState,
			selection: { frontend: null, backend: "0.33.1", manager: null },
		},
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const backend = screen.getByRole("combobox", { name: "Backend" });
	await waitFor(() => expect(backend).toHaveValue("0.33.1"));
	fireEvent.change(backend, { target: { value: "0.34.0" } });

	expect(await screen.findByRole("dialog")).toHaveTextContent(
		"0.33.1 is removed afterwards.",
	);
});

test("keeps the current ComfyUI version when the switch is canceled", async () => {
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const frontend = screen.getByRole("combobox", { name: "Frontend" });
	await waitFor(() => expect(frontend).toBeEnabled());
	fireEvent.change(frontend, { target: { value: "v1.52.1" } });

	const dialog = await screen.findByRole("dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	expect(window.kastard.comfyVersions.select).not.toHaveBeenCalled();
	expect(frontend).toHaveValue("v1.49.6");
});

test("keeps the current ComfyUI version when installing a release fails", async () => {
	vi.mocked(window.kastard.comfyVersions.select).mockResolvedValueOnce({
		ok: false,
		error: "Download failed with HTTP 500.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const backend = screen.getByRole("combobox", { name: "Backend" });
	await waitFor(() => expect(backend).toBeEnabled());
	fireEvent.change(backend, { target: { value: "0.33.1" } });
	const dialog = await screen.findByRole("dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Download and switch" }));

	expect(await within(dialog).findByRole("alert")).toHaveTextContent(
		"Download failed with HTTP 500.",
	);
	expect(backend).toHaveValue("0.34.0");
});

test("keeps the current Manager when its runtime switch fails", async () => {
	vi.mocked(window.kastard.comfyVersions.select).mockResolvedValueOnce({
		ok: false,
		error: "Manager dependencies failed.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("ComfyUI");

	const manager = screen.getByRole("combobox", { name: "Manager" });
	await waitFor(() => expect(manager).toBeEnabled());
	fireEvent.change(manager, { target: { value: "4.3.0" } });
	const dialog = await screen.findByRole("dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Install and switch" }));

	expect(await within(dialog).findByRole("alert")).toHaveTextContent(
		"Manager dependencies failed.",
	);
	expect(manager).toHaveValue("");
});

test("loads and saves the desktop theme in Settings", async () => {
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));

	const theme = screen.getByRole("combobox", { name: "Theme" });
	await waitFor(() => expect(theme).toBeEnabled());
	expect(theme).toHaveValue("system");

	fireEvent.change(theme, { target: { value: "dark" } });

	await waitFor(() => expect(window.kastard.theme.update).toHaveBeenCalledWith("dark"));
	expect(theme).toHaveValue("dark");
	await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
});

test("keeps the previous desktop theme when saving fails", async () => {
	vi.mocked(window.kastard.theme.update).mockResolvedValueOnce({
		ok: false,
		error: "The desktop theme could not be saved.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));

	const theme = screen.getByRole("combobox", { name: "Theme" });
	await waitFor(() => expect(theme).toBeEnabled());
	fireEvent.change(theme, { target: { value: "light" } });

	const alert = await screen.findByRole("alert");
	expect(alert).toHaveTextContent("The desktop theme could not be saved.");
	expect(alert).toHaveClass("select-text");
	expect(theme).toHaveValue("system");
});

test("loads and saves sync completion notification settings", async () => {
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));

	const notification = screen.getByRole("switch", {
		name: /^Worker setup complete/,
	});
	await waitFor(() => expect(notification).toBeEnabled());
	expect(notification).toBeChecked();

	fireEvent.click(notification);

	await waitFor(() =>
		expect(
			window.kastard.syncCompletionNotification.updateSettings,
		).toHaveBeenCalledWith({ enabled: false }),
	);
	expect(notification).not.toBeChecked();
});

test("keeps rapid notification selections optimistic while saving in order", async () => {
	const pending: Array<{
		enabled: boolean;
		resolve: (result: SyncCompletionNotificationSettingsResult) => void;
	}> = [];
	vi.mocked(
		window.kastard.syncCompletionNotification.updateSettings,
	).mockImplementation(
		({ enabled }) =>
			new Promise((resolve) => {
				pending.push({ enabled, resolve });
			}),
	);
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));

	const notification = screen.getByRole("switch", {
		name: /^Worker setup complete/,
	});
	await waitFor(() => expect(notification).toBeEnabled());
	fireEvent.click(notification);
	expect(notification).not.toBeChecked();
	expect(notification).toBeEnabled();
	fireEvent.click(notification);
	expect(notification).toBeChecked();

	await waitFor(() =>
		expect(
			window.kastard.syncCompletionNotification.updateSettings,
		).toHaveBeenCalledTimes(1),
	);
	const first = pending[0];
	if (!first) throw new Error("The first notification update was not started.");
	await act(async () => {
		first.resolve({ ok: true, settings: { enabled: first.enabled } });
	});
	await waitFor(() =>
		expect(
			window.kastard.syncCompletionNotification.updateSettings,
		).toHaveBeenCalledTimes(2),
	);
	expect(notification).toBeChecked();

	const second = pending[1];
	if (!second) throw new Error("The second notification update was not started.");
	await act(async () => {
		second.resolve({ ok: true, settings: { enabled: second.enabled } });
	});
	expect(first.enabled).toBe(false);
	expect(second.enabled).toBe(true);
});

test("shows sync completion notifications disabled after a load error and recovers", async () => {
	vi.mocked(
		window.kastard.syncCompletionNotification.getSettings,
	).mockResolvedValueOnce({
		ok: false,
		error: "The saved sync completion notification settings are invalid.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));

	const notification = screen.getByRole("switch", {
		name: /^Worker setup complete/,
	});
	await waitFor(() => expect(notification).toBeEnabled());
	expect(notification).not.toBeChecked();
	expect(screen.getByRole("alert")).toHaveTextContent(
		"The saved sync completion notification settings are invalid.",
	);

	fireEvent.click(notification);

	await waitFor(() =>
		expect(
			window.kastard.syncCompletionNotification.updateSettings,
		).toHaveBeenCalledWith({ enabled: true }),
	);
	expect(notification).toBeChecked();
});

test("keeps sync completion notifications enabled when saving fails", async () => {
	vi.mocked(
		window.kastard.syncCompletionNotification.updateSettings,
	).mockResolvedValueOnce({
		ok: false,
		error: "The notification setting could not be saved.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Settings" }));

	const notification = screen.getByRole("switch", {
		name: /^Worker setup complete/,
	});
	await waitFor(() => expect(notification).toBeEnabled());
	fireEvent.click(notification);

	const alert = await screen.findByRole("alert");
	expect(alert).toHaveTextContent("The notification setting could not be saved.");
	expect(alert).toHaveClass("select-text");
	expect(notification).toBeChecked();
});

test("keeps the General section open while notification settings are saving", async () => {
	let finishUpdate = (): void => undefined;
	vi.mocked(
		window.kastard.syncCompletionNotification.updateSettings,
	).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishUpdate = () => resolve({ ok: true, settings: { enabled: false } });
			}),
	);
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	const notification = screen.getByRole("switch", {
		name: /^Worker setup complete/,
	});
	await waitFor(() => expect(notification).toBeEnabled());
	fireEvent.click(notification);
	expect(notification).not.toBeChecked();
	expect(notification).toBeEnabled();

	const comfySection = within(
		screen.getByRole("navigation", { name: "Settings sections" }),
	).getByRole("button", { name: "ComfyUI" });
	await waitFor(() => expect(comfySection).toHaveAttribute("aria-disabled", "true"));
	expect(comfySection).toBeEnabled();
	fireEvent.click(comfySection);
	expect(screen.getByRole("heading", { name: "General" })).toBeVisible();

	await act(async () => finishUpdate());
	await waitFor(() => expect(comfySection).not.toHaveAttribute("aria-disabled"));
	fireEvent.click(comfySection);
	expect(screen.getByRole("heading", { name: "ComfyUI" })).toBeVisible();
});

test("saves and removes each model provider token without reading it back", async () => {
	let configured = { huggingface: false, civitai: false };
	vi.mocked(window.kastard.modelProviders.updateToken).mockImplementation(
		async ({ provider, token }) => {
			configured = { ...configured, [provider]: token !== null };
			return { ok: true, configured };
		},
	);
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Model Providers");
	const huggingFaceToken = await screen.findByLabelText("Hugging Face token");
	const civitaiToken = screen.getByLabelText("CivitAI token");

	fireEvent.change(huggingFaceToken, { target: { value: "hf_example-token" } });
	fireEvent.click(screen.getByRole("button", { name: "Save Hugging Face token" }));
	await waitFor(() =>
		expect(window.kastard.modelProviders.updateToken).toHaveBeenCalledWith({
			provider: "huggingface",
			token: "hf_example-token",
		}),
	);
	await waitFor(() =>
		expect(screen.queryByLabelText("Hugging Face token")).not.toBeInTheDocument(),
	);
	expect(
		screen.getByRole("button", { name: "Remove Hugging Face token" }),
	).toBeVisible();

	fireEvent.change(civitaiToken, { target: { value: "civitai-example-token" } });
	fireEvent.click(screen.getByRole("button", { name: "Save CivitAI token" }));
	await waitFor(() =>
		expect(window.kastard.modelProviders.updateToken).toHaveBeenCalledWith({
			provider: "civitai",
			token: "civitai-example-token",
		}),
	);
	await waitFor(() =>
		expect(screen.queryByLabelText("CivitAI token")).not.toBeInTheDocument(),
	);
	expect(screen.getByRole("button", { name: "Remove CivitAI token" })).toBeVisible();

	fireEvent.click(screen.getByRole("button", { name: "Remove Hugging Face token" }));
	await waitFor(() =>
		expect(window.kastard.modelProviders.updateToken).toHaveBeenLastCalledWith({
			provider: "huggingface",
			token: null,
		}),
	);
});

test("requires editing before replacing a configured model provider token", async () => {
	let configured = { huggingface: true, civitai: false };
	vi.mocked(window.kastard.modelProviders.getSettings).mockResolvedValueOnce({
		ok: true,
		configured,
	});
	vi.mocked(window.kastard.modelProviders.updateToken).mockImplementation(
		async ({ provider, token }) => {
			configured = { ...configured, [provider]: token !== null };
			return { ok: true, configured };
		},
	);
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Model Providers");
	const edit = await screen.findByRole("button", {
		name: "Edit Hugging Face token",
	});
	expect(screen.queryByLabelText("Hugging Face token")).not.toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Remove Hugging Face token" }),
	).toBeVisible();

	fireEvent.click(edit);
	let token = screen.getByLabelText("Hugging Face token");
	await waitFor(() => expect(token).toHaveFocus());
	expect(token).toHaveAttribute("type", "password");
	expect(token).toHaveValue("");
	expect(
		screen.getByRole("button", { name: "Save Hugging Face token" }),
	).toBeDisabled();

	fireEvent.change(token, { target: { value: "discarded-token" } });
	fireEvent.click(
		screen.getByRole("button", { name: "Cancel editing Hugging Face token" }),
	);
	expect(screen.queryByLabelText("Hugging Face token")).not.toBeInTheDocument();
	expect(window.kastard.modelProviders.updateToken).not.toHaveBeenCalled();
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Edit Hugging Face token" }),
		).toHaveFocus(),
	);

	fireEvent.click(screen.getByRole("button", { name: "Edit Hugging Face token" }));
	token = screen.getByLabelText("Hugging Face token");
	expect(token).toHaveValue("");
	fireEvent.change(token, { target: { value: "replacement-token" } });
	fireEvent.click(screen.getByRole("button", { name: "Save Hugging Face token" }));

	await waitFor(() =>
		expect(window.kastard.modelProviders.updateToken).toHaveBeenCalledWith({
			provider: "huggingface",
			token: "replacement-token",
		}),
	);
	await waitFor(() =>
		expect(screen.queryByLabelText("Hugging Face token")).not.toBeInTheDocument(),
	);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Edit Hugging Face token" }),
		).toHaveFocus(),
	);
	const saved = screen.getByRole("status");
	expect(saved).toHaveTextContent("Token saved.");
	expect(saved).toHaveClass("select-text");
	expect(saved).toHaveAttribute("aria-atomic", "true");

	fireEvent.click(screen.getByRole("button", { name: "Edit Hugging Face token" }));
	expect(screen.queryByText("Token saved.")).not.toBeInTheDocument();
});

test("keeps a configured token editor open when replacement fails", async () => {
	let failUpdate = (): void => undefined;
	vi.mocked(window.kastard.modelProviders.getSettings).mockResolvedValueOnce({
		ok: true,
		configured: { huggingface: true, civitai: false },
	});
	vi.mocked(window.kastard.modelProviders.updateToken).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				failUpdate = () =>
					resolve({
						ok: false,
						error: "Could not replace the provider token.",
					});
			}),
	);
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Model Providers");
	fireEvent.click(
		await screen.findByRole("button", { name: "Edit Hugging Face token" }),
	);
	const token = screen.getByLabelText("Hugging Face token");
	fireEvent.change(token, { target: { value: "replacement-token" } });
	fireEvent.click(screen.getByRole("button", { name: "Save Hugging Face token" }));
	token.blur();
	await act(async () => failUpdate());

	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Could not replace the provider token.",
	);
	expect(token).toHaveValue("replacement-token");
	await waitFor(() => expect(token).toHaveFocus());
	expect(
		screen.getByRole("button", { name: "Cancel editing Hugging Face token" }),
	).toBeVisible();

	fireEvent.click(
		screen.getByRole("button", { name: "Cancel editing Hugging Face token" }),
	);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Edit Hugging Face token" }),
		).toHaveFocus(),
	);
});

test("keeps the model provider section open while a token update is pending", async () => {
	let finishUpdate = (): void => undefined;
	vi.mocked(window.kastard.modelProviders.updateToken).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishUpdate = () =>
					resolve({
						ok: true,
						configured: { huggingface: true, civitai: false },
					});
			}),
	);
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Model Providers");
	const huggingFaceToken = await screen.findByLabelText("Hugging Face token");
	fireEvent.change(huggingFaceToken, { target: { value: "hf_example-token" } });
	fireEvent.click(screen.getByRole("button", { name: "Save Hugging Face token" }));

	const generalSection = within(
		screen.getByRole("navigation", { name: "Settings sections" }),
	).getByRole("button", { name: "General" });
	await waitFor(() => expect(generalSection).toHaveAttribute("aria-disabled", "true"));
	expect(generalSection).toBeEnabled();
	fireEvent.click(generalSection);
	expect(screen.getByRole("heading", { name: "Model Providers" })).toBeVisible();

	await act(async () => finishUpdate());
	await waitFor(() => expect(generalSection).not.toHaveAttribute("aria-disabled"));
	fireEvent.click(generalSection);
	expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
});

test("shows a model-provider load error for the whole section", async () => {
	vi.mocked(window.kastard.modelProviders.getSettings).mockResolvedValueOnce({
		ok: false,
		error: "The encrypted model-provider settings are invalid.",
	});
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Settings" }));
	openSettingsSection("Model Providers");
	const providerSection = await screen.findByRole("region", {
		name: "Model provider settings",
	});
	expect(providerSection.getElementsByClassName("text-destructive")).toHaveLength(1);
	expect(screen.getByRole("alert")).toHaveTextContent(
		"The encrypted model-provider settings are invalid.",
	);
	expect(screen.getByRole("alert")).toHaveClass("select-text");
	expect(screen.getByRole("alert")).toHaveAttribute("aria-atomic", "true");
	expect(screen.getAllByText("Unavailable")).toHaveLength(2);
	expect(screen.getByLabelText("Hugging Face token")).toBeDisabled();
	expect(screen.getByLabelText("CivitAI token")).toBeDisabled();
});
