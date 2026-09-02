import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConnectionPopoverMockup } from "./desktop-mockups";
import {
	checkingSyncScenario,
	comfyErrorScenario,
	comfyStartScenario,
	offlineConnection,
	syncWarningScenario,
	targetsSyncScenario,
} from "./worker-scenarios";

const meta = {
	title: "Mockups/Worker Connection",
	component: ConnectionPopoverMockup,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConnectionPopoverMockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const RunningWithSyncWarnings: Story = {
	args: { syncScenario: syncWarningScenario },
};

export const Checking: Story = {
	args: { syncScenario: checkingSyncScenario },
};

export const Resyncing: Story = {
	args: { syncScenario: targetsSyncScenario },
};

export const StartingComfy: Story = {
	args: { syncScenario: comfyStartScenario },
};

export const ComfyError: Story = {
	args: { syncScenario: comfyErrorScenario },
};

export const Offline: Story = {
	args: { connectionState: offlineConnection },
};
