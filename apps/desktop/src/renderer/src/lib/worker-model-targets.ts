import type {
	CollectionVerification,
	VerificationProblem,
	WorkerModelSyncState,
	WorkerModelTargetState,
} from "../../../shared/api";

export function verifiedModelTargets(
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
		if (model.status === "failed") return model;
		if (problems.some((problem) => problem.reason === "missing")) {
			return { ...model, status: "not-downloaded", downloadedBytes: 0 };
		}
		return { ...model, status: "needs-redownload", downloadedBytes: 0 };
	});
}
