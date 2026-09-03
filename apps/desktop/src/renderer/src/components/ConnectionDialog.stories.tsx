import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
	ConnectWorkerDialog,
	type ConnectWorkerDialogProps,
} from "@/components/ConnectWorkerDialog";
import { Button } from "@/components/ui/button";

type ConnectionDialogStoryProps = Pick<
	ConnectWorkerDialogProps,
	"initialProvider" | "initialWorkerAddress" | "initialSyncAfterConnect"
>;

function ConnectionDialogStory({
	initialProvider,
	initialWorkerAddress,
	initialSyncAfterConnect,
}: ConnectionDialogStoryProps): React.JSX.Element {
	const [open, setOpen] = useState(true);
	return (
		<div className="flex min-h-svh items-center justify-center bg-[#090a0b] p-6">
			<Button type="button" variant="secondary" onClick={() => setOpen(true)}>
				Open Connect
			</Button>
			{open ? (
				<ConnectWorkerDialog
					initialProvider={initialProvider}
					initialWorkerAddress={initialWorkerAddress}
					initialSyncAfterConnect={initialSyncAfterConnect}
					onConnect={async () => ({ ok: true })}
					onConnected={() => undefined}
					onOpenChange={setOpen}
				/>
			) : null}
		</div>
	);
}

const meta = {
	title: "Desktop/Connection Dialog",
	component: ConnectionDialogStory,
	parameters: {
		layout: "fullscreen",
	},
	args: {
		initialProvider: null,
		initialWorkerAddress: null,
		initialSyncAfterConnect: true,
	},
} satisfies Meta<typeof ConnectionDialogStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ProviderSelection: Story = {};

export const RunPodSelected: Story = {
	args: {
		initialProvider: "runpod",
		initialWorkerAddress: "https://abc123xyz-5278.proxy.runpod.net",
	},
};

export const VastAiSelected: Story = {
	args: {
		initialProvider: "vastai",
		initialWorkerAddress: "http://203.0.113.10:34220",
	},
};

export const OtherServerSelected: Story = {
	args: {
		initialProvider: "other",
		initialWorkerAddress: "84.1.117.74:41047",
	},
};

export const RecentConnection: Story = {
	args: {
		initialProvider: "runpod",
		initialWorkerAddress: "https://last-used-pod-5278.proxy.runpod.net",
		initialSyncAfterConnect: false,
	},
};
