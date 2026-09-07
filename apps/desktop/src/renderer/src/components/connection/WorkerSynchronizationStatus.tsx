import { LoaderCircleIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { WorkerSyncCancelButton } from "@/components/WorkerSyncList";
import { useSynchronizationControls } from "@/hooks/use-synchronization-controls";
import { cn } from "@/lib/utils";
import {
	canStartWorkerSetup,
	isSynchronizationBusy,
	isSynchronizationProgressActive,
	setupSynchronizationActive,
	setupSynchronizationCanceling,
	synchronizationProblems,
	synchronizationStatusMessage,
} from "@/lib/worker-synchronization";

export function WorkerSynchronizationStatus(): React.JSX.Element {
	const { state: controller, actions } = useSynchronizationControls();
	const problemsSummaryId = useId();
	const problemsListId = useId();
	const setupRunning = controller.setupState.status === "running";
	const synchronizationBusy = isSynchronizationBusy(controller);
	const synchronizationActive = setupSynchronizationActive(controller);
	const synchronizationCanceling = setupSynchronizationCanceling(controller);
	const checking =
		controller.verificationAction ||
		(controller.setupState.status === "running" &&
			controller.setupState.phase === "verification");
	const showStartSetup =
		!setupRunning &&
		!(
			controller.setupState.status === "idle" &&
			controller.setupState.pendingAutomaticStart === true
		);
	const problems = synchronizationProblems(controller);
	const problemsAreWarnings = controller.workerComfyState.status === "ready";
	const problemNoun = problemsAreWarnings ? "warning" : "problem";
	const problemsLabel = `Synchronization ${problemNoun}s`;
	const problemsSummary = `${problems.length} synchronization ${problemNoun}${
		problems.length === 1 ? "" : "s"
	}.`;
	const status = synchronizationStatusMessage(controller);
	const showProblems =
		problems.length > 0 && !isSynchronizationProgressActive(controller);

	return (
		<section className="grid gap-3 p-5">
			<div className="grid gap-2">
				<p className="text-sm font-medium">Synchronization status</p>
				{showProblems ? (
					<>
						<p
							key={`${problemsAreWarnings ? "warning" : "error"}:${problems.join("|")}`}
							id={problemsSummaryId}
							className="sr-only"
							role={problemsAreWarnings ? "status" : "alert"}
							aria-controls={problemsListId}
						>
							{problemsSummary}
						</p>
						<ul
							id={problemsListId}
							aria-label={problemsLabel}
							aria-describedby={problemsSummaryId}
							className={cn(
								"grid max-h-32 gap-1 overflow-y-auto break-words pr-1 text-xs font-medium",
								problemsAreWarnings ? "text-warning" : "text-destructive",
							)}
						>
							{problems.map((message) => (
								<li key={message}>{message}</li>
							))}
						</ul>
					</>
				) : (
					<p
						className={cn(
							"text-xs font-medium",
							controller.verification?.status === "synced" && !setupRunning
								? "text-success"
								: "text-muted-foreground",
						)}
						role="status"
					>
						{status}
					</p>
				)}
			</div>
			<div className="flex flex-wrap justify-start gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void actions.verifySynchronization()}
					disabled={synchronizationBusy}
				>
					{checking ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
					{checking ? "Checking…" : "Check sync status"}
				</Button>
				{synchronizationActive || synchronizationCanceling ? (
					<WorkerSyncCancelButton
						description="Worker synchronization"
						canceling={synchronizationCanceling}
						label="Cancel sync"
						onCancel={() => void actions.cancelWorkerSetup()}
					/>
				) : setupRunning ? (
					<Button type="button" variant="outline" size="sm" disabled>
						<LoaderCircleIcon className="animate-spin" />
						Resyncing…
					</Button>
				) : showStartSetup ? (
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={!canStartWorkerSetup(controller)}
						onClick={() => void actions.startWorkerSetup()}
					>
						{controller.setupStartAction ? (
							<LoaderCircleIcon className="animate-spin" />
						) : (
							<PlayIcon />
						)}
						{controller.setupStartAction
							? "Syncing…"
							: controller.setupState.status !== "idle" ||
									controller.workerComfyState.status === "ready"
								? "Resync"
								: "Sync"}
					</Button>
				) : null}
			</div>
		</section>
	);
}
