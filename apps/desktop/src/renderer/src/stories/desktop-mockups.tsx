import type { CustomNodeInventoryEntry } from "@kastard/common";
import { PlayIcon } from "lucide-react";
import { AppHeader, type AppSurface } from "@/components/AppHeader";
import {
	ConnectionControl,
	type ConnectionPopoverId,
	ConnectionProvider,
} from "@/components/ConnectionControl";
import { SettingsSurface } from "@/components/SettingsSurface";
import { WorkerCustomNodeSyncStatus } from "@/components/WorkerCustomNodeSyncStatus";
import { useDesktopSettings } from "@/hooks/useDesktopSettings";
import type { ConnectionState } from "../../../shared/api";
import { useConfigureStoryWorker } from "./desktop-api-mock";
import {
	completeSyncScenario,
	connectedConnection,
	disconnectedConnection,
	type StoryWorkerScenario,
} from "./worker-scenarios";

function noOp(): void {}

function ComfyCanvasMockup(): React.JSX.Element {
	return (
		<div
			className="relative min-h-0 flex-1 overflow-hidden bg-[#17191a]"
			style={{
				backgroundImage:
					"radial-gradient(circle, rgba(255, 255, 255, 0.12) 1px, transparent 1px)",
				backgroundSize: "20px 20px",
			}}
		>
			<div className="absolute inset-x-0 top-0 flex h-12 items-center justify-between border-b border-white/8 bg-[#202223]/95 px-4">
				<div className="flex items-center gap-2 text-xs text-white/55">
					<span className="rounded-md bg-white/8 px-2 py-1 text-white/85">
						Workflow
					</span>
					<span>Untitled</span>
				</div>
				<button
					type="button"
					className="flex h-8 items-center gap-2 rounded-md bg-[#60a5fa] px-3 text-xs font-semibold text-[#0d1726]"
				>
					<PlayIcon className="size-3.5 fill-current" />
					Run
				</button>
			</div>

			<div className="absolute left-[14%] top-[30%] w-48 overflow-hidden rounded-lg border border-[#4e5254] bg-[#292c2d] shadow-xl">
				<div className="border-b border-white/8 bg-[#8459b5] px-3 py-2 text-xs font-medium text-white">
					Load Checkpoint
				</div>
				<div className="space-y-2 p-3 text-[11px] text-white/55">
					<div className="h-7 rounded bg-black/25" />
					<div className="h-2 w-2/3 rounded-full bg-white/10" />
				</div>
			</div>

			<div className="absolute right-[17%] top-[44%] w-44 overflow-hidden rounded-lg border border-[#4e5254] bg-[#292c2d] shadow-xl">
				<div className="border-b border-white/8 bg-[#4f8f63] px-3 py-2 text-xs font-medium text-white">
					Save Image
				</div>
				<div className="space-y-2 p-3">
					<div className="h-2 w-3/4 rounded-full bg-white/10" />
					<div className="h-2 w-1/2 rounded-full bg-white/10" />
				</div>
			</div>

			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 size-full"
				preserveAspectRatio="none"
			>
				<path
					d="M 350 330 C 520 330, 610 430, 795 430"
					fill="none"
					stroke="#a78bfa"
					strokeOpacity="0.7"
					strokeWidth="3"
				/>
			</svg>
		</div>
	);
}

export function WindowTitlebarMockup({
	activeSurface = "comfy",
}: {
	activeSurface?: AppSurface;
}): React.JSX.Element {
	return (
		<>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-2"
			>
				<span className="size-3 rounded-full bg-[#ff5f57]" />
				<span className="size-3 rounded-full bg-[#febc2e]" />
				<span className="size-3 rounded-full bg-[#28c840]" />
			</div>
			<AppHeader
				activeSurface={activeSurface}
				onNavigate={() => undefined}
				closeConnectionRequest={0}
			/>
		</>
	);
}

export function SettingsHelpMockup(): React.JSX.Element {
	useConfigureStoryWorker(disconnectedConnection);
	const settings = useDesktopSettings();
	return (
		<div className="flex min-h-svh items-center justify-center bg-[#090a0b] p-6">
			<ConnectionProvider closeRequest={0}>
				<div className="relative flex h-[min(760px,calc(100svh-48px))] min-h-[560px] w-full max-w-[1280px] flex-col overflow-hidden rounded-[14px] border border-white/10 bg-background shadow-2xl">
					<WindowTitlebarMockup activeSurface="settings" />
					<SettingsSurface
						focusRequest={0}
						settings={settings}
						comfyRestarting={false}
						comfyRuntimeBusy={false}
						comfyRestartResult={null}
						onRestartComfy={async () => ({ ok: true })}
						onClearComfyRestartResult={noOp}
					/>
				</div>
			</ConnectionProvider>
		</div>
	);
}

