import {
	CheckIcon,
	CircleAlertIcon,
	CircleIcon,
	DownloadIcon,
	LoaderCircleIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	WorkerSyncActionMenu,
	WorkerSyncActionMenuItem,
	WorkerSyncCancelButton,
	WorkerSyncList,
	WorkerSyncListRow,
} from "@/components/WorkerSyncList";
import { cn } from "@/lib/utils";
import type {
	CollectionVerification,
	ModelSyncTarget,
	VerificationProblem,
	WorkerModelSyncState,
	WorkerModelTargetState,
	WorkerModelTargetStatus,
} from "../../../shared/api";

const MAX_ETA_MS = 24 * 60 * 60 * 1_000;

export function WorkerModelSyncStatus({
	state,
	verification,
	rate,
	starting,
	preparingRedownloadPath,
	canceling,
	error,
	disabled,
	onSync,
	onRedownload,
	onCancel,
}: {
	state: WorkerModelSyncState;
	verification?: CollectionVerification | undefined;
	rate: number | null;
	starting: boolean;
	preparingRedownloadPath: string | null;
	canceling: boolean;
	error: string | null;
	disabled: boolean;
	onSync: () => void;
	onRedownload: (path: string) => void;
	onCancel: () => void;
}): React.JSX.Element {
	const canStart =
		state.status !== "disconnected" &&
		state.status !== "loading" &&
		state.status !== "checking" &&
		state.status !== "syncing" &&
		state.status !== "canceling" &&
		!disabled &&
		!starting &&
		preparingRedownloadPath === null &&
		!canceling;
	const canForceRedownload =
		"capabilities" in state &&
		state.capabilities?.forceRedownload === true &&
		"targetStatus" in state &&
		state.targetStatus === "current";
	const targetModels = "targetModels" in state ? state.targetModels : undefined;
	if (targetModels !== undefined) {
		return (
			<WorkerModelFullListStatus
				state={state}
				targetModels={targetModels}
				verification={verification}
				rate={rate}
				canStart={canStart}
				canForceRedownload={canForceRedownload}
				starting={starting}
				preparingRedownloadPath={preparingRedownloadPath}
				canceling={canceling}
				error={error}
				onSync={onSync}
				onRedownload={onRedownload}
				onCancel={onCancel}
			/>
		);
	}
	return (
		<WorkerModelAggregateStatus
			state={state}
			rate={rate}
			canStart={canStart}
			starting={starting}
			canceling={canceling}
			error={error}
			onSync={onSync}
			onCancel={onCancel}
		/>
	);
}

function WorkerModelFullListStatus({
	state,
	targetModels,
	verification,
	rate,
	canStart,
	canForceRedownload,
	starting,
	preparingRedownloadPath,
	canceling,
	error,
	onSync,
	onRedownload,
	onCancel,
}: {
	state: WorkerModelSyncState;
	targetModels: WorkerModelTargetState[];
	verification?: CollectionVerification | undefined;
	rate: number | null;
	canStart: boolean;
	canForceRedownload: boolean;
	starting: boolean;
	preparingRedownloadPath: string | null;
	canceling: boolean;
	error: string | null;
	onSync: () => void;
	onRedownload: (path: string) => void;
	onCancel: () => void;
}): React.JSX.Element {
	const [openPath, setOpenPath] = useState<string | null>(null);
	const visibleModels = verifiedModelTargets(state, targetModels, verification);
	const ready = visibleModels.filter((model) => model.status === "ready").length;
	const totalBytes = visibleModels.reduce(
		(total, model) => total + model.target.artifact.sizeBytes,
		0,
	);
	const completedBytes = visibleModels.reduce(
		(total, model) =>
			total +
			(model.status === "ready"
				? model.target.artifact.sizeBytes
				: model.downloadedBytes),
		0,
	);
	const activeOperation =
		state.status === "checking" ||
		state.status === "syncing" ||
		state.status === "canceling";
	const interactionsDisabled = !canStart;
	const operationModel = redownloadOperationModel(
		state,
		visibleModels,
		preparingRedownloadPath,
	);
	const statusError = modelListError(state, error);
	const syncingAgain =
		state.status === "synced" ||
		state.status === "failed" ||
		state.status === "canceled";

	return (
		<WorkerSyncList
			titleId="worker-model-status-title"
			title="Models"
			status={modelListStatusMessage(
				state,
				ready,
				visibleModels.length,
				operationModel,
			)}
			action={
				activeOperation ? (
					<WorkerSyncCancelButton
						description={
							"operationKind" in state && state.operationKind === "redownload"
								? "model redownload"
								: "model synchronization"
						}
						canceling={canceling || state.status === "canceling"}
						onCancel={onCancel}
					/>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onSync}
						disabled={!canStart}
						aria-label={!starting && syncingAgain ? "Sync models again" : undefined}
					>
						{starting ? (
							<LoaderCircleIcon className="animate-spin" />
						) : syncingAgain ? (
							<RefreshCwIcon />
						) : (
							<DownloadIcon />
						)}
						{starting ? "Starting…" : syncingAgain ? "Sync again" : "Sync models"}
					</Button>
				)
			}
			progressLabel="Model synchronization"
			progressValue={completedBytes}
			progressMax={totalBytes}
			progressDetail={
				<>
					{formatBytes(completedBytes)} / {formatBytes(totalBytes)}
					{state.status === "syncing"
						? ` · ${downloadRateLabel(rate, totalBytes - completedBytes)}`
						: ""}
				</>
			}
			targetStatus={"targetStatus" in state ? state.targetStatus : undefined}
			error={statusError}
			onDismissActionMenu={() => setOpenPath(null)}
		>
			{visibleModels.map((model) => (
				<WorkerModelTargetRow
					key={model.target.path}
					model={model}
					showActions={canForceRedownload}
					disabled={interactionsDisabled}
					preparing={preparingRedownloadPath === model.target.path}
					menuOpen={openPath === model.target.path}
					onMenuOpenChange={(open) => setOpenPath(open ? model.target.path : null)}
					onRedownload={() => onRedownload(model.target.path)}
				/>
			))}
		</WorkerSyncList>
	);
}

