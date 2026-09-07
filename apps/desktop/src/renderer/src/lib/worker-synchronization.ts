import type {
	BackendVerification,
	CollectionVerification,
	ConnectionState,
	SyncVerification,
	VerificationProblem,
	WorkerBackendState,
	WorkerComfyState,
	WorkerCustomNodeSyncState,
	WorkerModelSyncState,
	WorkerSetupState,
	WorkerWorkflowCurrentState,
} from "../../../shared/api";
export type SynchronizationState = {
	state: ConnectionState;
	workflow: WorkerWorkflowCurrentState | null;
	setupState: WorkerSetupState;
	backendState: WorkerBackendState;
	backendAction: boolean;
	backendError: string | null;
	workerComfyState: WorkerComfyState;
	comfyRestartAction: boolean;
	comfyRestartError: string | null;
	syncState: WorkerCustomNodeSyncState;
	syncAction: boolean;
	preparingReinstallNodeId: string | null;
	preparingRemovalNodeName: string | null;
	syncCancelAction: boolean;
	syncError: string | null;
	modelSyncState: WorkerModelSyncState;
	modelSyncAction: boolean;
	preparingRedownloadPath: string | null;
	modelSyncCancelAction: boolean;
	modelSyncError: string | null;
	verification: SyncVerification | null;
	verificationAction: boolean;
	verificationError: string | null;
	setupCancelAction: boolean;
	setupStartAction: boolean;
};
export type SyncAreaStatus = "pending" | "syncing" | "synced" | "warning" | "error";
export type SyncAreaId = "backend" | "nodes" | "models";
export type SyncAreaSummary = {
	id: SyncAreaId;
	label: "Backend" | "Nodes" | "Models";
	fullLabel: "ComfyUI Backend" | "Custom Nodes" | "Models";
	shortLabel: "B" | "N" | "M";
	status: SyncAreaStatus;
	completed: number;
	total: number;
};

type SynchronizationProgressState = Pick<
	SynchronizationState,
	| "setupStartAction"
	| "backendAction"
	| "backendState"
	| "modelSyncAction"
	| "modelSyncCancelAction"
	| "modelSyncState"
	| "preparingRedownloadPath"
	| "setupState"
	| "syncAction"
	| "syncCancelAction"
	| "syncState"
	| "verification"
	| "verificationAction"
>;

type SynchronizationBusyState = SynchronizationProgressState &
	Pick<SynchronizationState, "comfyRestartAction">;

export function isSynchronizationProgressActive(
	input: SynchronizationProgressState,
): boolean {
	return (
		input.setupState.status === "running" ||
		input.setupStartAction ||
		input.backendAction ||
		input.backendState.status === "loading" ||
		input.backendState.status === "preparing" ||
		input.syncAction ||
		input.syncCancelAction ||
		input.syncState.status === "loading" ||
		input.syncState.status === "syncing" ||
		input.syncState.status === "canceling" ||
		input.modelSyncAction ||
		input.preparingRedownloadPath !== null ||
		input.modelSyncCancelAction ||
		input.modelSyncState.status === "loading" ||
		input.modelSyncState.status === "checking" ||
		input.modelSyncState.status === "syncing" ||
		input.modelSyncState.status === "canceling" ||
		input.verificationAction ||
		input.verification?.status === "syncing"
	);
}

export function isSynchronizationBusy(input: SynchronizationBusyState): boolean {
	return input.comfyRestartAction || isSynchronizationProgressActive(input);
}

export function canStartWorkerSetup(
	input: SynchronizationBusyState & Pick<SynchronizationState, "workerComfyState">,
): boolean {
	const state = input.workerComfyState;
	return (
		!isSynchronizationBusy(input) &&
		(state.status === "ready" ||
			state.status === "stopped" ||
			state.status === "failed" ||
			(state.status === "unavailable" && state.retryable !== true))
	);
}

export function canRestartWorkerComfy(
	input: SynchronizationBusyState &
		Pick<SynchronizationState, "state" | "workerComfyState" | "workflow">,
): boolean {
	const state = input.workerComfyState;
	return (
		input.state.status === "connected" &&
		input.workflow === null &&
		input.backendState.status === "ready" &&
		!isSynchronizationBusy(input) &&
		state.status !== "disconnected" &&
		state.status !== "loading" &&
		state.status !== "starting" &&
		state.status !== "unavailable"
	);
}

export function setupSynchronizationActive(
	input: Pick<SynchronizationState, "modelSyncState" | "setupState" | "syncState">,
): boolean {
	return (
		input.setupState.status === "running" &&
		input.setupState.phase === "preparation" &&
		(input.syncState.status === "loading" ||
			input.syncState.status === "syncing" ||
			input.modelSyncState.status === "loading" ||
			input.modelSyncState.status === "checking" ||
			input.modelSyncState.status === "syncing")
	);
}

export function setupSynchronizationCanceling(
	input: Pick<
		SynchronizationState,
		| "modelSyncCancelAction"
		| "modelSyncState"
		| "setupCancelAction"
		| "setupState"
		| "syncCancelAction"
		| "syncState"
	>,
): boolean {
	if (input.setupCancelAction) return true;
	if (input.setupState.status !== "running" && input.setupState.status !== "canceled") {
		return false;
	}

	return (
		input.syncCancelAction ||
		input.modelSyncCancelAction ||
		input.syncState.status === "canceling" ||
		input.modelSyncState.status === "canceling"
	);
}

