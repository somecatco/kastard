import { verifiedModelTargets } from "@/lib/worker-model-targets";
import {
	collectionVerificationProgress,
	type SyncAreaSummary,
	type SynchronizationState,
} from "@/lib/worker-synchronization";
import type { WorkerModelSyncState } from "../../../shared/api";
export function modelsPresentation(
	input: Pick<
		SynchronizationState,
		| "modelSyncAction"
		| "modelSyncCancelAction"
		| "modelSyncError"
		| "modelSyncState"
		| "preparingRedownloadPath"
		| "setupState"
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
	const modelsVerification = input.verification?.models;
	const rawTargets =
		"targetModels" in input.modelSyncState
			? input.modelSyncState.targetModels
			: undefined;
	const targets =
		rawTargets === undefined
			? undefined
			: verifiedModelTargets(input.modelSyncState, rawTargets, modelsVerification);
	let modelsProgress =
		targets === undefined
			? collectionVerificationProgress(modelsVerification)
			: {
					completed: targets.filter((model) => model.status === "ready").length,
					total: targets.length,
				};
	if (modelsProgress === null) {
		const state = input.modelSyncState;
		if (state.status === "checking")
			modelsProgress = { completed: 0, total: state.total };
		else if (state.status === "syncing")
			modelsProgress = { completed: state.completed, total: state.total };
		else if (state.status === "synced")
			modelsProgress = { completed: state.models.length, total: state.models.length };
		else if (state.status === "failed" && state.total !== undefined)
			modelsProgress = { completed: state.models.length, total: state.total };
		else modelsProgress = { completed: 0, total: 0 };
	}

	const modelsSyncing =
		verificationRunning ||
		input.modelSyncAction ||
		input.preparingRedownloadPath !== null ||
		input.modelSyncCancelAction ||
		input.modelSyncState.status === "loading" ||
		input.modelSyncState.status === "checking" ||
		input.modelSyncState.status === "syncing" ||
		input.modelSyncState.status === "canceling" ||
		modelsVerification?.status === "syncing";
	const modelsError =
		input.modelSyncError !== null ||
		input.modelSyncState.status === "failed" ||
		input.modelSyncState.status === "canceled" ||
		input.modelSyncState.status === "unavailable" ||
		modelsVerification?.status === "out-of-sync" ||
		modelsVerification?.status === "unavailable";
	const projectedModelsSynced =
		"targetModels" in input.modelSyncState &&
		input.modelSyncState.targetStatus === "current" &&
		input.modelSyncState.targetModels !== undefined &&
		input.modelSyncState.targetModels.length > 0 &&
		input.modelSyncState.targetModels.every((model) => model.status === "ready");
	const modelsSynced =
		modelsVerification?.status === "synced" ||
		projectedModelsSynced ||
		(input.modelSyncState.status === "synced" &&
			(!("operationKind" in input.modelSyncState) ||
				input.modelSyncState.operationKind !== "redownload"));

	return {
		summary: {
			id: "models",
			label: "Models",
			fullLabel: "Models",
			shortLabel: "M",
			status: modelsSyncing
				? "syncing"
				: modelsError
					? synchronizationProblemStatus
					: modelsSynced
						? "synced"
						: "pending",
			...modelsProgress,
		} satisfies SyncAreaSummary,
		targets,
	};
}

export function modelsActions({
	state,
	disabled,
	starting,
	preparingRedownloadPath,
	canceling,
}: {
	state: WorkerModelSyncState;
	disabled: boolean;
	starting: boolean;
	preparingRedownloadPath: string | null;
	canceling: boolean;
}) {
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

	return { canStart, canForceRedownload };
}