function WorkerModelTargetRow({
	model,
	showActions,
	disabled,
	preparing,
	menuOpen,
	onMenuOpenChange,
	onRedownload,
}: {
	model: WorkerModelTargetState;
	showActions: boolean;
	disabled: boolean;
	preparing: boolean;
	menuOpen: boolean;
	onMenuOpenChange: (open: boolean) => void;
	onRedownload: () => void;
}): React.JSX.Element {
	const status = preparing ? "redownloading" : model.status;
	const progress =
		status === "downloading" || status === "redownloading"
			? `${formatBytes(model.downloadedBytes)} / ${formatBytes(model.target.artifact.sizeBytes)}`
			: status === "redownload-failed"
				? "Model file removed"
				: null;
	return (
		<WorkerSyncListRow
			ariaLabel={`${model.target.name}: ${modelStatusLabel(status)}`}
			icon={<ModelStatusIcon status={status} />}
			content={
				<div className="min-w-0">
					<p className="break-words text-xs font-medium">{model.target.name}</p>
					<p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
						{model.target.path}
					</p>
					<p className="mt-1 break-words text-[11px] text-muted-foreground">
						{providerLabel(model.target.artifact.provider)} ·{" "}
						{model.target.artifact.versionLabel} ·{" "}
						{formatBytes(model.target.artifact.sizeBytes)}
					</p>
				</div>
			}
			status={
				<div className="text-right">
					<p className={cn("text-[11px] font-medium", modelStatusColor(status))}>
						{modelStatusLabel(status)}
					</p>
					{progress === null ? null : (
						<p className="mt-1 text-[10px] text-muted-foreground tabular-nums">
							{progress}
						</p>
					)}
				</div>
			}
			action={
				showActions ? (
					<WorkerSyncActionMenu
						open={menuOpen}
						disabled={disabled}
						busy={status === "downloading" || status === "redownloading"}
						ariaLabel={`Actions for ${model.target.name}`}
						onOpenChange={onMenuOpenChange}
					>
						<WorkerSyncActionMenuItem
							icon={<RefreshCwIcon className="size-3.5" aria-hidden="true" />}
							onClick={() => {
								onMenuOpenChange(false);
								onRedownload();
							}}
						>
							Force redownload
						</WorkerSyncActionMenuItem>
					</WorkerSyncActionMenu>
				) : undefined
			}
		/>
	);
}

