import type { Meta, StoryObj } from "@storybook/react-vite";
import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { ComfyStartupFailure } from "@/components/ComfyStartupFailure";
import { ConnectionProvider } from "@/components/connection/ConnectionProvider";
import { useConfigureStoryWorker } from "./desktop-api-mock";
import { WindowTitlebarMockup } from "./desktop-mockups";
import { disconnectedConnection } from "./worker-scenarios";

const startupLogs = [
	"[INFO] Preparing local ComfyUI.",
	"[INFO] Python environment is ready.",
	"[INFO] Starting ComfyUI backend.",
	"[INFO] Loading ComfyUI-Manager.",
	"[WARNING] System Git could not be executed.",
	"[INFO] Trying the pygit2 fallback.",
	"ModuleNotFoundError: No module named 'pygit2'",
	"[ERROR] ComfyUI-Manager initialization failed.",
	"[ERROR] ComfyUI exited with code 1 before becoming ready.",
].join("\n");

function ComfyStartupFailureStory({
	logs,
	truncated,
}: {
	logs: string;
	truncated: boolean;
}): React.JSX.Element {
	useConfigureStoryWorker(disconnectedConnection);
	const [retrying, setRetrying] = useState(false);
	useLayoutEffect(() => {
		window.kastard.comfy.copyLogs = async (text) => {
			await navigator.clipboard.writeText(text);
			return { ok: true };
		};
	}, []);
	useEffect(() => {
		if (!retrying) return;
		const timer = window.setTimeout(() => setRetrying(false), 1_200);
		return () => window.clearTimeout(timer);
	}, [retrying]);
	return (
		<div className="flex min-h-svh items-center justify-center bg-[#090a0b] p-6">
			<ConnectionProvider closeRequest={0}>
				<div className="relative flex h-[min(760px,calc(100svh-48px))] min-h-[360px] w-full max-w-[1280px] flex-col overflow-hidden rounded-[14px] border border-white/10 bg-background shadow-2xl">
					<WindowTitlebarMockup />
					{retrying ? (
						<div
							className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
							role="status"
						>
							<LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
							Starting ComfyUI…
						</div>
					) : (
						<ComfyStartupFailure
							failure={{ message: "ComfyUI exited with code 1.", logs, truncated }}
							onRetry={() => setRetrying(true)}
						/>
					)}
				</div>
			</ConnectionProvider>
		</div>
	);
}

const meta = {
	title: "Mockups/ComfyUI Startup Failure",
	component: ComfyStartupFailureStory,
	parameters: { layout: "fullscreen" },
	args: { logs: startupLogs, truncated: false },
} satisfies Meta<typeof ComfyStartupFailureStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StartupFailed: Story = {};

export const LogsOpen: Story = {
	play: async ({ canvasElement }) => {
		const trigger = Array.from(canvasElement.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "View logs",
		);
		if (!trigger) throw new Error("The startup log trigger is unavailable.");
		trigger.click();
	},
};

export const LongLogs: Story = {
	...LogsOpen,
	args: {
		logs: [
			...Array.from(
				{ length: 60 },
				(_, index) =>
					`[INFO] Checking extension example_node_${String(index + 1).padStart(2, "0")}.`,
			),
			startupLogs,
		].join("\n"),
	},
};

export const NoOutput: Story = { ...LogsOpen, args: { logs: "" } };
export const Truncated: Story = { ...LogsOpen, args: { truncated: true } };
