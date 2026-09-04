import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type {
	ConnectionResult,
	CustomNodeInstallResult,
	CustomNodeRemoveResult,
} from "../../shared/api";
import { App } from "./App";
import { emitComfyRuntime, emitWorkerSession } from "./App.test-harness";

test("keeps the Editor directory visible when opening it fails", async () => {
	vi.mocked(window.kastard.editorDirectories.open).mockResolvedValue({
		ok: false,
		error: "Could not open the folder. Finder is unavailable.",
	});
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	const path = await screen.findByText("/Users/test/Kastard/comfy/data/custom_nodes");
	fireEvent.click(screen.getByRole("button", { name: "Open folder for Custom Nodes" }));

	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Could not open the folder. Finder is unavailable.",
	);
	expect(path).toBeVisible();
});

test("lists custom nodes installed in local ComfyUI", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{
				name: "ComfyUI-DaSiWa-Nodes",
				version: "0.4.12",
				managerId: "ComfyUI-DaSiWa-Nodes",
				repository: "https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes",
				sync: true,
			},
			{
				name: "comfyui-kjnodes",
				version: "1.5.0",
				managerId: "comfyui-kjnodes",
				sync: false,
			},
			{
				name: "local-git-node",
				version: "a".repeat(40),
				managerId: null,
				repository: "https://github.com/owner/local-git-node.git",
				sync: true,
			},
			{
				name: "dirty-git-node",
				version: "b".repeat(40),
				managerId: null,
				repository: "https://github.com/owner/dirty-git-node.git",
				workerSyncIssue:
					"Tracked or untracked local changes are not included in the Git commit.",
				sync: true,
			},
			{
				name: "manual-node",
				version: "unknown",
				managerId: null,
				workerSyncIssue:
					"No Registry package or supported GitHub repository was found.",
				sync: true,
			},
		],
	});
	vi.mocked(window.kastard.customNodes.update).mockImplementation(async () => ({
		ok: true,
	}));
	render(<App />);

	const customNodesButton = screen.getByRole("button", { name: "Custom Nodes" });
	const modelLibraryButton = screen.getByRole("button", { name: "Model Library" });
	fireEvent.click(customNodesButton);

	expect(customNodesButton).toHaveAttribute("aria-current", "page");
	expect(modelLibraryButton).not.toHaveAttribute("aria-current");
	expect(await screen.findByRole("heading", { name: "Custom Nodes" })).toBeVisible();
	expect(
		screen.getByText("Choose which local custom nodes to sync to the Worker."),
	).toBeVisible();
	expect(screen.getByLabelText("Custom nodes summary")).toHaveTextContent("All5Sync4");
	expect(screen.getByText("ComfyUI-DaSiWa-Nodes")).toBeVisible();
	expect(screen.getByText("Version 0.4.12")).toBeVisible();
	const repository = screen.getByRole("link", {
		name: "https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes",
	});
	expect(repository).toHaveAttribute(
		"href",
		"https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes",
	);
	expect(repository).toHaveAttribute("target", "_blank");
	expect(screen.getByText("comfyui-kjnodes")).toBeVisible();
	expect(screen.getByText("Version 1.5.0")).toBeVisible();
	expect(
		screen.getByRole("link", {
			name: "https://github.com/owner/local-git-node.git",
		}),
	).toHaveAttribute("target", "_blank");
	expect(
		screen.getByRole("link", {
			name: "https://github.com/owner/dirty-git-node.git",
		}),
	).toHaveAttribute("target", "_blank");
	expect(
		screen.getByText(
			"Worker sync unsupported · Tracked or untracked local changes are not included in the Git commit.",
		),
	).toBeVisible();
	expect(
		screen.getByText(
			"Worker sync unsupported · No Registry package or supported GitHub repository was found.",
		),
	).toBeVisible();
	const dasiwaSync = screen.getByRole("switch", {
		name: "Sync ComfyUI-DaSiWa-Nodes",
	});
	expect(dasiwaSync).toBeChecked();
	expect(
		screen.getByRole("switch", { name: "Sync comfyui-kjnodes" }),
	).not.toBeChecked();

	dasiwaSync.focus();
	fireEvent.click(dasiwaSync);
	expect(dasiwaSync).toBeEnabled();
	expect(dasiwaSync).toHaveFocus();
	await waitFor(() =>
		expect(window.kastard.customNodes.update).toHaveBeenCalledWith({
			name: "ComfyUI-DaSiWa-Nodes",
			sync: false,
		}),
	);
	await waitFor(() => expect(dasiwaSync).not.toBeChecked());
	expect(screen.getByLabelText("Custom nodes summary")).toHaveTextContent("All5Sync3");
});