function WorkerModelAggregateStatus({
	state,
	rate,
	canStart,
	starting,
	canceling,
	error,
	onSync,
	onCancel,
}: {
	state: WorkerModelSyncState;
	rate: number | null;
	canStart: boolean;
	starting: boolean;
	canceling: boolean;
	error: string | null;
	onSync: () => void;
	onCancel: () => void;
}): React.JSX.Element {
	const syncingAgain =
		state.status === "synced" ||
		state.status === "failed" ||
		state.status === "canceled";
	return (
		<div className="grid gap-2 p-5">
			<p className="text-sm font-medium">Models</p>
			{state.status === "loading" || state.status === "disconnected" ? (
				<p className="text-xs text-muted-foreground" role="status">
					Loading model sync status…
				</p>
			) : null}
			{state.status === "idle" ? (
				<p className="text-xs text-muted-foreground" role="status">
					{state.models === null
						? "Not synced in this Worker session"
						: `${state.models.length} selected model files already present`}
				</p>
			) : null}
			{state.status === "checking" ? (
				<p className="text-xs text-muted-foreground" role="status">
					Checking {state.total} selected model files…
				</p>
			) : null}
			{state.status === "syncing" ? (
				<div className="grid gap-1 text-xs text-muted-foreground" role="status">
					<p className="tabular-nums">
						{state.completed}/{state.total} ready · {formatBytes(state.completedBytes)}{" "}
						/ {formatBytes(state.totalBytes)}
					</p>
					<p className="tabular-nums">
						{downloadRateLabel(rate, state.totalBytes - state.completedBytes)}
					</p>
					{state.present > 0 ? <p>{state.present} existing files reused</p> : null}
					{state.active.length > 0 ? (
						<p className="break-all font-mono text-[11px]">
							Downloading {state.active.join(", ")}
						</p>
					) : null}
				</div>
			) : null}
			{state.status === "canceling" ? (
				<p className="text-xs text-muted-foreground" role="status">
					Canceling model synchronization…
				</p>
			) : null}
			{state.status === "synced" ? (
				<p className="text-xs text-success" role="status">
					{state.models.length} model {state.models.length === 1 ? "file" : "files"}{" "}
					ready
				</p>
			) : null}
			{state.status === "failed" && state.models.length > 0 ? (
				<p className="text-xs text-muted-foreground" role="status">
					{state.models.length} model{" "}
					{state.models.length === 1 ? "file is" : "files are"} ready
				</p>
			) : null}
			{state.status === "canceled" ? (
				<p className="text-xs text-muted-foreground" role="status">
					Canceled · {state.models.length} model{" "}
					{state.models.length === 1 ? "file is" : "files are"} ready
				</p>
			) : null}
			{state.status === "failed" || state.status === "unavailable" || error ? (
				<p className="text-xs text-destructive" role="alert">
					{error ??
						(state.status === "failed" || state.status === "unavailable"
							? state.error
							: "")}
				</p>
			) : null}
			{state.status === "checking" || state.status === "syncing" ? (
				<WorkerSyncCancelButton
					description="model synchronization"
					canceling={canceling}
					onCancel={onCancel}
				/>
			) : null}
			{state.status === "canceling" ? (
				<WorkerSyncCancelButton description="model synchronization" canceling />
			) : null}
			{state.status !== "checking" &&
			state.status !== "syncing" &&
			state.status !== "canceling" ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onSync}
					disabled={!canStart}
					aria-label={!starting && syncingAgain ? "Sync models again" : undefined}
				>
					{starting ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon />}
					{starting ? "Starting…" : syncingAgain ? "Sync again" : "Sync models"}
				</Button>
			) : null}
		</div>
	);
}

function verifiedModelTargets(
	state: WorkerModelSyncState,
	targetModels: WorkerModelTargetState[],
	verification: CollectionVerification | undefined,
): WorkerModelTargetState[] {
	if (
		("operationKind" in state && state.operationKind === "redownload") ||
		!("targetStatus" in state) ||
		state.targetStatus !== "current"
	) {
		return targetModels;
	}
	if (verification?.status === "synced") {
		return targetModels.map((model) => ({
			target: model.target,
			status: "ready",
			downloadedBytes: model.target.artifact.sizeBytes,
		}));
	}
	if (verification?.status !== "out-of-sync") return targetModels;
	const problemsByPath = new Map<string, VerificationProblem[]>();
	for (const problem of verification.problems) {
		if (problem.expected === null) continue;
		const problems = problemsByPath.get(problem.name) ?? [];
		problems.push(problem);
		problemsByPath.set(problem.name, problems);
	}
	return targetModels.map((model) => {
		const problems = problemsByPath.get(model.target.path);
		if (problems === undefined) {
			return {
				target: model.target,
				status: "ready",
				downloadedBytes: model.target.artifact.sizeBytes,
			};
		}
		if (problems.some((problem) => problem.reason === "missing")) {
			return { ...model, status: "not-downloaded", downloadedBytes: 0 };
		}
		return { ...model, status: "needs-redownload", downloadedBytes: 0 };
	});
}

function redownloadOperationModel(
	state: WorkerModelSyncState,
	models: WorkerModelTargetState[],
	preparingPath: string | null,
): WorkerModelTargetState | undefined {
	if (preparingPath !== null) {
		return models.find((model) => model.target.path === preparingPath);
	}
	if (!("operationKind" in state) || state.operationKind !== "redownload") {
		return undefined;
	}
	return models.find(
		(model) =>
			model.status === "redownloading" ||
			model.status === "redownload-failed" ||
			model.status === "not-downloaded" ||
			(state.status === "failed" && model.error !== undefined),
	);
}

