import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ComfyStartResult } from "../../shared/api";
import { App } from "./App";
import { comfyVersionState, emitComfyRuntime } from "./App.test-harness";

test("shows the ComfyUI versions being started", async () => {
	vi.mocked(window.kastard.comfyVersions.getState).mockResolvedValue({
		ok: true,
		state: {
			...comfyVersionState,
			selection: { frontend: null, backend: null, manager: null },
		},
	});
	render(<App />);
	await screen.findByTitle("ComfyUI");

	act(() => {
		emitComfyRuntime({ status: "starting" });
	});

	expect(screen.getByText("Starting ComfyUI…")).toBeVisible();
	expect(await screen.findByText(/Backend 0\.34\.0/)).toHaveTextContent(
		"Backend 0.34.0 · Frontend v1.49.6 · Manager 4.2.2",
	);
});

test("shows ComfyUI runtime preparation progress", async () => {
	render(<App />);
	await screen.findByTitle("ComfyUI");

	act(() => {
		emitComfyRuntime({
			status: "preparing",
			phase: "python",
			progress: 5,
			firstRun: true,
		});
	});
	expect(screen.getByText("Preparing Python…")).toBeVisible();
	expect(
		screen.getByRole("progressbar", { name: "ComfyUI startup progress" }),
	).toHaveAttribute("aria-valuenow", "5");
	expect(screen.getByText("5%")).toBeVisible();
	expect(
		screen.getByText(
			"The first launch downloads Python and PyTorch and may take a few minutes.",
		),
	).toBeVisible();

	act(() => {
		emitComfyRuntime({
			status: "preparing",
			phase: "dependencies",
			progress: 42,
			firstRun: true,
		});
	});
	expect(screen.getByText("Installing ComfyUI dependencies…")).toBeVisible();
	expect(screen.getByText("42%")).toBeVisible();

	act(() => {
		emitComfyRuntime({ status: "starting" });
	});
	expect(screen.getByText("Starting ComfyUI…")).toBeVisible();
	expect(screen.queryByTitle("ComfyUI")).not.toBeInTheDocument();
	expect(
		screen.queryByRole("progressbar", { name: "ComfyUI startup progress" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByText(
			"The first launch downloads Python and PyTorch and may take a few minutes.",
		),
	).not.toBeInTheDocument();
});

test("shows ComfyUI runtime errors as alerts", async () => {
	render(<App />);
	await screen.findByTitle("ComfyUI");

	act(() => {
		emitComfyRuntime({
			status: "error",
			message: "ENOENT: ComfyUI runtime file was not found.",
		});
	});

	expect(screen.getByRole("alert")).toHaveTextContent(
		"ENOENT: ComfyUI runtime file was not found.",
	);
	expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});

const startupFailure = {
	message: "ComfyUI exited with code 1.",
	logs: "Loading example-node.\nInitialization failed.\n",
	truncated: false,
};

test("opens startup details from a failed start and copies the error and output", async () => {
	vi.mocked(window.kastard.comfy.start).mockResolvedValue({
		ok: false,
		error: startupFailure.message,
		startupFailure,
	});
	render(<App />);
	expect(
		await screen.findByRole("heading", { name: "ComfyUI failed to start" }),
	).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "View logs" }));
	const dialog = screen.getByRole("dialog", { name: "ComfyUI startup logs" });
	expect(within(dialog).getByText(startupFailure.message)).toBeVisible();
	expect(
		within(dialog).getByRole("textbox", { name: "Startup log output" }),
	).toHaveValue(startupFailure.logs);
	fireEvent.click(within(dialog).getByRole("button", { name: "Copy all" }));
	expect(await within(dialog).findByRole("button", { name: "Copied" })).toBeVisible();
	expect(window.kastard.comfy.copyLogs).toHaveBeenCalledWith(
		`${startupFailure.message}\n\n${startupFailure.logs}`,
	);
	const close = within(dialog).getAllByRole("button", { name: "Close" })[0];
	if (!close) throw new Error("Missing Close button.");
	fireEvent.click(close);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "View logs" })).toHaveFocus(),
	);
});

test("shows an actionable error and copyable details before any process output exists", async () => {
	vi.mocked(window.kastard.comfy.start).mockRejectedValue(
		new Error("Gateway could not listen."),
	);
	render(<App />);
	fireEvent.click(await screen.findByRole("button", { name: "View logs" }));
	const dialog = screen.getByRole("dialog", { name: "ComfyUI startup logs" });
	expect(within(dialog).getByText("Gateway could not listen.")).toBeVisible();
	expect(
		within(dialog).getByRole("textbox", { name: "Startup log output" }),
	).toHaveValue("No output was recorded for this startup attempt.");
	fireEvent.click(within(dialog).getByRole("button", { name: "Copy all" }));
	await waitFor(() =>
		expect(window.kastard.comfy.copyLogs).toHaveBeenCalledWith(
			"Gateway could not listen.",
		),
	);
});