test("installs a trusted GitHub custom node and refreshes the local list", async () => {
	let finishInstallation: ((result: CustomNodeInstallResult) => void) | undefined;
	vi.mocked(window.kastard.customNodes.install).mockImplementation(
		() =>
			new Promise((resolve) => {
				finishInstallation = resolve;
			}),
	);
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	const addButton = await screen.findByRole("button", { name: "Add Custom Node" });
	await waitFor(() => expect(addButton).toBeEnabled());
	fireEvent.click(addButton);

	const dialog = screen.getByRole("dialog", { name: "Add Custom Node" });
	expect(dialog).toHaveTextContent(
		"ComfyUI Manager installs the Registry package when recognized; otherwise it clones the GitHub repository.",
	);
	expect(dialog).toHaveTextContent(
		"Only install code you trust. Installation may add Python dependencies and run repository scripts.",
	);
	const repository = screen.getByRole("textbox", { name: "GitHub repository URL" });
	fireEvent.change(repository, {
		target: { value: "https://github.com/Owner/New-Node/tree/main" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Install" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Enter a public GitHub repository URL.",
	);
	expect(window.kastard.customNodes.install).not.toHaveBeenCalled();

	fireEvent.change(repository, {
		target: { value: "https://github.com/Owner/New-Node" },
	});
	expect(screen.getByText("Checking ComfyUI Registry…")).toBeVisible();
	expect(
		await screen.findByText(
			"This repository is not registered. Manager will clone its default branch.",
		),
	).toBeVisible();
	expect(screen.queryByRole("combobox", { name: "Version" })).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Install" }));
	await waitFor(() =>
		expect(window.kastard.customNodes.install).toHaveBeenCalledWith({
			repository: "https://github.com/owner/new-node.git",
		}),
	);
	expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
	expect(repository).toBeVisible();

	const installedNode = {
		name: "new-node",
		version: "1.0.0",
		managerId: "new-node",
		repository: "https://github.com/owner/new-node.git",
		sync: true,
	};
	await act(async () => {
		finishInstallation?.({
			ok: true,
			node: installedNode,
			nodes: [installedNode],
			restartRequired: true,
		});
	});

	expect(await screen.findByText("new-node")).toBeVisible();
	expect(screen.getByRole("switch", { name: "Sync new-node" })).toBeChecked();
	expect(
		screen.queryByRole("dialog", { name: "Add Custom Node" }),
	).not.toBeInTheDocument();
	expect(
		screen.getByText("Installed new-node. Restart ComfyUI to load it."),
	).toBeVisible();
	expect(window.kastard.comfy.restart).not.toHaveBeenCalled();
	expect(window.kastard.workerSession.syncCustomNodes).not.toHaveBeenCalled();
});

test("offers registered releases and installs Nightly through Manager", async () => {
	vi.mocked(window.kastard.customNodes.getInstallOptions).mockResolvedValue({
		ok: true,
		options: {
			managerId: "registered-node",
			latestVersion: "1.2.3",
			versions: ["1.2.3", "1.2.2", "1.1.0"],
		},
	});
	vi.mocked(window.kastard.customNodes.install).mockResolvedValue({
		ok: false,
		error: "Installation stopped for this test.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	const addButton = await screen.findByRole("button", { name: "Add Custom Node" });
	await waitFor(() => expect(addButton).toBeEnabled());
	fireEvent.click(addButton);
	fireEvent.change(screen.getByRole("textbox", { name: "GitHub repository URL" }), {
		target: { value: "https://github.com/Owner/Registered-Node" },
	});

	const version = await screen.findByRole("combobox", { name: "Version" });
	expect(version).toHaveValue("1.2.3");
	expect(screen.getByRole("option", { name: "Latest (1.2.3)" })).toBeVisible();
	expect(
		screen.getByRole("option", { name: "Nightly (latest GitHub code)" }),
	).toBeVisible();
	expect(screen.getByRole("option", { name: "1.2.2" })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Install" }));
	await waitFor(() =>
		expect(window.kastard.customNodes.install).toHaveBeenCalledWith({
			repository: "https://github.com/owner/registered-node.git",
			version: "1.2.3",
		}),
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Install" })).toBeEnabled(),
	);
	vi.mocked(window.kastard.customNodes.install).mockClear();

	fireEvent.change(version, { target: { value: "nightly" } });
	expect(
		screen.getByText(
			"Nightly installs the latest code from the repository's default branch.",
		),
	).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Install" }));

	await waitFor(() =>
		expect(window.kastard.customNodes.install).toHaveBeenCalledWith({
			repository: "https://github.com/owner/registered-node.git",
			version: "nightly",
		}),
	);
});

test("ignores Registry options resolved for an older repository input", async () => {
	let resolveFirst:
		| ((
				result: Awaited<
					ReturnType<typeof window.kastard.customNodes.getInstallOptions>
				>,
		  ) => void)
		| undefined;
	vi.mocked(window.kastard.customNodes.getInstallOptions).mockImplementation(
		({ repository }) => {
			if (repository.endsWith("/first-node.git")) {
				return new Promise((resolve) => {
					resolveFirst = resolve;
				});
			}
			return Promise.resolve({ ok: true, options: null });
		},
	);
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	const addButton = await screen.findByRole("button", { name: "Add Custom Node" });
	await waitFor(() => expect(addButton).toBeEnabled());
	fireEvent.click(addButton);
	const repository = screen.getByRole("textbox", { name: "GitHub repository URL" });
	fireEvent.change(repository, {
		target: { value: "https://github.com/owner/first-node" },
	});
	await waitFor(() =>
		expect(window.kastard.customNodes.getInstallOptions).toHaveBeenCalledWith({
			repository: "https://github.com/owner/first-node.git",
		}),
	);
	fireEvent.change(repository, {
		target: { value: "https://github.com/owner/second-node" },
	});
	expect(
		await screen.findByText(
			"This repository is not registered. Manager will clone its default branch.",
		),
	).toBeVisible();

	await act(async () => {
		resolveFirst?.({
			ok: true,
			options: {
				managerId: "first-node",
				latestVersion: "9.9.9",
				versions: ["9.9.9"],
			},
		});
	});
	expect(screen.queryByRole("combobox", { name: "Version" })).not.toBeInTheDocument();
});

test("keeps the custom-node list and install form when Manager fails", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{
				name: "existing-node",
				version: "1.0.0",
				managerId: "existing-node",
				sync: true,
			},
		],
	});
	vi.mocked(window.kastard.customNodes.install).mockResolvedValue({
		ok: false,
		error: "ComfyUI Manager could not install the custom node.",
	});
	vi.mocked(window.kastard.customNodes.getInstallOptions).mockResolvedValue({
		ok: false,
		error: "ComfyUI Registry returned HTTP 503.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	const addButton = await screen.findByRole("button", { name: "Add Custom Node" });
	await waitFor(() => expect(addButton).toBeEnabled());
	fireEvent.click(addButton);
	fireEvent.change(screen.getByRole("textbox", { name: "GitHub repository URL" }), {
		target: { value: "https://github.com/owner/failing-node" },
	});
	expect(
		await screen.findByText(/Registry versions are unavailable\./),
	).toHaveTextContent("ComfyUI Registry returned HTTP 503.");
	fireEvent.click(screen.getByRole("button", { name: "Install" }));

	expect(await screen.findByRole("alert")).toHaveTextContent(
		"ComfyUI Manager could not install the custom node.",
	);
	expect(screen.getByRole("dialog", { name: "Add Custom Node" })).toBeVisible();
	expect(screen.getByText("existing-node")).toBeVisible();
	expect(window.kastard.customNodes.install).toHaveBeenCalledWith({
		repository: "https://github.com/owner/failing-node.git",
	});
});

test("removes a Manager-owned custom node only after uninstall succeeds", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{
				name: "comfyui-kjnodes",
				version: "1.5.0",
				managerId: "comfyui-kjnodes",
				sync: true,
			},
		],
	});
	let finishRemoval: ((result: CustomNodeRemoveResult) => void) | undefined;
	vi.mocked(window.kastard.customNodes.remove).mockImplementation(
		() =>
			new Promise((resolve) => {
				finishRemoval = resolve;
			}),
	);
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));

	fireEvent.click(
		await screen.findByRole("button", { name: "Delete comfyui-kjnodes" }),
	);
	const dialog = screen.getByRole("dialog", { name: "Uninstall custom node?" });
	expect(dialog).toHaveTextContent(
		"Uninstall comfyui-kjnodes with ComfyUI Manager? This removes only the local custom node. The Worker is not changed.",
	);
	fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
	await waitFor(() =>
		expect(window.kastard.customNodes.remove).toHaveBeenCalledWith({
			name: "comfyui-kjnodes",
		}),
	);
	expect(screen.getByText("comfyui-kjnodes")).toBeVisible();

	await act(async () => finishRemoval?.({ ok: true, restartRequired: true }));

	await waitFor(() =>
		expect(screen.queryByText("comfyui-kjnodes")).not.toBeInTheDocument(),
	);
	expect(
		screen.getByText(
			"Removed comfyui-kjnodes from Kastard. Restart ComfyUI to apply the change.",
		),
	).toBeVisible();
	expect(window.kastard.comfy.restart).not.toHaveBeenCalled();
	expect(window.kastard.workerSession.syncCustomNodes).not.toHaveBeenCalled();
});

