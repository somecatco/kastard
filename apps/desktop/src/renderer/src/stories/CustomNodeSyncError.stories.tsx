import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect } from "react";
import { userEvent, within } from "storybook/test";
import { CustomNodesSurface } from "@/components/CustomNodesSurface";
import { ConnectionProvider } from "@/components/connection/ConnectionProvider";
import type { CustomNodeEntry } from "../../../shared/api";
import { useConfigureStoryWorker } from "./desktop-api-mock";
import { WindowTitlebarMockup } from "./desktop-mockups";
import { disconnectedConnection } from "./worker-scenarios";

const nodes: CustomNodeEntry[] = [
	{
		name: "comfy-image-saver",
		version: "unknown",
		managerId: null,
		sync: true,
		workerSyncIssue: "The Git repository metadata could not be read.",
		workerSyncErrorLog: {
			text: [
				"Command: git rev-parse --show-toplevel",
				"Exit code: 69",
				"stderr:\nYou have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.\n",
			].join("\n\n"),
			truncated: false,
		},
	},
	{
		name: "comfyui-kjnodes",
		version: "1.5.0",
		managerId: "comfyui-kjnodes",
		sync: true,
	},
	{ name: "ComfyUI-GGUF", version: "1.1.2", managerId: "ComfyUI-GGUF", sync: true },
];

function CustomNodeSyncErrorMockup(): React.JSX.Element {
	useConfigureStoryWorker(disconnectedConnection);
	useLayoutEffect(() => {
		const previousNodes = window.kastard.customNodes;
		const previousCopy = window.kastard.comfy.copyLogs;
		let entries = structuredClone(nodes);
		window.kastard.customNodes = {
			...previousNodes,
			list: async () => ({ ok: true, nodes: structuredClone(entries) }),
			update: async ({ name, sync }) => {
				entries = entries.map((node) =>
					node.name === name ? { ...node, sync } : node,
				);
				return { ok: true };
			},
		};
		window.kastard.comfy.copyLogs = async (text) => {
			await navigator.clipboard.writeText(text);
			return { ok: true };
		};
		return () => {
			window.kastard.customNodes = previousNodes;
			window.kastard.comfy.copyLogs = previousCopy;
		};
	}, []);
	return (
		<div className="flex min-h-svh items-center justify-center bg-[#090a0b] p-6">
			<ConnectionProvider closeRequest={0}>
				<div className="relative flex h-[min(760px,calc(100svh-48px))] min-h-[420px] w-full max-w-[1280px] flex-col overflow-hidden rounded-[14px] border border-white/10 bg-background shadow-2xl">
					<WindowTitlebarMockup activeSurface="custom-nodes" />
					<CustomNodesSurface
						runtime={{ status: "idle" }}
						notice={null}
						onInstalled={() => undefined}
						onRemoved={() => undefined}
					/>
				</div>
			</ConnectionProvider>
		</div>
	);
}

const meta = {
	title: "Mockups/Custom Node Sync Error",
	component: CustomNodeSyncErrorMockup,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CustomNodeSyncErrorMockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SyncUnavailable: Story = {};

export const ErrorLogOpen: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.click(
			await within(canvasElement).findByRole("button", { name: "View error log" }),
		);
	},
};