export type TitlebarMockupProps = {
	connectionState: ConnectionState;
	syncScenario?: StoryWorkerScenario;
};

export function TitlebarMockup({
	connectionState,
	syncScenario = completeSyncScenario,
}: TitlebarMockupProps): React.JSX.Element {
	useConfigureStoryWorker(connectionState, syncScenario);
	return (
		<div className="flex min-h-svh items-start justify-center bg-[#090a0b] p-6">
			<ConnectionProvider closeRequest={0}>
				<div className="relative w-full max-w-[1280px] overflow-hidden rounded-[14px] border border-white/10 shadow-2xl">
					<WindowTitlebarMockup />
				</div>
			</ConnectionProvider>
		</div>
	);
}

export type ConnectionPopoverMockupProps = {
	connectionState?: ConnectionState;
	syncScenario?: StoryWorkerScenario;
	openPopover?: ConnectionPopoverId;
};

export function ConnectionPopoverMockup({
	connectionState = connectedConnection,
	syncScenario = completeSyncScenario,
	openPopover = "details",
}: ConnectionPopoverMockupProps): React.JSX.Element {
	useConfigureStoryWorker(connectionState, syncScenario);
	return (
		<div className="flex min-h-svh items-start justify-center bg-[#090a0b] p-6">
			<ConnectionProvider closeRequest={0}>
				<div className="relative h-[42rem] w-full max-w-[42rem] rounded-[14px] border border-white/10 bg-[#17191a] shadow-2xl">
					<div className="relative flex h-12 items-center rounded-t-[14px] border-b border-white/10 bg-background pr-4 pl-24">
						<div className="absolute left-4 flex items-center gap-2" aria-hidden="true">
							<span className="size-3 rounded-full bg-[#ff5f57]" />
							<span className="size-3 rounded-full bg-[#febc2e]" />
							<span className="size-3 rounded-full bg-[#28c840]" />
						</div>
						<div data-connection-control>
							<ConnectionControl
								openPopovers={new Set<ConnectionPopoverId>([openPopover])}
								onPopoverOpenChange={noOp}
								closeRequest={0}
							/>
						</div>
					</div>
				</div>
			</ConnectionProvider>
		</div>
	);
}

export function CustomNodeListMockup({
	syncScenario,
	preparingReinstallNodeId = null,
	preparingRemovalNodeName = null,
	onReinstall = noOp,
	onRemove = noOp,
}: {
	syncScenario: StoryWorkerScenario;
	preparingReinstallNodeId?: string | null;
	preparingRemovalNodeName?: string | null;
	onReinstall?: (id: string) => void;
	onRemove?: (node: CustomNodeInventoryEntry) => void;
}): React.JSX.Element {
	useConfigureStoryWorker(connectedConnection, syncScenario);
	return (
		<div className="flex min-h-svh items-start justify-center bg-[#090a0b] p-6">
			<ConnectionProvider closeRequest={0}>
				<div className="relative flex h-[42rem] w-full max-w-[56rem] flex-col overflow-hidden rounded-[14px] border border-white/10 bg-background shadow-2xl">
					<WindowTitlebarMockup />
					<div
						className="relative min-h-0 flex-1 bg-[#17191a]"
						style={{
							backgroundImage:
								"radial-gradient(circle, rgba(255, 255, 255, 0.08) 1px, transparent 1px)",
							backgroundSize: "20px 20px",
						}}
					>
						<div className="absolute left-1/2 top-3 max-h-[calc(100%-1.5rem)] w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md select-text cursor-text">
							<WorkerCustomNodeSyncStatus
								state={syncScenario.nodes}
								backendState={syncScenario.backend}
								starting={false}
								preparingReinstallNodeId={preparingReinstallNodeId}
								preparingRemovalNodeName={preparingRemovalNodeName}
								canceling={false}
								error={null}
								disabled={false}
								onSync={noOp}
								onReinstall={onReinstall}
								onRemove={onRemove}
								onCancel={noOp}
							/>
						</div>
					</div>
				</div>
			</ConnectionProvider>
		</div>
	);
}

export function DesktopLayoutMockup(): React.JSX.Element {
	useConfigureStoryWorker(disconnectedConnection);
	return (
		<div className="flex min-h-svh items-center justify-center bg-[#090a0b] p-6">
			<ConnectionProvider closeRequest={0}>
				<div className="relative flex h-[min(760px,calc(100svh-48px))] min-h-[560px] w-full max-w-[1280px] flex-col overflow-hidden rounded-[14px] border border-white/10 bg-background shadow-2xl">
					<WindowTitlebarMockup />
					<ComfyCanvasMockup />
				</div>
			</ConnectionProvider>
		</div>
	);
}