test("disables deletion until the Editor state allows it and hides it during Worker sync", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{
				name: "ComfyUI-Manager",
				version: "4.2.2",
				managerId: null,
				sync: true,
			},
			{
				name: "manual-node",
				version: "unknown",
				managerId: null,
				sync: true,
			},
		],
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));

	expect(
		await screen.findByRole("button", { name: "Delete manual-node" }),
	).toBeVisible();
	const addButton = screen.getByRole("button", { name: "Add Custom Node" });
	expect(addButton).toBeEnabled();
	expect(
		screen.queryByRole("button", { name: "Delete ComfyUI-Manager" }),
	).not.toBeInTheDocument();

	act(() => emitComfyRuntime({ status: "starting" }));
	expect(screen.getByRole("button", { name: "Delete manual-node" })).toBeDisabled();
	expect(addButton).toBeDisabled();
	act(() =>
		emitComfyRuntime({
			status: "preparing",
			phase: "dependencies",
			progress: 50,
			firstRun: false,
		}),
	);
	expect(screen.getByRole("button", { name: "Delete manual-node" })).toBeDisabled();
	act(() => emitComfyRuntime({ status: "error", message: "Port unavailable." }));
	expect(screen.getByRole("button", { name: "Delete manual-node" })).toBeDisabled();
	act(() =>
		emitComfyRuntime({
			status: "error",
			message: "A custom node failed to load.",
			reason: "custom-node",
		}),
	);
	expect(screen.getByRole("button", { name: "Delete manual-node" })).toBeEnabled();
	expect(addButton).toBeDisabled();

	act(() => emitComfyRuntime({ status: "ready", url: "about:blank" }));
	expect(addButton).toBeEnabled();

	act(() => emitWorkerSession({ customNodes: { status: "loading" } }));
	await waitFor(() =>
		expect(
			screen.queryByRole("button", { name: "Delete manual-node" }),
		).not.toBeInTheDocument(),
	);
	expect(addButton).toBeDisabled();
	act(() =>
		emitWorkerSession({
			customNodes: {
				status: "unavailable",
				error: "Worker custom-node status is unavailable.",
				retryable: true,
			},
		}),
	);
	expect(screen.getByRole("button", { name: "Delete manual-node" })).toBeEnabled();
	expect(addButton).toBeEnabled();

	act(() =>
		emitWorkerSession({
			customNodes: {
				status: "syncing",
				phase: "install",
				current: 0,
				total: 1,
				currentNode: "manual-node",
				unsupportedNodes: [],
			},
		}),
	);
	await waitFor(() =>
		expect(
			screen.queryByRole("button", { name: "Delete manual-node" }),
		).not.toBeInTheDocument(),
	);
	expect(addButton).toBeDisabled();
});

