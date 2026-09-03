import {
	CheckIcon,
	CircleAlertIcon,
	CircleIcon,
	DownloadIcon,
	LoaderCircleIcon,
	RefreshCwIcon,
	TrashIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	WorkerSyncActionMenu,
	WorkerSyncActionMenuItem,
	WorkerSyncCancelButton,
	WorkerSyncList,
	WorkerSyncListRow,
	WorkerSyncTargetNotice,
} from "@/components/WorkerSyncList";
import { cn } from "@/lib/utils";
import type {
	CollectionVerification,
	CustomNodeInventoryEntry,
	VerificationProblem,
	WorkerBackendState,
	WorkerCustomNodeSyncState,
	WorkerCustomNodeTargetState,
} from "../../../shared/api";

type CustomNodeReinstallProgress = {
	nodeId: string;
	rowLabel: "Preparing…" | "Removing…" | "Installing…";
	message: string;
};

export function verifiedCustomNodeTargets(
	targetNodes: WorkerCustomNodeTargetState[],
	verification: CollectionVerification | undefined,
): WorkerCustomNodeTargetState[] | null {
	if (verification?.status === "synced") {
		return targetNodes.map((node) => ({
			...node,
			status: "installed",
			workerVersion: node.editorVersion,
		}));
	}
	if (verification?.status !== "out-of-sync") return null;
	const problemsByName = new Map<string, VerificationProblem[]>();
	for (const problem of verification.problems) {
		if (problem.expected === null) continue;
		const problems = problemsByName.get(problem.name) ?? [];
		problems.push(problem);
		problemsByName.set(problem.name, problems);
	}
	return targetNodes.map((node) => {
		const problems = problemsByName.get(node.id);
		if (problems === undefined) {
			return {
				...node,
				status: "installed",
				workerVersion: node.editorVersion,
			};
		}
		if (problems.some((problem) => problem.reason === "missing")) {
			return {
				...node,
				status: node.error === undefined ? "not-installed" : "failed",
				workerVersion: null,
			};
		}
		const mismatch = problems.find((problem) => problem.reason === "version-mismatch");
		if (mismatch !== undefined) {
			return {
				...node,
				status: node.error === undefined ? "version-mismatch" : "failed",
				workerVersion: mismatch.actual,
			};
		}
		return { ...node, status: "failed" };
	});
}

