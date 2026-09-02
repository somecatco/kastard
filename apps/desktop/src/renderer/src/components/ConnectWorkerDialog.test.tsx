import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ConnectWorkerDialog } from "./ConnectWorkerDialog";

afterEach(cleanup);

test("shows concise Worker setup descriptions", () => {
	render(
		<ConnectWorkerDialog
			initialProvider={null}
			initialServerUrl={null}
			initialSyncAfterConnect={true}
			onConnect={vi.fn()}
			onConnected={vi.fn()}
			onOpenChange={vi.fn()}
		/>,
	);

	const dialog = screen.getByRole("dialog");
	for (const name of [
		"RunPod Deploy a Worker with a Kastard template.",
		"Vast.ai Deploy a Worker with a Kastard template.",
		"Other server Connect to a Worker running on another server.",
	]) {
		expect(within(dialog).getByRole("button", { name })).toBeVisible();
	}

	fireEvent.click(within(dialog).getByRole("button", { name: /^Other server/ }));
	expect(within(dialog).getByText("Start a Worker on your server.")).toBeVisible();
	expect(
		within(dialog).getByRole("link", { name: "Open setup guide" }),
	).toHaveAttribute(
		"href",
		"https://github.com/ssinss/kastard/blob/main/docs/en/run-worker-with-docker.mdx",
	);
});