test("uses Trash for startup recovery and keeps the Worker untouched", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{
				name: "broken-node",
				version: "unknown",
				managerId: "registered-node",
				sync: true,
			},
		],
	});
	vi.mocked(window.kastard.customNodes.remove).mockResolvedValue({
		ok: true,
		restartRequired: false,
	});
	render(<App />);
	await screen.findByTitle("ComfyUI");
	act(() =>
		emitComfyRuntime({
			status: "error",
			message: "(IMPORT FAILED): broken-node",
			reason: "custom-node",
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));

	fireEvent.click(await screen.findByRole("button", { name: "Delete broken-node" }));
	const dialog = screen.getByRole("dialog", { name: "Move custom node to Trash?" });
	expect(dialog).toHaveTextContent(
		"Move broken-node to Trash so ComfyUI can start again? This removes only the local custom node. The Worker is not changed.",
	);
	fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));

	expect(
		await screen.findByText("Moved broken-node to Trash. Try starting ComfyUI again."),
	).toBeVisible();
	expect(window.kastard.comfy.start).toHaveBeenCalledTimes(1);
	expect(window.kastard.comfy.restart).not.toHaveBeenCalled();
	expect(window.kastard.workerSession.syncCustomNodes).not.toHaveBeenCalled();
});

test("keeps a custom node when deletion fails", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{
				name: "manual-node",
				version: "unknown",
				managerId: null,
				sync: true,
			},
		],
	});
	vi.mocked(window.kastard.customNodes.remove).mockResolvedValue({
		ok: false,
		error: "Finder could not move the custom node to Trash.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	fireEvent.click(await screen.findByRole("button", { name: "Delete manual-node" }));
	fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));

	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Finder could not move the custom node to Trash.",
	);
	expect(screen.getByText("manual-node")).toBeVisible();
});

