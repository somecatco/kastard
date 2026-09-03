import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { WorkerLogsDialog } from "@/components/WorkerLogsDialog";
import type { WorkerLogEntry, WorkerLogsResult } from "../../../shared/api";
import { configureStoryWorkerLogs } from "../stories/desktop-api-mock";

type WorkerLogsDialogStoryProps = {
	result: WorkerLogsResult;
};

const sampleLogs: WorkerLogEntry[] = [
	{
		id: "worker-connected",
		timestamp: "2026-08-29T08:30:12.000Z",
		level: "info",
		message: "Connected to Worker at 203.0.113.10:34220.",
	},
	{
		id: "comfy-starting",
		timestamp: "2026-08-29T08:30:18.000Z",
		level: "info",
		message: "Starting ComfyUI backend.",
	},
	{
		id: "node-warning",
		timestamp: "2026-08-29T08:30:24.000Z",
		level: "warning",
		message: "A Custom Node update is available.",
	},
	{
		id: "model-error",
		timestamp: "2026-08-29T08:30:31.000Z",
		level: "error",
		message: "Model download failed: access denied.",
	},
];

const activityResult: WorkerLogsResult = {
	ok: true,
	logs: sampleLogs,
	truncated: false,
};

function WorkerLogsDialogStory({
	result,
}: WorkerLogsDialogStoryProps): React.JSX.Element {
	const [open, setOpen] = useState(true);
	configureStoryWorkerLogs(result);

	return (
		<div className="flex min-h-svh items-center justify-center bg-[#090a0b] p-6">
			<Button type="button" variant="secondary" onClick={() => setOpen(true)}>
				Open Worker logs
			</Button>
			<WorkerLogsDialog open={open} onOpenChange={setOpen} />
		</div>
	);
}

const meta = {
	title: "Desktop/Worker Logs Dialog",
	component: WorkerLogsDialogStory,
	parameters: {
		layout: "fullscreen",
	},
	args: {
		result: activityResult,
	},
} satisfies Meta<typeof WorkerLogsDialogStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Activity: Story = {};

export const Empty: Story = {
	args: {
		result: { ok: true, logs: [], truncated: false },
	},
};

export const Truncated: Story = {
	args: {
		result: { ok: true, logs: sampleLogs, truncated: true },
	},
};

export const LoadingError: Story = {
	args: {
		result: { ok: false, error: "Worker logs are unavailable." },
	},
};