export function backendMatchesEditorComfy(
	input: Pick<SynchronizationState, "backendState">,
): boolean {
	return (
		input.backendState.status === "ready" &&
		input.backendState.version === input.backendState.editorComfyVersion
	);
}

export function collectionVerificationProgress(
	verification: CollectionVerification | undefined,
): Pick<SyncAreaSummary, "completed" | "total"> | null {
	if (verification?.status === "synced") {
		return { completed: verification.total, total: verification.total };
	}
	if (verification?.status !== "out-of-sync") return null;
	const problemTargets = new Set(
		verification.problems
			.filter((problem) => problem.expected !== null)
			.map((problem) => problem.name),
	);
	return {
		completed: Math.max(verification.total - problemTargets.size, 0),
		total: verification.total,
	};
}

export function workerComfyWarnings(state: WorkerComfyState): string[] {
	return state.status === "ready" ? (state.warnings ?? []) : [];
}

export function synchronizationStatusMessage(
	input: SynchronizationProgressState & Pick<SynchronizationState, "setupCancelAction">,
): string {
	if (setupSynchronizationCanceling(input)) {
		return "Canceling synchronization…";
	}
	if (input.verificationAction) return "Checking synchronization status…";
	if (input.setupState.status === "running") {
		return {
			preparation: "Synchronization in progress…",
			verification: "Checking synchronization status…",
			comfy: "Synchronization verified. Starting Worker ComfyUI…",
		}[input.setupState.phase];
	}
	if (isSynchronizationProgressActive(input)) {
		if (
			input.syncCancelAction ||
			input.modelSyncCancelAction ||
			input.syncState.status === "canceling" ||
			input.modelSyncState.status === "canceling"
		) {
			return "Canceling synchronization…";
		}
		if (input.verificationAction || input.verification?.status === "syncing") {
			return "Checking synchronization status…";
		}
		return "Synchronization in progress…";
	}
	if (input.setupState.status === "canceled") {
		return "Synchronization was canceled.";
	}
	if (input.verification !== null) {
		return verificationSummary(input.verification.status);
	}
	return "Synchronization status has not been checked.";
}

export function synchronizationProblems(
	input: Pick<
		SynchronizationState,
		| "backendError"
		| "backendState"
		| "modelSyncError"
		| "modelSyncState"
		| "setupState"
		| "syncError"
		| "syncState"
		| "verification"
		| "verificationError"
	>,
): string[] {
	const problems = new Set<string>();
	for (const error of [
		input.verificationError,
		input.backendError,
		input.syncError,
		input.modelSyncError,
	]) {
		if (error !== null) problems.add(error);
	}

	if (
		input.backendState.status === "failed" ||
		input.backendState.status === "unavailable"
	) {
		problems.add(input.backendState.error);
	}
	if (input.syncState.status === "failed" || input.syncState.status === "unavailable") {
		problems.add(input.syncState.error);
	}
	if (
		input.modelSyncState.status === "failed" ||
		input.modelSyncState.status === "unavailable"
	) {
		problems.add(input.modelSyncState.error);
	}
	const verification = input.verification;
	if (verification !== null) {
		const backendError = backendVerificationError(verification.backend);
		if (backendError !== null) problems.add(backendError);
		for (const collection of [verification.models, verification.customNodes]) {
			if (collection.status === "unavailable") problems.add(collection.error);
			if (collection.status === "out-of-sync") {
				for (const problem of collection.problems) {
					problems.add(verificationProblemLabel(problem));
				}
			}
		}
		if (verification.status === "out-of-sync" && problems.size === 0) {
			problems.add("Worker synchronization is out of date.");
		}
		if (verification.status === "unavailable" && problems.size === 0) {
			problems.add("The full synchronization state could not be verified.");
		}
	}

	if (input.setupState.status === "failed") {
		problems.add(input.setupState.error);
	}
	return [...problems];
}

function backendVerificationError(verification: BackendVerification): string | null {
	if (verification.status === "synced" || verification.status === "syncing")
		return null;
	if (verification.status === "unavailable") return verification.error;
	if (verification.reason === "not-installed")
		return "Backend is not installed on Worker.";
	if (verification.reason === "failed") {
		return verification.error ?? "Backend preparation failed.";
	}
	return `Expected backend v${verification.expectedVersion}, found v${verification.actualVersion}.`;
}

function verificationSummary(status: SyncVerification["status"]): string {
	return {
		synced: "Backend, models, and custom nodes are synchronized.",
		"out-of-sync": "Worker synchronization is out of date.",
		syncing: "Synchronization is still in progress.",
		unavailable: "The full synchronization state could not be verified.",
	}[status];
}

function verificationProblemLabel(problem: VerificationProblem): string {
	const reason = {
		missing: "Missing",
		conflict: "Conflict",
		stale: "Stale",
		unexpected: "Unexpected",
		unsupported: "Unsupported",
		"version-mismatch": "Version mismatch",
	}[problem.reason];
	const comparison =
		problem.expected === null && problem.actual === null
			? ""
			: ` · expected ${problem.expected ?? "none"}, found ${problem.actual ?? "none"}`;
	return `${reason}: ${problem.name}${comparison}`;
}

export function phaseLabel(
	phase: "download" | "verify" | "extract" | "validate",
): string {
	return {
		download: "Downloading",
		verify: "Verifying",
		extract: "Extracting",
		validate: "Validating",
	}[phase];
}