test("shows empty and error states for local custom nodes", async () => {
	const first = render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	expect(await screen.findByText("No custom nodes installed")).toBeVisible();
	expect(screen.getByLabelText("Custom nodes summary")).toHaveTextContent("All0Sync0");
	first.unmount();

	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: false,
		error: "ComfyUI Manager returned HTTP 503.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"ComfyUI Manager returned HTTP 503.",
	);
	expect(screen.queryByText("No custom nodes installed")).not.toBeInTheDocument();
	expect(screen.queryByLabelText("Custom nodes summary")).not.toBeInTheDocument();
});

test("restores custom-node sync selection when saving fails", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{
				name: "comfyui-kjnodes",
				version: "1.5.0",
				managerId: "comfyui-kjnodes",
				sync: true,
			},
		],
	});
	vi.mocked(window.kastard.customNodes.update).mockResolvedValue({
		ok: false,
		error: "Could not save custom-node sync settings.",
	});
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	const sync = await screen.findByRole("switch", { name: "Sync comfyui-kjnodes" });

	fireEvent.click(sync);
	expect(sync).not.toBeChecked();
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Could not save custom-node sync settings.",
	);
	expect(sync).toBeChecked();
});

test("saves rapid custom-node changes without dropping later selections", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{ name: "first-node", version: "1.0.0", managerId: "first-node", sync: true },
			{
				name: "second-node",
				version: "2.0.0",
				managerId: "second-node",
				sync: true,
			},
		],
	});
	const pending = new Map<string, (result: { ok: true }) => void>();
	vi.mocked(window.kastard.customNodes.update).mockImplementation(
		({ name }) =>
			new Promise((resolve) => {
				pending.set(name, resolve);
			}),
	);
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	const first = await screen.findByRole("switch", { name: "Sync first-node" });
	const second = screen.getByRole("switch", { name: "Sync second-node" });

	fireEvent.click(first);
	fireEvent.click(second);

	await waitFor(() =>
		expect(window.kastard.customNodes.update).toHaveBeenCalledTimes(2),
	);
	expect(first).not.toBeChecked();
	expect(second).not.toBeChecked();

	await act(async () => {
		pending.get("first-node")?.({ ok: true });
		pending.get("second-node")?.({ ok: true });
	});
});