export function WorkerCustomNodeSyncStatus({
	state,
	verification,
	backendState,
	starting,
	preparingReinstallNodeId,
	preparingRemovalNodeName,
	canceling,
	error,
	disabled,
	onSync,
	onReinstall,
	onRemove,
	onCancel,
}: {
	state: WorkerCustomNodeSyncState;
	verification?: CollectionVerification | undefined;
	backendState: WorkerBackendState;
	starting: boolean;
	preparingReinstallNodeId: string | null;
	preparingRemovalNodeName: string | null;
	canceling: boolean;
	error: string | null;
	disabled: boolean;
	onSync: () => void;
	onReinstall: (id: string) => void;
	onRemove: (node: CustomNodeInventoryEntry) => void;
	onCancel: () => void;
}): React.JSX.Element {
	const backendMatches =
		backendState.status === "ready" &&
		backendState.version === backendState.editorComfyVersion;
	const unsupportedNodes = "unsupportedNodes" in state ? state.unsupportedNodes : [];
	const canStart =
		backendMatches &&
		state.status !== "disconnected" &&
		state.status !== "loading" &&
		state.status !== "syncing" &&
		state.status !== "canceling" &&
		!disabled &&
		!starting &&
		preparingReinstallNodeId === null &&
		preparingRemovalNodeName === null &&
		!canceling;
	const canForceReinstall =
		"capabilities" in state &&
		state.capabilities?.forceReinstall === true &&
		"targetStatus" in state &&
		state.targetStatus === "current";
	const canRemove =
		"capabilities" in state &&
		state.capabilities?.remove === true &&
		"targetStatus" in state &&
		state.targetStatus === "current";
	const syncingAgain =
		state.status === "ready" ||
		state.status === "failed" ||
		state.status === "canceled";
	const reinstallProgress = customNodeReinstallProgress(
		state,
		preparingReinstallNodeId,
	);
	const targetNodes = "targetNodes" in state ? state.targetNodes : undefined;
	if (targetNodes !== undefined) {
		return (
			<WorkerCustomNodeFullListStatus
				state={state}
				targetNodes={targetNodes}
				verification={verification}
				backendMatches={backendMatches}
				canStart={canStart}
				starting={starting}
				reinstallProgress={reinstallProgress}
				preparingRemovalNodeName={preparingRemovalNodeName}
				canceling={canceling}
				syncingAgain={syncingAgain}
				error={error}
				onSync={onSync}
				onReinstall={onReinstall}
				onRemove={onRemove}
				onCancel={onCancel}
				canForceReinstall={canForceReinstall}
				canRemove={canRemove}
			/>
		);
	}
	return (
		<div className="grid gap-2 p-5">
			<p className="text-sm font-medium">Custom nodes</p>
			<WorkerSyncTargetNotice
				status={"targetStatus" in state ? state.targetStatus : undefined}
			/>
			{state.status === "loading" || state.status === "disconnected" ? (
				<p className="text-xs text-muted-foreground" role="status">
					Loading sync status…
				</p>
			) : null}
			{state.status === "idle" ? (
				<WorkerNodeInventory
					nodes={state.nodes}
					emptyLabel="Not synced in this Worker session"
					suffix="before sync"
				/>
			) : null}
			{state.status === "syncing" ? (
				<div className="grid gap-1 text-xs text-muted-foreground" role="status">
					<p>
						{reinstallProgress?.message ??
							(state.phase === "install"
								? `Installing ${state.currentNode ?? "custom nodes"}`
								: state.phase === "validate"
									? "Validating custom nodes"
									: `Removing ${state.currentNode ?? "custom node"}`)}
					</p>
					<p className="tabular-nums">
						{state.current}/{state.total}
					</p>
				</div>
			) : null}
			{state.status === "canceling" ? (
				<p className="text-xs text-muted-foreground" role="status">
					{"operationKind" in state && state.operationKind === "remove"
						? "Canceling custom node removal…"
						: "Canceling custom node synchronization…"}
				</p>
			) : null}
			{state.status === "ready" ? (
				<div className="grid gap-1 text-xs text-success" role="status">
					<p>
						{state.nodes.length} custom {state.nodes.length === 1 ? "node" : "nodes"}{" "}
						synchronized
					</p>
					{state.nodes.length > 0 ? (
						<ul className="grid max-h-32 gap-0.5 overflow-y-auto break-all font-mono text-[11px] text-muted-foreground">
							{state.nodes.map((node) => (
								<li key={node.id}>
									{node.id}@{node.version}
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
			{state.status === "failed" ? (
				<WorkerNodeInventory nodes={state.nodes} suffix="after failure" />
			) : null}
			{state.status === "canceled" ? (
				<WorkerNodeInventory nodes={state.nodes} suffix="after cancellation" />
			) : null}
			{state.status === "failed" || state.status === "unavailable" || error ? (
				<p className="text-xs text-destructive" role="alert">
					{error ??
						(state.status === "failed" || state.status === "unavailable"
							? state.error
							: "")}
				</p>
			) : null}
			{unsupportedNodes.length > 0 ? (
				<div className="grid gap-1 text-xs text-warning">
					<p>{unsupportedNodes.length} selected custom nodes are unsupported</p>
					<ul className="grid gap-1 break-words font-mono">
						{unsupportedNodes.map((node) => (
							<li key={node.name} className="select-text">
								{node.name} · {node.reason}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{!backendMatches ? (
				<p className="text-xs text-muted-foreground">
					Prepare the matching ComfyUI backend before syncing.
				</p>
			) : null}
			{state.status === "syncing" &&
			!("operationKind" in state && state.operationKind === "remove") ? (
				<WorkerSyncCancelButton
					description="custom node synchronization"
					canceling={canceling}
					onCancel={onCancel}
				/>
			) : null}
			{state.status === "canceling" &&
			!("operationKind" in state && state.operationKind === "remove") ? (
				<WorkerSyncCancelButton description="custom node synchronization" canceling />
			) : null}
			{state.status !== "syncing" && state.status !== "canceling" ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onSync}
					disabled={!canStart}
					aria-label={!starting && syncingAgain ? "Sync custom nodes again" : undefined}
				>
					{starting ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon />}
					{starting ? "Starting…" : syncingAgain ? "Sync again" : "Sync custom nodes"}
				</Button>
			) : null}
		</div>
	);
}

function WorkerCustomNodeFullListStatus({
	state,
	targetNodes,
	verification,
	backendMatches,
	canStart,
	starting,
	reinstallProgress,
	preparingRemovalNodeName,
	canceling,
	syncingAgain,
	error,
	onSync,
	onReinstall,
	onRemove,
	onCancel,
	canForceReinstall,
	canRemove,
}: {
	state: WorkerCustomNodeSyncState;
	targetNodes: WorkerCustomNodeTargetState[];
	verification?: CollectionVerification | undefined;
	backendMatches: boolean;
	canStart: boolean;
	starting: boolean;
	reinstallProgress: CustomNodeReinstallProgress | null;
	preparingRemovalNodeName: string | null;
	canceling: boolean;
	syncingAgain: boolean;
	error: string | null;
	onSync: () => void;
	onReinstall: (id: string) => void;
	onRemove: (node: CustomNodeInventoryEntry) => void;
	onCancel: () => void;
	canForceReinstall: boolean;
	canRemove: boolean;
}): React.JSX.Element {
	const [openNodeId, setOpenNodeId] = useState<string | null>(null);
	useEffect(() => {
		if (!canStart || (!canForceReinstall && !canRemove)) {
			setOpenNodeId(null);
		}
	}, [canForceReinstall, canRemove, canStart]);
	const unsupportedNodes = "unsupportedNodes" in state ? state.unsupportedNodes : [];
	const visibleTargetNodes =
		"targetStatus" in state && state.targetStatus === "current"
			? (verifiedCustomNodeTargets(targetNodes, verification) ?? targetNodes)
			: targetNodes;
	const installed = visibleTargetNodes.filter(
		(node) => node.status === "installed",
	).length;
	const total = visibleTargetNodes.length + unsupportedNodes.length;
	const unselectedNodes =
		"unselectedNodes" in state ? state.unselectedNodes : undefined;
	const activeReinstallNodeId =
		"reinstallNodeId" in state ? state.reinstallNodeId : undefined;
	const operationRemovalNodeName =
		"operationKind" in state && state.operationKind === "remove"
			? state.removalNode?.name
			: undefined;
	const activeRemovalNodeName =
		state.status === "syncing" || state.status === "canceling"
			? operationRemovalNodeName
			: undefined;
	const removalRowNodeName = preparingRemovalNodeName ?? activeRemovalNodeName;
	const statusMessage =
		preparingRemovalNodeName === null
			? customNodeListStatusMessage(
					state,
					installed,
					total,
					reinstallProgress,
					activeReinstallNodeId,
					operationRemovalNodeName,
				)
			: `Preparing to remove ${preparingRemovalNodeName}…`;
	const statusError = customNodeListError(state, visibleTargetNodes, error);
	const action =
		state.status === "syncing" || state.status === "canceling" ? (
			activeRemovalNodeName === undefined ? (
				<WorkerSyncCancelButton
					description={
						activeReinstallNodeId !== undefined
							? "custom node reinstall"
							: "custom node synchronization"
					}
					canceling={canceling || state.status === "canceling"}
					onCancel={onCancel}
				/>
			) : null
		) : (
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={onSync}
				disabled={!canStart}
				aria-label={!starting && syncingAgain ? "Sync custom nodes again" : undefined}
			>
				{starting ? (
					<LoaderCircleIcon className="animate-spin" />
				) : syncingAgain ? (
					<RefreshCwIcon />
				) : (
					<DownloadIcon />
				)}
				{starting ? "Starting…" : syncingAgain ? "Sync again" : "Sync custom nodes"}
			</Button>
		);
	return (
		<WorkerSyncList
			titleId="worker-custom-node-status-title"
			title="Custom nodes"
			status={`${statusMessage} · ${installed}/${total}`}
			action={action}
			progressLabel="Custom node synchronization"
			progressValue={installed}
			progressMax={total}
			targetStatus={"targetStatus" in state ? state.targetStatus : undefined}
			error={statusError}
			onDismissActionMenu={() => setOpenNodeId(null)}
			afterList={
				<>
					{unselectedNodes !== undefined &&
					(unselectedNodes === null || unselectedNodes.length > 0) ? (
						<footer className="grid gap-2 border-t bg-muted/35 px-5 py-3">
							<p className="text-[11px] font-medium text-muted-foreground">
								Not Selected for Sync
							</p>
							{unselectedNodes === null ? (
								<p className="text-[11px] text-muted-foreground">
									Worker inventory unavailable
								</p>
							) : (
								unselectedNodes.map((node) => (
									<WorkerCustomNodeInventoryRow
										key={node.name}
										node={node}
										showActions={canRemove}
										disabled={!canStart}
										removing={removalRowNodeName === node.name}
										menuOpen={openNodeId === `worker:${node.name}`}
										onMenuOpenChange={(open) =>
											setOpenNodeId(open ? `worker:${node.name}` : null)
										}
										onRemove={() => onRemove(node)}
									/>
								))
							)}
						</footer>
					) : null}
					{unsupportedNodes.length > 0 ? (
						<div className="grid gap-1 border-t px-5 py-3 text-xs text-warning">
							<p>{unsupportedNodes.length} selected custom nodes are unsupported</p>
							<ul className="grid gap-1 break-words font-mono">
								{unsupportedNodes.map((node) => (
									<li key={node.name}>
										{node.name} · {node.reason}
									</li>
								))}
							</ul>
						</div>
					) : null}
					{!backendMatches ? (
						<p className="border-t px-5 py-3 text-xs text-muted-foreground">
							Prepare the matching ComfyUI backend before syncing.
						</p>
					) : null}
				</>
			}
		>
			{visibleTargetNodes.map((node) => (
				<WorkerCustomNodeTargetRow
					key={node.id}
					node={node}
					showActions={canForceReinstall}
					disabled={!canStart}
					operationLabel={
						reinstallProgress?.nodeId === node.id ? reinstallProgress.rowLabel : null
					}
					menuOpen={openNodeId === `target:${node.id}`}
					onMenuOpenChange={(open) => setOpenNodeId(open ? `target:${node.id}` : null)}
					onReinstall={() => onReinstall(node.id)}
				/>
			))}
		</WorkerSyncList>
	);
}

function WorkerCustomNodeTargetRow({
	node,
	showActions,
	disabled,
	operationLabel,
	menuOpen,
	onMenuOpenChange,
	onReinstall,
}: {
	node: WorkerCustomNodeTargetState;
	showActions: boolean;
	disabled: boolean;
	operationLabel: CustomNodeReinstallProgress["rowLabel"] | null;
	menuOpen: boolean;
	onMenuOpenChange: (open: boolean) => void;
	onReinstall: () => void;
}): React.JSX.Element {
	const operationActive = operationLabel !== null;
	const failureReason =
		!operationActive && node.status === "failed" ? node.error : undefined;
	return (
		<WorkerSyncListRow
			ariaLabel={`${node.id}: ${operationLabel ?? customNodeStatusLabel(node.status)}${failureReason === undefined ? "" : `. ${failureReason}`}`}
			icon={
				<CustomNodeStatusIcon status={operationActive ? "installing" : node.status} />
			}
			content={
				<div className="min-w-0">
					<p className="break-all font-mono text-xs">{node.id}</p>
					<p className="mt-1 break-words text-[11px] text-muted-foreground">
						Editor {node.editorVersion} · Worker {node.workerVersion ?? "not installed"}
					</p>
					{failureReason === undefined ? null : (
						<p className="mt-1 break-words text-[11px] text-destructive">
							{failureReason}
						</p>
					)}
				</div>
			}
			status={
				<p
					className={cn(
						"text-right text-[11px] font-medium",
						operationActive ? "text-warning" : customNodeStatusColor(node.status),
					)}
				>
					{operationLabel ?? customNodeStatusLabel(node.status)}
				</p>
			}
			action={
				showActions ? (
					<WorkerSyncActionMenu
						open={menuOpen}
						disabled={disabled}
						busy={operationActive}
						ariaLabel={`Actions for ${node.id}`}
						onOpenChange={onMenuOpenChange}
					>
						<WorkerSyncActionMenuItem
							icon={<RefreshCwIcon className="size-3.5" aria-hidden="true" />}
							onClick={() => {
								onMenuOpenChange(false);
								onReinstall();
							}}
						>
							Force reinstall
						</WorkerSyncActionMenuItem>
					</WorkerSyncActionMenu>
				) : undefined
			}
		/>
	);
}

function WorkerCustomNodeInventoryRow({
	node,
	showActions,
	disabled,
	removing,
	menuOpen,
	onMenuOpenChange,
	onRemove,
}: {
	node: CustomNodeInventoryEntry;
	showActions: boolean;
	disabled: boolean;
	removing: boolean;
	menuOpen: boolean;
	onMenuOpenChange: (open: boolean) => void;
	onRemove: () => void;
}): React.JSX.Element {
	return (
		<div
			className={cn(
				"grid items-center gap-3 text-[11px]",
				showActions
					? "grid-cols-[minmax(0,1fr)_auto_auto]"
					: "grid-cols-[minmax(0,1fr)_auto]",
			)}
		>
			<code className="break-all">
				{node.repository ?? node.managerId ?? node.name}@{node.version ?? "unknown"}
			</code>
			<span className={removing ? "text-warning" : "text-muted-foreground"}>
				{removing ? "Removing…" : "Installed on Worker"}
			</span>
			{showActions ? (
				<WorkerSyncActionMenu
					open={menuOpen}
					disabled={disabled}
					busy={removing}
					ariaLabel={`Actions for ${node.name}`}
					contentClassName="w-48"
					onOpenChange={onMenuOpenChange}
				>
					<WorkerSyncActionMenuItem
						icon={<TrashIcon className="size-3.5" aria-hidden="true" />}
						destructive
						onClick={() => {
							onMenuOpenChange(false);
							onRemove();
						}}
					>
						Delete from Worker
					</WorkerSyncActionMenuItem>
				</WorkerSyncActionMenu>
			) : null}
		</div>
	);
}

function CustomNodeStatusIcon({
	status,
}: {
	status: WorkerCustomNodeTargetState["status"];
}): React.JSX.Element {
	const Icon =
		status === "installed"
			? CheckIcon
			: status === "installing"
				? LoaderCircleIcon
				: status === "not-installed"
					? CircleIcon
					: CircleAlertIcon;
	return (
		<Icon
			className={cn(
				"size-3.5",
				status === "not-installed"
					? "text-muted-foreground/45"
					: customNodeStatusColor(status),
				status === "installing" && "animate-spin",
			)}
			aria-hidden="true"
		/>
	);
}

function customNodeStatusLabel(status: WorkerCustomNodeTargetState["status"]): string {
	return {
		installed: "Installed",
		installing: "Installing",
		"not-installed": "Not installed",
		failed: "Failed",
		"version-mismatch": "Version mismatch",
	}[status];
}

function customNodeStatusColor(status: WorkerCustomNodeTargetState["status"]): string {
	if (status === "installed") return "text-success";
	if (status === "failed") return "text-destructive";
	if (status === "installing" || status === "version-mismatch") {
		return "text-warning";
	}
	return "text-muted-foreground";
}

function customNodeListStatusMessage(
	state: WorkerCustomNodeSyncState,
	installed: number,
	total: number,
	reinstallProgress: CustomNodeReinstallProgress | null,
	reinstallNodeId?: string,
	removalNodeName?: string,
): string {
	if (reinstallProgress !== null) return reinstallProgress.message;
	if (reinstallNodeId !== undefined) {
		if (state.status === "canceling") return `Canceling reinstall ${reinstallNodeId}`;
		if (state.status === "canceled") return `Reinstall canceled for ${reinstallNodeId}`;
		if (state.status === "failed") return `Reinstall failed for ${reinstallNodeId}`;
		if (state.status === "ready") return `Reinstalled ${reinstallNodeId}`;
	}
	if (removalNodeName !== undefined) {
		if (state.status === "syncing") {
			return "removalPhase" in state && state.removalPhase === "prepare"
				? `Preparing to remove ${removalNodeName}…`
				: `Removing ${removalNodeName}…`;
		}
		if (state.status === "canceling") return `Canceling removal ${removalNodeName}`;
		if (state.status === "canceled") return `Removal canceled for ${removalNodeName}`;
		if (state.status === "failed") {
			const removed =
				"unselectedNodes" in state &&
				state.unselectedNodes !== null &&
				!state.unselectedNodes.some((node) => node.name === removalNodeName);
			return removed
				? `Removed ${removalNodeName}, but custom nodes need attention`
				: `Removal failed for ${removalNodeName}`;
		}
		if (state.status === "ready") {
			return `Removed ${removalNodeName} from Worker storage. Restart Worker ComfyUI if it is running`;
		}
		return `Preparing to remove ${removalNodeName}…`;
	}
	if (state.status === "syncing") {
		return state.phase === "install"
			? `Installing ${state.currentNode ?? "custom nodes"}`
			: state.phase === "validate"
				? "Validating custom nodes"
				: `Removing ${state.currentNode ?? "custom node"}`;
	}
	if (state.status === "canceling") return "Canceling custom node synchronization";
	if (state.status === "canceled") return "Synchronization canceled";
	if (state.status === "failed") return "Synchronization completed with errors";
	if (state.status === "ready") {
		return `${installed} custom ${installed === 1 ? "node" : "nodes"} synchronized`;
	}
	return total === 0
		? "No custom nodes selected for sync"
		: `${installed} of ${total} custom nodes installed`;
}

function customNodeReinstallProgress(
	state: WorkerCustomNodeSyncState,
	startingNodeId: string | null,
): CustomNodeReinstallProgress | null {
	if (startingNodeId !== null) {
		return {
			nodeId: startingNodeId,
			rowLabel: "Preparing…",
			message: `Preparing reinstall ${startingNodeId}…`,
		};
	}
	if (
		state.status !== "syncing" ||
		!("operationKind" in state) ||
		state.operationKind !== "reinstall" ||
		!("reinstallNodeId" in state) ||
		state.reinstallNodeId === undefined
	) {
		return null;
	}
	const nodeId = state.reinstallNodeId;
	const reinstallPhase = "reinstallPhase" in state ? state.reinstallPhase : undefined;
	if (reinstallPhase === "remove") {
		return { nodeId, rowLabel: "Removing…", message: `Removing ${nodeId}…` };
	}
	if (reinstallPhase === "install") {
		return { nodeId, rowLabel: "Installing…", message: `Installing ${nodeId}…` };
	}
	const targetNode =
		"targetNodes" in state
			? state.targetNodes?.find((node) => node.id === nodeId)
			: undefined;
	if (reinstallPhase === undefined && targetNode?.status === "installing") {
		return { nodeId, rowLabel: "Installing…", message: `Installing ${nodeId}…` };
	}
	return {
		nodeId,
		rowLabel: "Preparing…",
		message: `Preparing reinstall ${nodeId}…`,
	};
}

function customNodeListError(
	state: WorkerCustomNodeSyncState,
	targetNodes: WorkerCustomNodeTargetState[],
	error: string | null,
): string | null {
	if (error !== null) return error;
	if (state.status === "unavailable") return state.error;
	if (state.status !== "failed") return null;
	if ("reinstallNodeId" in state && state.reinstallNodeId !== undefined) {
		return `${state.error} Open Worker logs for details.`;
	}
	const failedNodes = targetNodes.filter(
		(node) => node.status === "failed" || node.status === "version-mismatch",
	);
	if (failedNodes.length === 0) return state.error;
	const names = failedNodes.map((node) => node.id);
	const subject =
		names.length === 1
			? names[0]
			: names.length === 2
				? `${names[0]} and ${names[1]}`
				: `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
	return `${state.error} Affected: ${subject}. Open Worker logs for details.`;
}

function WorkerNodeInventory({
	nodes,
	emptyLabel,
	suffix,
}: {
	nodes: CustomNodeInventoryEntry[] | null;
	emptyLabel?: string;
	suffix: string;
}): React.JSX.Element {
	const summary =
		nodes === null
			? "Active Worker node inventory unknown"
			: nodes.length === 0 && emptyLabel !== undefined
				? emptyLabel
				: `${nodes.length} active Worker ${nodes.length === 1 ? "node" : "nodes"} ${suffix}`;
	return (
		<div className="grid gap-1 text-xs text-muted-foreground" role="status">
			<p>{summary}</p>
			{nodes !== null && nodes.length > 0 ? (
				<ul className="grid max-h-32 gap-0.5 overflow-y-auto break-all font-mono text-[11px]">
					{nodes.map((node) => (
						<li key={node.name}>
							{node.repository ?? node.managerId ?? node.name}@
							{node.version ?? "unknown"}
							{node.managerId !== null && node.managerId !== node.name
								? ` (${node.name})`
								: null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
