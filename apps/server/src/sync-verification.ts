import {
	type BackendVerification,
	type CollectionVerification,
	parseSyncVerificationRequest,
	type SyncVerification,
	type VerificationProblem,
	type VerificationStatus,
} from "@kastard/common";
import type { BackendProvisionerApi, BackendState } from "./backend-provisioner";
import type { CustomNodeProvisionerApi } from "./custom-node-provisioner";
import type { ModelProvisionerApi } from "./model-provisioner";

export type {
	BackendVerification,
	CollectionVerification,
	SyncVerification,
	VerificationProblem,
	VerificationStatus,
} from "@kastard/common";

export class SyncVerificationError extends Error {}

export async function verifySynchronization(
	value: unknown,
	backend: BackendProvisionerApi,
	customNodes: CustomNodeProvisionerApi,
	models: ModelProvisionerApi,
): Promise<SyncVerification> {
	const request = parseSyncVerificationRequest(value);
	if (request === null) {
		throw new SyncVerificationError("Invalid synchronization verification request.");
	}
	const backendResult = verifyBackend(request.backendVersion, backend.getState());
	const [modelResult, customNodeResult] = await Promise.all([
		models.verify({ models: request.models }),
		customNodes.verify({
			managerVersion: request.customNodes.managerVersion,
			nodes: request.customNodes.nodes,
		}),
	]);
	const mergedCustomNodes = addUnsupportedNodes(
		customNodeResult,
		request.customNodes.unsupportedNodes,
	);
	return {
		status: overallStatus(backendResult, modelResult, mergedCustomNodes),
		backend: backendResult,
		models: modelResult,
		customNodes: mergedCustomNodes,
	};
}

function verifyBackend(
	expectedVersion: string,
	state: BackendState,
): BackendVerification {
	if (state.status === "preparing") {
		return {
			status: "syncing",
			expectedVersion,
			actualVersion: state.targetVersion,
		};
	}
	if (state.status === "not-installed") {
		return {
			status: "out-of-sync",
			expectedVersion,
			actualVersion: null,
			reason: "not-installed",
		};
	}
	if (state.status === "failed") {
		return {
			status: "out-of-sync",
			expectedVersion,
			actualVersion: state.targetVersion,
			reason: "failed",
			error: state.error,
		};
	}
	return state.version === expectedVersion
		? {
				status: "synced",
				expectedVersion,
				actualVersion: state.version,
			}
		: {
				status: "out-of-sync",
				expectedVersion,
				actualVersion: state.version,
				reason: "version-mismatch",
			};
}

function addUnsupportedNodes(
	result: CollectionVerification,
	unsupportedNodes: string[],
): CollectionVerification {
	if (unsupportedNodes.length === 0 || result.status === "syncing") return result;
	if (result.status === "unavailable") return result;
	const problems = unsupportedNodes.map(
		(name): VerificationProblem => ({
			reason: "unsupported",
			name,
			expected: "Manager-compatible package",
			actual: "Unsupported local package",
		}),
	);
	return result.status === "synced"
		? { status: "out-of-sync", total: result.total + unsupportedNodes.length, problems }
		: {
				...result,
				total: result.total + unsupportedNodes.length,
				problems: [...result.problems, ...problems],
			};
}

function overallStatus(
	...results: Array<{ status: VerificationStatus }>
): VerificationStatus {
	if (results.some((result) => result.status === "syncing")) return "syncing";
	if (results.some((result) => result.status === "unavailable")) return "unavailable";
	return results.every((result) => result.status === "synced")
		? "synced"
		: "out-of-sync";
}
