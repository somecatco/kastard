import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConnectionPopoverMockup } from "./desktop-mockups";
import {
	backendErrorScenario,
	backendMismatchScenario,
	backendSyncScenario,
	backendWaitingScenario,
	comfyErrorScenario,
	comfyStartScenario,
	comfyWarningScenario,
	completeSyncScenario,
	initialSyncScenario,
} from "./worker-scenarios";

const meta = {
	title: "Mockups/Worker Backend",
	component: ConnectionPopoverMockup,
	parameters: { layout: "fullscreen" },
	args: { openPopover: "backend" },
} satisfies Meta<typeof ConnectionPopoverMockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotInstalled: Story = {
	args: { syncScenario: initialSyncScenario },
};

export const Downloading: Story = {
	args: { syncScenario: backendSyncScenario },
};

export const WaitingToStart: Story = {
	args: { syncScenario: backendWaitingScenario },
};

export const Starting: Story = {
	args: { syncScenario: comfyStartScenario },
};

export const Running: Story = {
	args: { syncScenario: completeSyncScenario },
};

export const RunningWithWarnings: Story = {
	args: { syncScenario: comfyWarningScenario },
};

export const VersionMismatch: Story = {
	args: { syncScenario: backendMismatchScenario },
};

export const DownloadError: Story = {
	args: { syncScenario: backendErrorScenario },
};

export const ComfyError: Story = {
	args: { syncScenario: comfyErrorScenario },
};
