import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
	ConnectWorkerDialog,
	type ConnectWorkerDialogProps,
} from "@/components/ConnectWorkerDialog";
import { Button } from "@/components/ui/button";

type ConnectionDialogStoryProps = Pick<
	ConnectWorkerDialogProps,
	"initialProvider" | "initialServerUrl" | "initialSyncAfterConnect"
>;

function ConnectionDialogStory({
	initialProvider,
	initialServerUrl,
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
					initialServerUrl={initialServerUrl}
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
		initialServerUrl: null,
		initialSyncAfterConnect: true,
	},
} satisfies Meta<typeof ConnectionDialogStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ProviderSelection: Story = {};

export const RunPodSelected: Story = {
	args: {
		initialProvider: "runpod",
		initialServerUrl: "https://abc123xyz-5278.proxy.runpod.net",
	},
};

export const VastAiSelected: Story = {
	args: {
		initialProvider: "vastai",
		initialServerUrl: "http://203.0.113.10:34220",
	},
};

export const OtherServerSelected: Story = {
	args: {
		initialProvider: "other",
		initialServerUrl: "84.1.117.74:41047",
	},
};

export const RecentConnection: Story = {
	args: {
		initialProvider: "runpod",
		initialServerUrl: "https://last-used-pod-5278.proxy.runpod.net",
		initialSyncAfterConnect: false,
	},
};
