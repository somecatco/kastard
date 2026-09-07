import {
	FileTextIcon,
	LoaderCircleIcon,
	RefreshCwIcon,
	UnplugIcon,
} from "lucide-react";
import { useConnectionDialogs } from "@/components/connection/ConnectionDialogs";
import { Button } from "@/components/ui/button";
import { useConnectionRequests } from "@/hooks/use-connection-requests";
import { useWorkerSessionSelector } from "@/hooks/use-worker-session";
import { useSetupRequests } from "@/hooks/use-worker-setup-requests";
import { cn } from "@/lib/utils";
import type { ConnectionState } from "../../../../shared/api";

import { WorkerSynchronizationStatus } from "./WorkerSynchronizationStatus";
export function ConnectionDetails({
	onReconnect,
}: {
	onReconnect: () => void;
}): React.JSX.Element | null {
	const state = useWorkerSessionSelector((session) => session.connection);
	if (state.status !== "connected" && state.status !== "offline") return null;

	const offline = state.status === "offline";

	return (
		<div data-testid="connection-popover" className="select-text cursor-text">
			{offline ? null : <WorkerSynchronizationStatus />}

			<WorkerConnectionDetails state={state} onReconnect={onReconnect} />
		</div>
	);
}

function WorkerConnectionDetails({
	state,
	onReconnect,
}: {
	state: Extract<ConnectionState, { status: "connected" | "offline" }>;
	onReconnect: () => void;
}): React.JSX.Element {
	const connection = useConnectionRequests();
	const setup = useSetupRequests();
	const controller = {
		...connection,
		...useConnectionDialogs(),
		actionFeedback: connection.actionFeedback ?? setup.actionFeedback,
	};
	const offline = state.status === "offline";

	return (
		<div className={cn("grid gap-3 p-5", !offline && "border-t")}>
			{controller.actionFeedback ? (
				<p
					className={cn(
						"text-xs",
						controller.actionFeedback.type === "success"
							? "text-success"
							: "text-destructive",
					)}
					role={controller.actionFeedback.type === "success" ? "status" : "alert"}
				>
					{controller.actionFeedback.message}
				</p>
			) : state.status === "offline" ? (
				<p className="text-xs text-destructive" role="alert">
					{state.message}
				</p>
			) : null}
			<div>
				<p className="text-xs text-muted-foreground">Worker address</p>
				<p className="mt-1 break-all font-mono text-sm">{state.workerAddress}</p>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				{offline ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							if (state.reconnectRequired) onReconnect();
							else void controller.retry();
						}}
						disabled={controller.connectionAction !== null}
					>
						{!state.reconnectRequired && controller.connectionAction === "retry" ? (
							<LoaderCircleIcon className="animate-spin" />
						) : (
							<RefreshCwIcon />
						)}
						{state.reconnectRequired ? "Reconnect" : "Retry"}
					</Button>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={controller.viewLogs}
						disabled={controller.connectionAction !== null}
					>
						<FileTextIcon />
						View Worker logs
					</Button>
				)}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="text-destructive hover:bg-destructive/10 hover:text-destructive"
					onClick={() => void controller.disconnect()}
					disabled={controller.connectionAction !== null}
				>
					{controller.connectionAction === "disconnect" ? (
						<LoaderCircleIcon className="animate-spin" />
					) : (
						<UnplugIcon />
					)}
					Disconnect
				</Button>
			</div>
		</div>
	);
}