test("submits the final provider, address, and authentication code", async () => {
	const onConnect = vi.fn().mockResolvedValue({ ok: true });
	const onConnected = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<ConnectWorkerDialog
			initialProvider={null}
			initialServerUrl={null}
			initialSyncAfterConnect={true}
			onConnect={onConnect}
			onConnected={onConnected}
			onOpenChange={onOpenChange}
		/>,
	);

	const dialog = screen.getByRole("dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: /^RunPod/ }));
	expect(within(dialog).getAllByRole("link", { name: /template/ })).toHaveLength(2);
	expect(
		within(dialog).getByText(
			"Use the code from the Worker log. It remains valid until this Worker stops.",
		),
	).toBeVisible();
	expect(within(dialog).getByLabelText("Authentication code")).toHaveAttribute(
		"placeholder",
		"ABCD-EFGH-JKLM-NPQR",
	);
	fireEvent.change(within(dialog).getByLabelText("Worker address"), {
		target: { value: "203.0.113.10:22001" },
	});
	fireEvent.change(within(dialog).getByLabelText("Authentication code"), {
		target: { value: "ABCD-EFGH-JKLM-NPQR" },
	});

	fireEvent.click(within(dialog).getByRole("button", { name: /^Vast.ai/ }));
	expect(
		within(dialog).getByRole("link", { name: "CUDA 12.8 template" }),
	).toHaveAttribute(
		"href",
		"https://cloud.vast.ai/?creator_id=153845&name=kastard-worker-cu128",
	);
	expect(
		within(dialog).getByRole("link", { name: "CUDA 13.0 template" }),
	).toHaveAttribute(
		"href",
		"https://cloud.vast.ai/?creator_id=153845&name=kastard-worker-cu130",
	);
	expect(within(dialog).getByLabelText("Worker address")).toHaveValue("");
	expect(within(dialog).getByLabelText("Authentication code")).toHaveValue("");
	fireEvent.change(within(dialog).getByLabelText("Worker address"), {
		target: { value: "203.0.113.10:34220" },
	});
	fireEvent.change(within(dialog).getByLabelText("Authentication code"), {
		target: { value: "WXYZ-2345-ABCD-EFGH" },
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

	await waitFor(() =>
		expect(onConnect).toHaveBeenCalledWith({
			provider: "vastai",
			serverUrl: "203.0.113.10:34220",
			authenticationCode: "WXYZ-2345-ABCD-EFGH",
			syncAfterConnect: true,
		}),
	);
	expect(onConnected).toHaveBeenCalledWith(true);
	expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("keeps the dialog open and shows a failed connection", async () => {
	const onOpenChange = vi.fn();
	render(
		<ConnectWorkerDialog
			initialProvider="other"
			initialServerUrl="worker.example.com:22001"
			initialSyncAfterConnect={false}
			onConnect={async () => ({ ok: false, error: "Worker unavailable." })}
			onConnected={vi.fn()}
			onOpenChange={onOpenChange}
		/>,
	);
	fireEvent.change(screen.getByLabelText("Authentication code"), {
		target: { value: "ABCD-EFGH-JKLM-NPQR" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Connect" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Worker unavailable.");
	expect(screen.getByRole("dialog")).toBeVisible();
	expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("prevents dismissal while a connection is pending", async () => {
	let resolveConnect: ((result: { ok: false; error: string }) => void) | undefined;
	const onConnect = vi.fn(
		() =>
			new Promise<{ ok: false; error: string }>((resolve) => {
				resolveConnect = resolve;
			}),
	);
	const onOpenChange = vi.fn();
	render(
		<ConnectWorkerDialog
			initialProvider="other"
			initialServerUrl="worker.example.com:22001"
			initialSyncAfterConnect={false}
			onConnect={onConnect}
			onConnected={vi.fn()}
			onOpenChange={onOpenChange}
		/>,
	);
	fireEvent.change(screen.getByLabelText("Authentication code"), {
		target: { value: "ABCD-EFGH-JKLM-NPQR" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Connect" }));
	await waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
	fireEvent.click(screen.getByRole("button", { name: "Close" }));
	expect(onOpenChange).not.toHaveBeenCalled();

	resolveConnect?.({ ok: false, error: "Worker unavailable." });
	expect(await screen.findByRole("alert")).toHaveTextContent("Worker unavailable.");
	fireEvent.click(screen.getByRole("button", { name: "Close" }));
	expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("uses the saved sync setting when settings finish loading", async () => {
	const onConnect = vi.fn().mockResolvedValue({ ok: true });
	const props = {
		initialProvider: "other" as const,
		initialServerUrl: "worker.example.com:22001",
		onConnect,
		onConnected: vi.fn(),
		onOpenChange: vi.fn(),
	};
	const { rerender } = render(
		<ConnectWorkerDialog
			{...props}
			initialSyncAfterConnect={true}
			settingsLoading={true}
		/>,
	);

	const syncSwitch = screen.getByRole("switch");
	expect(syncSwitch).toBeChecked();
	expect(syncSwitch).toBeDisabled();
	renderAuthenticationCode();

	rerender(
		<ConnectWorkerDialog
			{...props}
			initialSyncAfterConnect={false}
			settingsLoading={false}
		/>,
	);

	await waitFor(() => expect(syncSwitch).not.toBeChecked());
	expect(syncSwitch).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Connect" }));

	await waitFor(() =>
		expect(onConnect).toHaveBeenCalledWith({
			provider: "other",
			serverUrl: "worker.example.com:22001",
			authenticationCode: "ABCD-EFGH-JKLM-NPQR",
			syncAfterConnect: false,
		}),
	);
});

test("restores the target when session state arrives before user input", async () => {
	const props = {
		initialSyncAfterConnect: true,
		onConnect: vi.fn().mockResolvedValue({ ok: true }),
		onConnected: vi.fn(),
		onOpenChange: vi.fn(),
	};
	const { rerender } = render(
		<ConnectWorkerDialog {...props} initialProvider={null} initialServerUrl={null} />,
	);
	const dialog = screen.getByRole("dialog");
	expect(
		within(dialog).getByText("Select a provider to see its setup steps."),
	).toBeVisible();

	rerender(
		<ConnectWorkerDialog
			{...props}
			initialProvider="vastai"
			initialServerUrl="203.0.113.10:34220"
		/>,
	);

	await waitFor(() =>
		expect(within(dialog).getByLabelText("Worker address")).toHaveValue(
			"203.0.113.10:34220",
		),
	);
});

function renderAuthenticationCode(): void {
	fireEvent.change(screen.getByLabelText("Authentication code"), {
		target: { value: "ABCD-EFGH-JKLM-NPQR" },
	});
}