test("reports truncated output and a failed clipboard write", async () => {
	vi.mocked(window.kastard.comfy.start).mockResolvedValue({
		ok: false,
		error: startupFailure.message,
		startupFailure: { ...startupFailure, truncated: true },
	});
	vi.mocked(window.kastard.comfy.copyLogs).mockResolvedValue({
		ok: false,
		error: "Clipboard unavailable.",
	});
	render(<App />);
	fireEvent.click(await screen.findByRole("button", { name: "View logs" }));
	const dialog = screen.getByRole("dialog", { name: "ComfyUI startup logs" });
	expect(within(dialog).getByText("Some startup output is unavailable.")).toBeVisible();
	fireEvent.click(within(dialog).getByRole("button", { name: "Copy all" }));
	expect(await within(dialog).findByRole("alert")).toHaveTextContent(
		"Couldn't copy logs. Select the text to copy it manually.",
	);
});

test("keeps the newest attempt visible when an earlier start reply arrives late", async () => {
	const requests: Array<(result: ComfyStartResult) => void> = [];
	vi.mocked(window.kastard.comfy.start).mockImplementation(
		() => new Promise((resolve) => requests.push(resolve)),
	);
	render(<App />);
	act(() =>
		emitComfyRuntime({
			status: "error",
			message: startupFailure.message,
			startupFailure,
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	expect(screen.getByText("Starting ComfyUI…")).toBeVisible();
	await act(async () => requests[0]?.({ ok: false, error: "Earlier failure." }));
	expect(screen.getByText("Starting ComfyUI…")).toBeVisible();
	await act(async () =>
		requests[1]?.({
			ok: false,
			error: "Latest failure.",
			startupFailure: {
				message: "Latest failure.",
				logs: "Latest output.",
				truncated: false,
			},
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "View logs" }));
	expect(screen.getByRole("textbox", { name: "Startup log output" })).toHaveValue(
		"Latest output.",
	);
});

test("preserves a newer runtime event when the initial start request completes", async () => {
	const requests: Array<(result: ComfyStartResult) => void> = [];
	vi.mocked(window.kastard.comfy.start).mockImplementation(
		() => new Promise((resolve) => requests.push(resolve)),
	);
	render(<App />);
	act(() =>
		emitComfyRuntime({
			status: "error",
			message: startupFailure.message,
			startupFailure,
		}),
	);
	await act(async () => requests[0]?.({ ok: true, url: "about:blank" }));
	fireEvent.click(screen.getByRole("button", { name: "View logs" }));
	expect(screen.getByRole("textbox", { name: "Startup log output" })).toHaveValue(
		startupFailure.logs,
	);
	act(() => emitComfyRuntime({ status: "starting" }));
	expect(screen.getByText("Starting ComfyUI…")).toBeVisible();
	act(() => emitComfyRuntime({ status: "ready", url: "about:blank" }));
	expect(screen.getByTitle("ComfyUI")).toBeVisible();
});

test("keeps a reopened log dialog independent of an earlier copy operation", async () => {
	vi.mocked(window.kastard.comfy.start).mockResolvedValue({
		ok: false,
		error: startupFailure.message,
		startupFailure,
	});
	const copies: Array<(result: { ok: true }) => void> = [];
	vi.mocked(window.kastard.comfy.copyLogs).mockImplementation(
		() => new Promise((resolve) => copies.push(resolve)),
	);
	render(<App />);
	fireEvent.click(await screen.findByRole("button", { name: "View logs" }));
	const dialog = screen.getByRole("dialog", { name: "ComfyUI startup logs" });
	fireEvent.click(within(dialog).getByRole("button", { name: "Copy all" }));
	expect(within(dialog).getByRole("button", { name: "Copying…" })).toBeDisabled();
	const close = within(dialog).getAllByRole("button", { name: "Close" })[0];
	if (!close) throw new Error("Missing Close button.");
	fireEvent.click(close);
	fireEvent.click(screen.getByRole("button", { name: "View logs" }));
	await act(async () => copies[0]?.({ ok: true }));
	expect(screen.getByRole("button", { name: "Copy all" })).toBeEnabled();
});