test("restores the last confirmed sync value after queued saves fail", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{
				name: "queued-node",
				version: "1.0.0",
				managerId: "queued-node",
				sync: true,
			},
		],
	});
	const pending: Array<(result: ConnectionResult) => void> = [];
	vi.mocked(window.kastard.customNodes.update).mockImplementation(
		() =>
			new Promise((resolve) => {
				pending.push(resolve);
			}),
	);
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	const sync = await screen.findByRole("switch", { name: "Sync queued-node" });

	fireEvent.click(sync);
	fireEvent.click(sync);
	expect(sync).toBeChecked();
	await waitFor(() =>
		expect(window.kastard.customNodes.update).toHaveBeenCalledTimes(1),
	);

	await act(async () => {
		pending[0]?.({ ok: false, error: "First save failed." });
	});
	await waitFor(() =>
		expect(window.kastard.customNodes.update).toHaveBeenCalledTimes(2),
	);
	await act(async () => {
		pending[1]?.({ ok: false, error: "Second save failed." });
	});

	expect(await screen.findByRole("alert")).toHaveTextContent("Second save failed.");
	expect(sync).toBeChecked();
});

test("clears an earlier save error when the latest queued save succeeds", async () => {
	vi.mocked(window.kastard.customNodes.list).mockResolvedValue({
		ok: true,
		nodes: [
			{
				name: "queued-node",
				version: "1.0.0",
				managerId: "queued-node",
				sync: true,
			},
		],
	});
	const pending: Array<(result: ConnectionResult) => void> = [];
	vi.mocked(window.kastard.customNodes.update).mockImplementation(
		() =>
			new Promise((resolve) => {
				pending.push(resolve);
			}),
	);
	render(<App />);
	fireEvent.click(screen.getByRole("button", { name: "Custom Nodes" }));
	const sync = await screen.findByRole("switch", { name: "Sync queued-node" });

	fireEvent.click(sync);
	fireEvent.click(sync);
	await waitFor(() =>
		expect(window.kastard.customNodes.update).toHaveBeenCalledTimes(1),
	);
	await act(async () => {
		pending[0]?.({ ok: false, error: "First save failed." });
	});
	expect(await screen.findByRole("alert")).toHaveTextContent("First save failed.");
	await waitFor(() =>
		expect(window.kastard.customNodes.update).toHaveBeenCalledTimes(2),
	);

	await act(async () => {
		pending[1]?.({ ok: true });
	});

	await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
	expect(sync).toBeChecked();
});