function modelListStatusMessage(
	state: WorkerModelSyncState,
	ready: number,
	total: number,
	operationModel: WorkerModelTargetState | undefined,
): string {
	if (operationModel !== undefined) {
		const name = operationModel.target.name;
		if (state.status === "canceling")
			return `Canceling redownload ${name} · ${ready}/${total}`;
		if (state.status === "canceled")
			return `Redownload canceled for ${name} · ${ready}/${total}`;
		if (state.status === "failed")
			return `Redownload failed for ${name} · ${ready}/${total}`;
		if (state.status === "synced")
			return `Redownload complete for ${name} · ${ready}/${total}`;
		return `Redownloading ${name} · ${ready}/${total}`;
	}
	if (state.status === "checking") return `Checking model files · ${ready}/${total}`;
	if (state.status === "syncing") {
		const active = modelsDownloading(state);
		return `Downloading ${active} ${active === 1 ? "model" : "models"} · ${ready}/${total}`;
	}
	if (state.status === "failed")
		return `Synchronization completed with errors · ${ready}/${total}`;
	if (state.status === "canceled")
		return `Synchronization canceled · ${ready}/${total}`;
	return `${ready} model ${ready === 1 ? "file" : "files"} ready · ${ready}/${total}`;
}

function modelsDownloading(state: WorkerModelSyncState): number {
	if (state.status !== "syncing") return 0;
	return state.active.length;
}

function modelListError(
	state: WorkerModelSyncState,
	error: string | null,
): string | null {
	if (error !== null) return error;
	if (state.status === "unavailable") return state.error;
	if (
		state.status === "canceled" &&
		"operationKind" in state &&
		state.operationKind === "redownload" &&
		state.models.length === 0 &&
		state.targetModels?.some((model) => model.status === "not-downloaded") === true
	) {
		return "Redownload was canceled after the previous Worker file was removed. Retry the download to use this model.";
	}
	if (state.status !== "failed") return null;
	if (
		"operationKind" in state &&
		state.operationKind === "redownload" &&
		state.targetModels?.some((model) => model.status === "redownload-failed") === true
	) {
		return `${state.error} The previous Worker file was removed. Retry the download to use this model.`;
	}
	return state.error;
}

function ModelStatusIcon({
	status,
}: {
	status: WorkerModelTargetStatus;
}): React.JSX.Element {
	const Icon =
		status === "ready"
			? CheckIcon
			: status === "downloading" || status === "redownloading"
				? LoaderCircleIcon
				: status === "not-downloaded"
					? CircleIcon
					: CircleAlertIcon;
	return (
		<Icon
			className={cn(
				"size-3.5",
				modelStatusColor(status),
				(status === "downloading" || status === "redownloading") && "animate-spin",
			)}
			aria-hidden="true"
		/>
	);
}

function modelStatusLabel(status: WorkerModelTargetStatus): string {
	return {
		ready: "Ready",
		downloading: "Downloading",
		"not-downloaded": "Not downloaded",
		failed: "Failed",
		"needs-redownload": "Needs redownload",
		redownloading: "Redownloading",
		"redownload-failed": "Redownload failed",
	}[status];
}

function modelStatusColor(status: WorkerModelTargetStatus): string {
	if (status === "ready") return "text-success";
	if (status === "failed" || status === "redownload-failed") return "text-destructive";
	if (
		status === "downloading" ||
		status === "redownloading" ||
		status === "needs-redownload"
	) {
		return "text-warning";
	}
	return "text-muted-foreground/45";
}

function providerLabel(provider: ModelSyncTarget["artifact"]["provider"]): string {
	return provider === "huggingface" ? "Hugging Face" : "CivitAI";
}

function downloadRateLabel(rate: number | null, remainingBytes: number): string {
	if (rate === null) return "Measuring speed…";
	const speed = `${formatBytes(Math.round(rate))}/s`;
	if (rate <= 0) return speed;
	const etaMs = (remainingBytes / rate) * 1_000;
	return etaMs > MAX_ETA_MS ? speed : `${speed} · ${formatDuration(etaMs)} left`;
}

function formatDuration(durationMs: number): string {
	const seconds = Math.floor(durationMs / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	const exponent = Math.min(
		Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1_024)),
		units.length - 1,
	);
	if (exponent === 0) return `${bytes} B`;
	const value = bytes / 1_024 ** exponent;
	return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}
