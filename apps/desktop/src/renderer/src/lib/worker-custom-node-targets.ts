import type {
	CollectionVerification,
	VerificationProblem,
	WorkerCustomNodeTargetState,
} from "../../../shared/api";

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
