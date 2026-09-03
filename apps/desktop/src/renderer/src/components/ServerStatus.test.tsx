import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { GpuSystemStatus, WorkerSystemStatus } from "../../../shared/api";
import { ServerStatus } from "./ServerStatus";

afterEach(cleanup);

test("shows unavailable placeholders before Worker metrics arrive", () => {
	render(<ServerStatus />);

	const status = screen.getByRole("list", { name: "Worker status" });
	expect(
		within(status).getByRole("img", { name: "CPU usage: Unavailable" }),
	).toHaveTextContent("CPU--");
	expect(
		within(status).getByRole("img", { name: "RAM usage: Unavailable" }),
	).toHaveTextContent("RAM--");
	expect(
		within(status).getByRole("img", {
			name: "Disk usage: Unavailable. Path unavailable",
		}),
	).toHaveTextContent("DISK--");
});

test("shows only CPU, RAM, and disk when no GPU is present", () => {
	render(<ServerStatus status={statusWithGpus([])} />);

	const status = screen.getByRole("list", { name: "Worker status" });
	expect(within(status).getAllByRole("listitem")).toHaveLength(3);
	expect(within(status).queryByRole("button")).not.toBeInTheDocument();
	expect(within(status).queryByText(/^GPU/)).not.toBeInTheDocument();
});

test("shows the GPU index when exactly one GPU is present", () => {
	render(<ServerStatus status={statusWithGpus([gpu(3)])} />);

	const status = screen.getByRole("list", { name: "Worker status" });
	expect(within(status).getAllByRole("img")).toHaveLength(6);
	expect(within(status).getByText("GPU3")).toBeInTheDocument();
	expect(within(status).getByText("VRAM3")).toBeInTheDocument();
	expect(within(status).getByText("TEMP3")).toBeInTheDocument();
});

test("renders indexed groups for four GPUs and keeps disk last", () => {
	const unavailableGpu = {
		...gpu(1),
		usagePercent: null,
		vramUsedBytes: null,
		vramUsagePercent: null,
		temperatureC: 54,
	};
	render(
		<ServerStatus status={statusWithGpus([gpu(0), unavailableGpu, gpu(2), gpu(3)])} />,
	);

	const status = screen.getByRole("list", { name: "Worker status" });
	const metrics = within(status).getAllByRole("img");
	expect(metrics).toHaveLength(15);
	expect(metrics.map((metric) => metric.textContent)).toEqual([
		"CPU12%",
		"RAM50%",
		"GPU072%",
		"VRAM050%",
		"TEMP068°C",
		"GPU1--",
		"VRAM1--",
		"TEMP154°C",
		"GPU272%",
		"VRAM250%",
		"TEMP268°C",
		"GPU372%",
		"VRAM350%",
		"TEMP368°C",
		"DISK30%",
	]);
	expect(
		within(status).getByRole("img", { name: /^GPU 1 VRAM usage: Unavailable/ }),
	).toBeVisible();
});

test("keeps disk outside the clipped GPU region", () => {
	render(<ServerStatus status={statusWithGpus([gpu(0), gpu(1)])} />);

	const status = screen.getByRole("list", { name: "Worker status" });
	const gpuStatus = within(status).getByRole("list", { name: "GPU status" });
	const disk = within(status).getByRole("img", { name: /^Disk usage/ });

	expect(gpuStatus.parentElement).toHaveClass("min-w-0", "overflow-hidden");
	expect(disk.closest("li")?.parentElement).toBe(status);
});

test("closes a metric tooltip when the window loses focus", async () => {
	render(<ServerStatus status={statusWithGpus([])} />);

	const cpu = screen.getByRole("img", { name: "CPU usage: 12%" });
	expect(cpu).toHaveClass("cursor-default");
	expect(cpu).toHaveClass("select-text");
	fireEvent.pointerMove(cpu, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");
	expect(tooltip).toHaveTextContent("CPU usage");
	expect(tooltip).toHaveClass("select-text");

	fireEvent(window, new Event("blur"));
	await waitFor(() => expect(tooltip).not.toBeInTheDocument());
});

test("selects the exact Worker disk path on triple-click", async () => {
	render(<ServerStatus status={statusWithGpus([])} />);

	const disk = screen.getByRole("img", { name: /^Disk usage/ });
	fireEvent.pointerMove(disk, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");
	const path = within(tooltip).getByText("/workspace");
	fireEvent.mouseDown(path, { button: 0, detail: 3 });

	expect(document.getSelection()?.toString()).toBe("/workspace");
});

test("closes a metric tooltip after leaving its hover area", async () => {
	render(<ServerStatus status={statusWithGpus([])} />);

	const cpu = screen.getByRole("img", { name: "CPU usage: 12%" });
	fireEvent.pointerMove(cpu, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");

	fireEvent.pointerLeave(cpu, { pointerType: "mouse" });
	await waitFor(() => expect(tooltip).not.toBeInTheDocument());
});

test("keeps a metric tooltip open while moving from its trigger to its content", async () => {
	render(<ServerStatus status={statusWithGpus([])} />);

	const cpu = screen.getByRole("img", { name: "CPU usage: 12%" });
	fireEvent.pointerMove(cpu, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");

	fireEvent.pointerLeave(cpu, { pointerType: "mouse" });
	fireEvent.pointerEnter(tooltip, { pointerType: "mouse" });
	await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
	expect(tooltip).toBeInTheDocument();

	fireEvent.pointerLeave(tooltip, { pointerType: "mouse" });
	await waitFor(() => expect(tooltip).not.toBeInTheDocument());
});

function statusWithGpus(gpus: GpuSystemStatus[]): WorkerSystemStatus {
	return {
		sampledAt: "2026-08-17T07:00:00.000Z",
		cpu: { usagePercent: 12 },
		ram: { usedBytes: 4, totalBytes: 8, usagePercent: 50 },
		disk: { path: "/workspace", usedBytes: 3, totalBytes: 10, usagePercent: 30 },
		gpus,
	};
}

function gpu(index: number): GpuSystemStatus {
	return {
		index,
		uuid: `GPU-${index}`,
		name: "NVIDIA RTX 4090",
		usagePercent: 72,
		vramUsedBytes: 12,
		vramTotalBytes: 24,
		vramUsagePercent: 50,
		temperatureC: 68,
	};
}
