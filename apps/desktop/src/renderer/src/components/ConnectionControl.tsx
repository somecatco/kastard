import { LoaderCircleIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { Popover, PopoverContent } from "@/components/common/popover";
import { ConnectionDetails } from "@/components/connection/ConnectionDetails";
import { useConnectionDialogs } from "@/components/connection/ConnectionDialogs";
import { SynchronizationAreas } from "@/components/connection/SynchronizationAreas";
import { Button } from "@/components/ui/button";
import { PopoverTrigger } from "@/components/ui/popover";
import { useConnectionRequests } from "@/hooks/use-connection-requests";
import { sameFields, useWorkerSessionSelector } from "@/hooks/use-worker-session";
import { cn } from "@/lib/utils";
import type { SyncAreaId } from "@/lib/worker-synchronization";
import type { WorkerWorkflowCurrentState } from "../../../shared/api";

const CONNECTION_MINUTE_MS = 60_000;

export type ConnectionPopoverId = "details" | SyncAreaId;
function useConnectionControlState() {
	const session = useWorkerSessionSelector(
		(state) => ({ state: state.connection, workflow: state.workflow ?? null }),
		sameFields,
	);
	const connection = useConnectionRequests();
	const { showDialog } = useConnectionDialogs();
	return {
		...session,
		...connection,
		showDialog,
	};
}

function ConnectionElapsedTime({
	connectedAt,
}: {
	connectedAt: number;
}): React.JSX.Element {
	const [now, setNow] = useState(Date.now);
	const totalMinutes = Math.floor(
		Math.max(0, now - connectedAt) / CONNECTION_MINUTE_MS,
	);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	useEffect(() => {
		const elapsed = Math.max(0, now - connectedAt);
		const timeout = window.setTimeout(
			() => setNow(Date.now()),
			CONNECTION_MINUTE_MS - (elapsed % CONNECTION_MINUTE_MS),
		);
		return () => window.clearTimeout(timeout);
	}, [connectedAt, now]);

	return (
		<>
			<span className="tabular-nums text-sidebar-foreground/60" aria-hidden="true">
				{hours}h {minutes}m
			</span>
			<span className="sr-only">
				for {hours} {hours === 1 ? "hour" : "hours"} {minutes}{" "}
				{minutes === 1 ? "minute" : "minutes"}
			</span>
		</>
	);
}

export function ConnectionControl({
	openPopovers,
	onPopoverOpenChange,
	closeRequest,
}: {
	openPopovers: ReadonlySet<ConnectionPopoverId>;
	onPopoverOpenChange: (popover: ConnectionPopoverId, open: boolean) => void;
	closeRequest: number;
}): React.JSX.Element {
	const controller = useConnectionControlState();
	const closePopovers = useEffectEvent((keepDetails = false) => {
		for (const popover of openPopovers) {
			if (!keepDetails || popover !== "details") {
				onPopoverOpenChange(popover, false);
			}
		}
	});
	const detailsOpen = openPopovers.has("details");

	useEffect(() => {
		if (closeRequest !== 0) closePopovers();
	}, [closeRequest]);

	useEffect(() => {
		if (controller.state.status === "connected") return;
		if (controller.state.status === "offline" || controller.state.status === "error") {
			closePopovers(true);
			return;
		}
		closePopovers();
	}, [controller.state.status]);

	if (controller.state.status === "disconnected") {
		return (
			<div className="flex min-w-0 shrink-0 items-center gap-2">
				<Button type="button" size="sm" onClick={controller.showDialog}>
					<PlugIcon aria-hidden="true" />
					Connect
				</Button>
				{controller.workflow === null ? null : (
					<CompactWorkflowStatus workflow={controller.workflow} />
				)}
			</div>
		);
	}
	if (
		controller.state.status === "connected" ||
		controller.state.status === "offline"
	) {
		const offline = controller.state.status === "offline";
		const connectedAt =
			controller.state.status === "connected" ? controller.state.connectedAt : null;
		return (
			<div className="flex min-w-0 items-center gap-1.5">
				<Popover
					open={detailsOpen}
					onOpenChange={(open) => {
						if (open) controller.clearSuccessFeedback();
						onPopoverOpenChange("details", open);
					}}
				>
					<PopoverTrigger asChild>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className={cn(
								"shrink-0 bg-sidebar-accent text-sidebar-accent-foreground shadow-none hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
								detailsOpen && "ring-1 ring-inset ring-sidebar-ring/50",
							)}
						>
							<span
								className={cn(
									"size-2 rounded-full",
									offline ? "bg-red-400" : "bg-emerald-400",
								)}
								aria-hidden="true"
							/>
							<span>{offline ? "Offline" : "Connected"}</span>
							{connectedAt === null ? null : (
								<ConnectionElapsedTime connectedAt={connectedAt} />
							)}
						</Button>
					</PopoverTrigger>
					<PopoverContent
						data-connection-control
						align="start"
						side="bottom"
						sideOffset={12}
						aria-label="Connection details"
						className="max-h-[min(38rem,calc(100vh-4rem))] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto p-0"
					>
						<ConnectionDetails
							onReconnect={() => {
								onPopoverOpenChange("details", false);
								controller.showDialog();
							}}
						/>
					</PopoverContent>
				</Popover>
				{!offline ? (
					<SynchronizationAreas
						openPopovers={openPopovers}
						onPopoverOpenChange={onPopoverOpenChange}
					/>
				) : null}
			</div>
		);
	}

	if (controller.state.status === "error") {
		return (
			<Popover
				open={detailsOpen}
				onOpenChange={(open) => onPopoverOpenChange("details", open)}
			>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="secondary"
						size="xs"
						className="bg-sidebar-accent text-sidebar-accent-foreground shadow-none hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
					>
						<span className="size-2 rounded-full bg-red-400" aria-hidden="true" />
						<span>Connection error</span>
					</Button>
				</PopoverTrigger>
				<PopoverContent data-connection-control align="start" className="w-80">
					<div className="grid gap-4">
						<div>
							<p className="text-sm font-medium">Connection error</p>
							<p className="mt-1 text-sm text-destructive" role="alert">
								{controller.actionFeedback?.type === "error"
									? controller.actionFeedback.message
									: controller.state.message}
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void controller.retryInitialization()}
							disabled={controller.connectionAction === "initialize"}
						>
							{controller.connectionAction === "initialize" ? (
								<LoaderCircleIcon className="animate-spin" />
							) : (
								<RefreshCwIcon />
							)}
							{controller.connectionAction === "initialize" ? "Retrying…" : "Retry"}
						</Button>
					</div>
				</PopoverContent>
			</Popover>
		);
	}
	return (
		<div className="flex h-7 items-center gap-1.5 px-2.5 text-xs" role="status">
			<span className="size-2 rounded-full bg-amber-400" aria-hidden="true" />
			<span>Connecting…</span>
		</div>
	);
}

function CompactWorkflowStatus({
	workflow,
}: {
	workflow: WorkerWorkflowCurrentState;
}): React.JSX.Element {
	return (
		<div
			className="min-w-0 select-text text-xs text-muted-foreground cursor-text"
			role="status"
		>
			<p>{workflowStatusLabel(workflow)}</p>
			<p className="max-w-64 truncate font-mono" title={workflow.workerAddress}>
				{workflow.workerAddress}
			</p>
		</div>
	);
}

function workflowStatusLabel(workflow: WorkerWorkflowCurrentState): string {
	if (workflow.cancellation === "requested") return "Canceling…";
	if (workflow.cancellation === "unconfirmed") return "Cancellation unconfirmed";
	if (workflow.phase === "dispatching") return "Dispatching";
	if (workflow.phase === "reconciling") return "Checking Worker state";
	if (workflow.phase === "collecting") return "Collecting results";
	return "Running";
}
