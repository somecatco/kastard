import {
	backendMatchesEditorComfy,
	phaseLabel,
	type SyncAreaSummary,
	type SynchronizationState,
	workerComfyWarnings,
} from "@/lib/worker-synchronization";
export function backendPresentation(
	input: Pick<
		SynchronizationState,
		| "backendAction"
		| "backendError"
		| "backendState"
		| "comfyRestartError"
		| "comfyRestartAction"
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
	const backendVerification = input.verification?.backend;
	const backendPrepared =
		backendVerification === undefined
			? backendMatchesEditorComfy(input)
			: backendVerification.status === "synced";
	const backendSyncing =
		verificationRunning ||
		input.backendAction ||
		input.backendState.status === "loading" ||
		input.backendState.status === "preparing";
	const backendError =
		input.backendError !== null ||
		input.backendState.status === "failed" ||
		input.backendState.status === "unavailable" ||
		backendVerification?.status === "out-of-sync" ||
		backendVerification?.status === "unavailable";
	const workerComfyReady =
		backendPrepared &&
		input.workerComfyState.status === "ready" &&
		input.comfyRestartAction === false &&
		setupPhase !== "comfy";
	const workerComfySyncing =
		backendPrepared &&
		(input.comfyRestartAction ||
			setupPhase === "comfy" ||
			input.workerComfyState.status === "loading" ||
			input.workerComfyState.status === "starting");
	const workerComfyError =
		backendPrepared &&
		(input.workerComfyState.status === "failed" ||
			input.workerComfyState.status === "unavailable");
	const workerComfyWarning =
		workerComfyReady && workerComfyWarnings(input.workerComfyState).length > 0;
	return {
		content: comfyBackendStatusContent(input),
		summary: {
			id: "backend",
			label: "Backend",
			fullLabel: "ComfyUI Backend",
			shortLabel: "B",
			status:
				backendSyncing || workerComfySyncing
					? "syncing"
					: backendError || workerComfyError
						? "error"
						: workerComfyWarning
							? "warning"
							: workerComfyReady
								? "synced"
								: "pending",
			completed: backendPrepared ? (workerComfyReady ? 2 : 1) : 0,
			total: 2,
		} satisfies SyncAreaSummary,
	};
}

export type ComfyBackendStatusContent = {
	message: string;
	detail: string | null;
	tone: "success" | "warning" | "muted" | "error";
};
function comfyBackendStatusContent(
	input: Pick<
		SynchronizationState,
		| "backendState"
		| "workerComfyState"
		| "backendAction"
		| "backendError"
		| "comfyRestartAction"
		| "comfyRestartError"
		| "setupState"
	>,
): ComfyBackendStatusContent {
	const backendState = input.backendState;
	const comfyState = input.workerComfyState;
	if (input.backendError !== null) {
		return { message: input.backendError, detail: null, tone: "error" };
	}
	if (backendState.status === "disconnected" || backendState.status === "loading") {
		return { message: "Loading Worker status…", detail: null, tone: "muted" };
	}
	if (input.backendAction) {
		return { message: "Preparing ComfyUI…", detail: null, tone: "muted" };
	}
	if (backendState.status === "not-installed") {
		return { message: "Not installed on Worker", detail: null, tone: "muted" };
	}
	if (backendState.status === "preparing") {
		return { message: phaseLabel(backendState.phase), detail: null, tone: "muted" };
	}
	if (backendState.status === "failed" || backendState.status === "unavailable") {
		return { message: backendState.error, detail: null, tone: "error" };
	}
	if (backendState.version !== backendState.editorComfyVersion) {
		return {
			message: "Update required",
			detail: "Run Sync from Connected to install the required version.",
			tone: "warning",
		};
	}
	if (input.comfyRestartError !== null) {
		return { message: input.comfyRestartError, detail: null, tone: "error" };
	}
	if (
		input.comfyRestartAction ||
		comfyState.status === "starting" ||
		(input.setupState.status === "running" && input.setupState.phase === "comfy")
	) {
		return { message: "Starting Worker ComfyUI…", detail: null, tone: "muted" };
	}
	if (comfyState.status === "disconnected" || comfyState.status === "loading") {
		return { message: "Loading execution status…", detail: null, tone: "muted" };
	}
	if (comfyState.status === "stopped") {
		return { message: "Downloaded · Waiting to start", detail: null, tone: "muted" };
	}
	if (comfyState.status === "ready") {
		if (workerComfyWarnings(comfyState).length > 0) {
			return {
				message: "Running with custom node warnings",
				detail: null,
				tone: "success",
			};
		}
		return { message: "Running", detail: null, tone: "success" };
	}
	return {
		message: comfyState.error,
		detail:
			comfyState.status === "failed"
				? "Worker logs include ComfyUI output from this connection."
				: null,
		tone: "error",
	};
}
