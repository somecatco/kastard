import { CheckIcon, CircleAlertIcon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import { type ReactNode, useMemo, useRef } from "react";
import { Popover, PopoverContent } from "@/components/common/popover";
import { Tooltip } from "@/components/common/tooltip";
import { useConnectionDialogs } from "@/components/connection/ConnectionDialogs";
import { Button } from "@/components/ui/button";
import { PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkerCustomNodeSyncStatus } from "@/components/WorkerCustomNodeSyncStatus";
import { WorkerModelSyncStatus } from "@/components/WorkerModelSyncStatus";
import { useBackendRequests } from "@/hooks/use-worker-backend-requests";
import { useModelsRequests } from "@/hooks/use-worker-models-requests";
import { useNodesRequests } from "@/hooks/use-worker-nodes-requests";
import { sameFields, useWorkerSessionSelector } from "@/hooks/use-worker-session";
import { useSetupRequests } from "@/hooks/use-worker-setup-requests";
import { useModelDownloadRate } from "@/hooks/useModelDownloadRate";
import { cn } from "@/lib/utils";
import { backendPresentation } from "@/lib/worker-backend-presentation";
import { modelsPresentation } from "@/lib/worker-models-presentation";
import { nodesPresentation } from "@/lib/worker-nodes-presentation";
import type {
	SyncAreaId,
	SyncAreaStatus,
	SyncAreaSummary,
} from "@/lib/worker-synchronization";

import { ComfyBackendStatus } from "./ComfyBackendStatus";

type ConnectionPopoverId = "details" | SyncAreaId;
type AreaProps = { open: boolean; onOpenChange: (open: boolean) => void };
const SYNC_STATUS_LABELS: Record<SyncAreaStatus, string> = {
	pending: "Pending",
	syncing: "Syncing",
	synced: "Synced",
	warning: "Needs attention",
	error: "Needs attention",
};

export function SynchronizationAreas({
	openPopovers,
	onPopoverOpenChange,
}: {
	openPopovers: ReadonlySet<ConnectionPopoverId>;
	onPopoverOpenChange: (area: ConnectionPopoverId, open: boolean) => void;
}): React.JSX.Element {
	return (
		<TooltipProvider delayDuration={150}>
			<ul
				className="flex min-w-0 items-center gap-1.5 overflow-hidden"
				aria-label="Synchronization areas"
			>
				<BackendArea
					open={openPopovers.has("backend")}
					onOpenChange={(open) => onPopoverOpenChange("backend", open)}
				/>
				<NodesArea
					open={openPopovers.has("nodes")}
					onOpenChange={(open) => onPopoverOpenChange("nodes", open)}
				/>
				<ModelsArea
					open={openPopovers.has("models")}
					onOpenChange={(open) => onPopoverOpenChange("models", open)}
				/>
			</ul>
		</TooltipProvider>
	);
}

function BackendArea(props: AreaProps): React.JSX.Element {
	const state = useWorkerSessionSelector(
		(session) => ({
			backendState: session.backend,
			workerComfyState: session.comfy,
			setupState: session.setup,
			verification: session.verification,
		}),
		sameFields,
	);
	const requests = useBackendRequests();
	const { verificationAction } = useSetupRequests();
	const presentation = useMemo(
		() =>
			backendPresentation({
				...state,
				backendAction: requests.backendAction,
				backendError: requests.backendError,
				comfyRestartAction: requests.comfyRestartAction,
				comfyRestartError: requests.comfyRestartError,
				verificationAction,
			}),
		[
			state,
			requests.backendAction,
			requests.backendError,
			requests.comfyRestartAction,
			requests.comfyRestartError,
			verificationAction,
		],
	);
	return (
		<SyncAreaItem {...props} area={presentation.summary}>
			<ComfyBackendStatus content={presentation.content} />
		</SyncAreaItem>
	);
}

function NodesArea(props: AreaProps): React.JSX.Element {
	const state = useWorkerSessionSelector(
		(session) => ({
			syncState: session.customNodes,
			backendState: session.backend,
			workerComfyState: session.comfy,
			setupState: session.setup,
			verification: session.verification,
		}),
		sameFields,
	);
	const requests = useNodesRequests();
	const { verificationAction, setupCancelAction } = useSetupRequests();
	const dialogs = useConnectionDialogs();
	const presentation = useMemo(
		() =>
			nodesPresentation({
				...state,
				syncAction: requests.syncAction,
				syncCancelAction: requests.syncCancelAction,
				syncError: requests.syncError,
				preparingReinstallNodeId: requests.preparingReinstallNodeId,
				verificationAction,
			}),
		[
			state,
			requests.syncAction,
			requests.syncCancelAction,
			requests.syncError,
			requests.preparingReinstallNodeId,
			verificationAction,
		],
	);
	const disabled =
		setupCancelAction ||
		(state.setupState.status === "running" &&
			state.setupState.phase !== "preparation") ||
		state.workerComfyState.status === "loading" ||
		state.workerComfyState.status === "starting";
	return (
		<SyncAreaItem {...props} area={presentation.summary}>
			<WorkerCustomNodeSyncStatus
				state={state.syncState}
				verification={state.verification?.customNodes}
				visibleTargets={presentation.targets}
				backendState={state.backendState}
				starting={requests.syncAction}
				preparingReinstallNodeId={requests.preparingReinstallNodeId}
				preparingRemovalNodeName={requests.preparingRemovalNodeName}
				canceling={requests.syncCancelAction}
				error={requests.syncError}
				disabled={disabled}
				onSync={requests.syncCustomNodes}
				onReinstall={dialogs.requestCustomNodeReinstall}
				onRemove={dialogs.requestCustomNodeRemoval}
				onCancel={requests.cancelCustomNodes}
			/>
		</SyncAreaItem>
	);
}

function ModelsArea(props: AreaProps): React.JSX.Element {
	const state = useWorkerSessionSelector(
		(session) => ({
			modelSyncState: session.models,
			workerComfyState: session.comfy,
			setupState: session.setup,
			verification: session.verification,
		}),
		sameFields,
	);
	const requests = useModelsRequests();
	const { verificationAction, setupCancelAction } = useSetupRequests();
	const dialogs = useConnectionDialogs();
	const presentation = useMemo(
		() =>
			modelsPresentation({
				...state,
				modelSyncAction: requests.modelSyncAction,
				modelSyncCancelAction: requests.modelSyncCancelAction,
				modelSyncError: requests.modelSyncError,
				preparingRedownloadPath: requests.preparingRedownloadPath,
				verificationAction,
			}),
		[
			state,
			requests.modelSyncAction,
			requests.modelSyncCancelAction,
			requests.modelSyncError,
			requests.preparingRedownloadPath,
			verificationAction,
		],
	);
	const rate = useModelDownloadRate(state.modelSyncState);
	const disabled =
		setupCancelAction ||
		(state.setupState.status === "running" &&
			state.setupState.phase !== "preparation") ||
		state.workerComfyState.status === "loading" ||
		state.workerComfyState.status === "starting";
	return (
		<SyncAreaItem {...props} area={presentation.summary}>
			<WorkerModelSyncStatus
				state={state.modelSyncState}
				verification={state.verification?.models}
				visibleTargets={presentation.targets}
				rate={rate}
				starting={requests.modelSyncAction}
				preparingRedownloadPath={requests.preparingRedownloadPath}
				canceling={requests.modelSyncCancelAction}
				error={requests.modelSyncError}
				disabled={disabled}
				onSync={requests.syncModels}
				onRedownload={dialogs.requestModelRedownload}
				onCancel={requests.cancelModels}
			/>
		</SyncAreaItem>
	);
}

function SyncAreaItem({
	area,
	children,
	open,
	onOpenChange,
}: {
	area: SyncAreaSummary;
	children: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
	const trigger = useRef<HTMLButtonElement>(null);
	return (
		<li
			aria-label={`${area.label}: ${SYNC_STATUS_LABELS[area.status]}, ${area.completed}/${area.total}`}
		>
			<Popover
				open={open}
				onOpenChange={(nextOpen) => {
					if (nextOpen) trigger.current?.focus({ preventScroll: true });
					onOpenChange(nextOpen);
				}}
			>
				<Tooltip
					trigger={
						<PopoverTrigger asChild>
							<Button
								ref={trigger}
								type="button"
								variant="secondary"
								size="sm"
								aria-label={`Open ${area.label} status`}
								className={cn(
									"shrink-0 bg-sidebar-accent text-sidebar-accent-foreground shadow-none hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
									open && "ring-1 ring-inset ring-sidebar-ring/50",
								)}
							>
								<SyncAreaStatusIcon status={area.status} />
								<span className="text-sidebar-foreground/55">{area.shortLabel}</span>
								<span className="text-sidebar-foreground/55 tabular-nums">
									{area.completed}/{area.total}
								</span>
							</Button>
						</PopoverTrigger>
					}
				>
					{area.fullLabel}
				</Tooltip>
				<PopoverContent
					data-connection-control
					align="start"
					side="bottom"
					sideOffset={12}
					aria-label={`${area.label} status`}
					className="max-h-[min(32rem,calc(100vh-4rem))] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto p-0 select-text cursor-text"
					onInteractOutside={(event) => {
						const target = event.detail.originalEvent.target;
						if (
							target instanceof Element &&
							(target.closest("[data-worker-sync-action-menu]") !== null ||
								(area.id === "nodes" &&
									target.closest(
										"[data-custom-node-reinstall-dialog], [data-custom-node-removal-dialog]",
									) !== null) ||
								(area.id === "models" &&
									target.closest("[data-model-redownload-dialog]") !== null))
						) {
							event.preventDefault();
						}
					}}
				>
					{children}
				</PopoverContent>
			</Popover>
		</li>
	);
}

function SyncAreaStatusIcon({ status }: { status: SyncAreaStatus }): React.JSX.Element {
	const Icon =
		status === "synced"
			? CheckIcon
			: status === "warning" || status === "error"
				? CircleAlertIcon
				: status === "syncing"
					? LoaderCircleIcon
					: CircleIcon;
	return (
		<span
			className={cn(
				"inline-flex size-4 shrink-0 items-center justify-center",
				status === "synced" && "text-emerald-500",
				status === "warning" && "text-warning",
				status === "error" && "text-destructive",
				status === "pending" && "text-sidebar-foreground/45",
			)}
			aria-hidden="true"
		>
			<Icon
				className={cn(
					"size-full origin-center",
					status === "syncing" && "animate-spin",
				)}
			/>
		</span>
	);
}
