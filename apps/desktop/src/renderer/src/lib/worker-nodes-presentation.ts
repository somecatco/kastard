import { verifiedCustomNodeTargets } from "@/lib/worker-custom-node-targets";
import {
	collectionVerificationProgress,
	type SyncAreaSummary,
	type SynchronizationState,
} from "@/lib/worker-synchronization";
import type {
	WorkerBackendState,
	WorkerCustomNodeSyncState,
} from "../../../shared/api";
export function nodesPresentation(
	input: Pick<
		SynchronizationState,
		| "preparingReinstallNodeId"
		| "setupState"
		| "syncAction"
		| "syncCancelAction"
		| "syncError"
		| "syncState"
		| "verification"
		| "verificationAction"
		| "workerComfyState"
	>,
) {
	const setupPhase =
		input.setupState.status === "running" ? input.setupState.phase : null;
	const verificationRunning =
		input.verificationAction ||
		setupPhase === "verification" ||
		input.verification?.status === "syncing";
	const synchronizationProblemStatus =
		input.workerComfyState.status === "ready" ? "warning" : "error";
	const nodesVerification = input.verification?.customNodes;
	const targetNodes =
		"targetNodes" in input.syncState ? input.syncState.targetNodes : undefined;
	const currentTargetNodes =
		targetNodes !== undefined &&
		"targetStatus" in input.syncState &&
		input.syncState.targetStatus === "current"
			? targetNodes
			: null;
	const verifiedTargetNodes =
		currentTargetNodes === null
			? null
			: verifiedCustomNodeTargets(currentTargetNodes, nodesVerification);
	const unsupportedNodeCount =
		"unsupportedNodes" in input.syncState ? input.syncState.unsupportedNodes.length : 0;
	const targets =
		currentTargetNodes === null ? targetNodes : (verifiedTargetNodes ?? targetNodes);
	let nodesProgress =
		targets === undefined
			? collectionVerificationProgress(nodesVerification)
			: {
					completed: targets.filter((node) => node.status === "installed").length,
					total: targets.length + unsupportedNodeCount,
				};
	if (nodesProgress === null) {
		if (input.syncState.status === "syncing")
			nodesProgress = {
				completed: input.syncState.current,
				total: input.syncState.total + unsupportedNodeCount,
			};
		else if (input.syncState.status === "ready")
			nodesProgress = {
				completed: input.syncState.nodes.length,
				total: input.syncState.nodes.length + unsupportedNodeCount,
			};
		else nodesProgress = { completed: 0, total: 0 };
	}
	const nodesSyncing =
		verificationRunning ||
		input.syncAction ||
		input.preparingReinstallNodeId !== null ||
		input.syncCancelAction ||
		input.syncState.status === "loading" ||
		input.syncState.status === "syncing" ||
		input.syncState.status === "canceling" ||
		nodesVerification?.status === "syncing";
	const nodesError =
		input.syncError !== null ||
		input.syncState.status === "failed" ||
		input.syncState.status === "canceled" ||
		input.syncState.status === "unavailable" ||
		("unsupportedNodes" in input.syncState &&
			input.syncState.unsupportedNodes.length > 0) ||
		nodesVerification?.status === "out-of-sync" ||
		nodesVerification?.status === "unavailable";
	const nodesSynced =
		nodesVerification?.status === "synced" ||
		(input.syncState.status === "ready" &&
			input.syncState.unsupportedNodes.length === 0);

	return {
		summary: {
			id: "nodes",
			label: "Nodes",
			fullLabel: "Custom Nodes",
			shortLabel: "N",
			status: nodesSyncing
				? "syncing"
				: nodesError
					? synchronizationProblemStatus
					: nodesSynced
						? "synced"
						: "pending",
			...nodesProgress,
		} satisfies SyncAreaSummary,
		targets,
	};
}

export function nodesActions({
	state,
	backendState,
	disabled,
	starting,
	preparingReinstallNodeId,
	preparingRemovalNodeName,
	canceling,
}: {
	state: WorkerCustomNodeSyncState;
	backendState: WorkerBackendState;
	disabled: boolean;
	starting: boolean;
	preparingReinstallNodeId: string | null;
	preparingRemovalNodeName: string | null;
	canceling: boolean;
}) {
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

	return { backendMatches, unsupportedNodes, canStart, canForceReinstall, canRemove };
}
