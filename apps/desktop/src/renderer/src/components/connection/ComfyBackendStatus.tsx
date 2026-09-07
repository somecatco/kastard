import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useId } from "react";
import { ProgressBar } from "@/components/common/progress-bar";
import { Button } from "@/components/ui/button";
import { useBackendControls } from "@/hooks/use-synchronization-controls";
import { cn } from "@/lib/utils";
import type { ComfyBackendStatusContent } from "@/lib/worker-backend-presentation";
import { workerComputeLabel } from "@/lib/worker-runtime";
import {
	backendMatchesEditorComfy,
	phaseLabel,
	workerComfyWarnings,
} from "@/lib/worker-synchronization";
export function ComfyBackendStatus({
	content,
}: {
	content: ComfyBackendStatusContent;
}): React.JSX.Element {
	const { state: controller, actions } = useBackendControls();
	const state = controller.backendState;
	const comfyState = controller.workerComfyState;
	const comfyWarnings = workerComfyWarnings(comfyState);
	const runtime = "runtime" in state ? state.runtime : null;
	const backendMatches = backendMatchesEditorComfy(controller);
	const isRetry = state.status === "failed" && state.retryable;
	const canPrepare = state.status === "not-installed" || isRetry;
	const canRestart = controller.canRestart;
	const setupStartingComfy =
		controller.setupState.status === "running" &&
		controller.setupState.phase === "comfy";
	const restartBusy =
		controller.comfyRestartAction ||
		comfyState.status === "starting" ||
		setupStartingComfy;
	const restartBlockedReason =
		controller.workflow === null
			? null
			: "Restart is unavailable while a workflow is active.";
	const restartBlockedReasonId = useId();

	const versionMismatch =
		state.status === "ready" && state.version !== state.editorComfyVersion;
	const showRequiredVersion =
		state.status !== "disconnected" &&
		state.status !== "loading" &&
		state.status !== "ready";
	const prepareLabel = controller.backendAction
		? isRetry
			? "Retrying…"
			: "Starting…"
		: isRetry
			? "Retry backend"
			: "Prepare backend";

	return (
		<section className="grid gap-4 p-5" aria-labelledby="comfy-backend-status-title">
			<header className="grid gap-2">
				<div className="flex items-start justify-between gap-4">
					<div className="grid gap-2">
						<h2 id="comfy-backend-status-title" className="text-sm font-medium">
							ComfyUI backend
						</h2>
						<p
							className={cn(
								"text-xs font-medium",
								content.tone === "success" && "text-success",
								content.tone === "warning" && "text-warning",
								content.tone === "muted" && "text-muted-foreground",
								content.tone === "error" && "text-destructive",
							)}
							role={content.tone === "error" ? "alert" : "status"}
						>
							{content.message}
						</p>
					</div>
					{canPrepare ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void actions.prepareBackend()}
							disabled={
								controller.setupState.status === "running" || controller.backendAction
							}
						>
							{controller.backendAction ? (
								<LoaderCircleIcon className="animate-spin" />
							) : isRetry ? (
								<RefreshCwIcon />
							) : (
								<DownloadIcon />
							)}
							{prepareLabel}
						</Button>
					) : backendMatches ? (
						<div className="grid justify-items-end gap-1">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void actions.restartWorkerComfy()}
								disabled={!canRestart}
								aria-describedby={
									restartBlockedReason === null ? undefined : restartBlockedReasonId
								}
								aria-label={
									restartBusy ? "Starting Worker ComfyUI" : "Restart Worker ComfyUI"
								}
							>
								{restartBusy ? (
									<LoaderCircleIcon className="animate-spin" />
								) : (
									<RefreshCwIcon />
								)}
								{restartBusy ? "Starting…" : "Restart"}
							</Button>
							{restartBlockedReason === null ? null : (
								<p
									id={restartBlockedReasonId}
									className="max-w-56 text-right text-xs text-muted-foreground"
								>
									{restartBlockedReason}
								</p>
							)}
						</div>
					) : null}
				</div>
				{versionMismatch && state.status === "ready" ? (
					<div className="grid gap-1 rounded-md bg-muted/55 px-3 py-2 font-mono text-[11px]">
						<p>Worker ComfyUI v{state.version}</p>
						<p className="text-warning">
							Kastard requires v{state.editorComfyVersion || "unknown"}
						</p>
					</div>
				) : state.status === "ready" ? (
					<p className="font-mono text-xs text-muted-foreground">
						ComfyUI v{state.version}
					</p>
				) : showRequiredVersion ? (
					<p className="font-mono text-xs text-muted-foreground">
						Required ComfyUI v{state.editorComfyVersion || "unknown"}
					</p>
				) : null}
			</header>
			{state.status === "preparing" ? (
				<div className="grid gap-1.5" role="status">
					<div className="flex justify-between text-xs text-muted-foreground">
						<span>
							{state.phaseElapsedMs === undefined
								? phaseLabel(state.phase)
								: `${formatDuration(state.phaseElapsedMs)}`}
							{state.totalElapsedMs === undefined
								? null
								: ` · ${formatDuration(state.totalElapsedMs)} total`}
						</span>
						<span>{state.progress}%</span>
					</div>
					<ProgressBar
						label="ComfyUI backend preparation"
						value={state.progress}
						showPercentage={false}
					/>
				</div>
			) : null}
			{content.detail === null ? null : (
				<p className="text-xs leading-relaxed text-muted-foreground">
					{content.detail}
				</p>
			)}
			{comfyWarnings.length === 0 ? null : (
				<div
					className="grid gap-1.5 text-xs text-warning select-text cursor-text"
					role="status"
				>
					<p>
						{comfyWarnings.length} custom node startup{" "}
						{comfyWarnings.length === 1 ? "warning" : "warnings"}
					</p>
					<ul
						className="grid max-h-32 gap-1 overflow-y-auto break-words font-mono text-[11px]"
						aria-label="Custom node startup warnings"
					>
						{comfyWarnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</div>
			)}
			{runtime === null ? null : (
				<p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
					{workerComputeLabel(runtime)} · Python {runtime.pythonVersion} · PyTorch{" "}
					{runtime.torchVersion}
				</p>
			)}
		</section>
	);
}

function formatDuration(durationMs: number): string {
	const seconds = Math.floor(durationMs / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}
