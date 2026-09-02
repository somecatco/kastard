import { act, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
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
