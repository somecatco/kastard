import type { Meta, StoryObj } from "@storybook/react-vite";
import { TitlebarMockup } from "./desktop-mockups";
import {
	backendSyncScenario,
	comfyReadyModelsSyncScenario,
	comfyStartScenario,
	connectedConnection,
	disconnectedConnection,
	initialSyncScenario,
	targetsSyncScenario,
} from "./worker-scenarios";

const meta = {
	title: "Mockups/Worker Synchronization",
	component: TitlebarMockup,
	parameters: { layout: "fullscreen" },
	args: { connectionState: disconnectedConnection },
} satisfies Meta<typeof TitlebarMockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BeforeConnect: Story = {};

export const AfterConnect: Story = {
	args: { connectionState: connectedConnection },
};

export const Initial: Story = {
	args: {
		connectionState: connectedConnection,
		syncScenario: initialSyncScenario,
	},
};

export const SyncingBackend: Story = {
	args: {
		connectionState: connectedConnection,
		syncScenario: backendSyncScenario,
	},
};

export const SyncingNodesAndModels: Story = {
	args: {
		connectionState: connectedConnection,
		syncScenario: targetsSyncScenario,
	},
};

export const StartingWorkerComfy: Story = {
	args: {
		connectionState: connectedConnection,
		syncScenario: comfyStartScenario,
	},
};

export const WorkerReadyModelsSyncing: Story = {
	args: {
		connectionState: connectedConnection,
		syncScenario: comfyReadyModelsSyncScenario,
	},
};
