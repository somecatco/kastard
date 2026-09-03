import { isComfyVersion } from "./backend";
import type { CustomNodeSyncRequest } from "./custom-nodes";
import type { ModelSyncTarget } from "./model-sync";
import { isNonNegativeInteger, isRecord } from "./validation";

export type VerificationStatus = "synced" | "out-of-sync" | "syncing" | "unavailable";

export type VerificationProblem = {
	reason:
		| "missing"
		| "conflict"
		| "stale"
		| "unexpected"
		| "unsupported"
		| "version-mismatch";
	name: string;
	expected: string | null;
	actual: string | null;
};

export type CollectionVerification =
	| { status: "synced"; total: number }
	| {
			status: "out-of-sync";
			total: number;
			problems: VerificationProblem[];
	  }
	| { status: "syncing" }
	| { status: "unavailable"; error: string };

export type BackendVerification =
	| { status: "synced"; expectedVersion: string; actualVersion: string }
	| {
			status: "out-of-sync";
			expectedVersion: string;
			actualVersion: string | null;
			reason: "not-installed" | "version-mismatch" | "failed";
			error?: string;
	  }
	| { status: "syncing"; expectedVersion: string; actualVersion: string }
	| { status: "unavailable"; expectedVersion: string; error: string };

export type SyncVerificationRequest = {
	backendVersion: string;
	models: ModelSyncTarget[];
	customNodes: CustomNodeSyncRequest & { unsupportedNodes: string[] };
};

type WorkerSyncVerificationRequest = {
	backendVersion: string;
	models: unknown[];
	customNodes: {
		managerVersion: unknown;
		nodes: unknown[];
		unsupportedNodes: string[];
	};
};

export type SyncVerification = {
	status: VerificationStatus;
	backend: BackendVerification;
	models: CollectionVerification;
	customNodes: CollectionVerification;
};

export function parseSyncVerificationRequest(
	value: unknown,
): WorkerSyncVerificationRequest | null {
	if (
		!isRecord(value) ||
		!isComfyVersion(value.backendVersion) ||
		!Array.isArray(value.models) ||
		!isRecord(value.customNodes) ||
		!Array.isArray(value.customNodes.nodes) ||
		!Array.isArray(value.customNodes.unsupportedNodes)
	) {
		return null;
	}
	if (!value.customNodes.unsupportedNodes.every(isUnsupportedNodeName)) {
		return null;
	}
	return {
		backendVersion: value.backendVersion,
		models: value.models,
		customNodes: {
			managerVersion: value.customNodes.managerVersion,
			nodes: value.customNodes.nodes,
			unsupportedNodes: [...new Set(value.customNodes.unsupportedNodes)],
		},
	};
}

export function parseSyncVerification(value: unknown): SyncVerification | null {
	return isRecord(value) &&
		isVerificationStatus(value.status) &&
		isBackendVerification(value.backend) &&
		isCollectionVerification(value.models) &&
		isCollectionVerification(value.customNodes)
		? (value as SyncVerification)
		: null;
}

export function isSyncVerification(value: unknown): value is SyncVerification {
	return parseSyncVerification(value) !== null;
}

function isBackendVerification(value: unknown): value is BackendVerification {
	if (
		!isRecord(value) ||
		!isVerificationStatus(value.status) ||
		typeof value.expectedVersion !== "string"
	) {
		return false;
	}
	if (value.status === "unavailable") return typeof value.error === "string";
	if (typeof value.actualVersion !== "string" && value.actualVersion !== null) {
		return false;
	}
	if (value.status === "synced" || value.status === "syncing") {
		return typeof value.actualVersion === "string";
	}
	return (
		(value.reason === "not-installed" ||
			value.reason === "version-mismatch" ||
			value.reason === "failed") &&
		(value.error === undefined || typeof value.error === "string")
	);
}

function isCollectionVerification(value: unknown): value is CollectionVerification {
	if (!isRecord(value) || !isVerificationStatus(value.status)) return false;
	if (value.status === "syncing") return true;
	if (value.status === "unavailable") return typeof value.error === "string";
	if (!isNonNegativeInteger(value.total)) return false;
	return value.status === "synced"
		? true
		: Array.isArray(value.problems) && value.problems.every(isVerificationProblem);
}

function isVerificationProblem(value: unknown): value is VerificationProblem {
	return (
		isRecord(value) &&
		(value.reason === "missing" ||
			value.reason === "conflict" ||
			value.reason === "stale" ||
			value.reason === "unexpected" ||
			value.reason === "unsupported" ||
			value.reason === "version-mismatch") &&
		typeof value.name === "string" &&
		(typeof value.expected === "string" || value.expected === null) &&
		(typeof value.actual === "string" || value.actual === null)
	);
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
	return (
		value === "synced" ||
		value === "out-of-sync" ||
		value === "syncing" ||
		value === "unavailable"
	);
}

function isUnsupportedNodeName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value
	);
}
