import { isNonNegativeInteger, isRecord, isSha256 } from "./validation";

const COMFY_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

type WorkerRuntimeVersions = {
	pythonVersion: string;
	torchVersion: string;
	torchvisionVersion: string;
	torchaudioVersion: string;
	uvVersion: string;
};

export type WorkerRuntime = WorkerRuntimeVersions &
	(
		| { computeBackend?: "cuda"; cudaVersion: string }
		| { computeBackend: "cpu"; cudaVersion: null }
	);

export type BackendTarget = {
	version: string;
	archiveUrl: string;
	sha256: string;
};

export type BackendPhase = "download" | "verify" | "extract";

type BackendStableState =
	| { status: "not-installed"; runtime: WorkerRuntime }
	| { status: "ready"; version: string; runtime: WorkerRuntime }
	| {
			status: "failed";
			targetVersion: string;
			error: string;
			retryable: boolean;
			runtime: WorkerRuntime;
	  };

export type BackendState =
	| BackendStableState
	| {
			status: "preparing";
			targetVersion: string;
			phase: BackendPhase;
			progress: number;
			phaseElapsedMs: number;
			totalElapsedMs: number;
			runtime: WorkerRuntime;
	  };

export type BackendServerState = BackendState;

export type BackendTargetIssue = "target" | "version" | "archive-url" | "checksum";

export function backendTargetIssue(value: unknown): BackendTargetIssue | null {
	if (!isRecord(value)) return "target";
	if (typeof value.version !== "string" || !COMFY_VERSION_PATTERN.test(value.version)) {
		return "version";
	}
	const expectedUrl = `https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v${value.version}.zip`;
	if (value.archiveUrl !== expectedUrl) return "archive-url";
	return isSha256(value.sha256) ? null : "checksum";
}

export function parseBackendTarget(value: unknown): BackendTarget | null {
	if (backendTargetIssue(value) !== null || !isRecord(value)) return null;
	return {
		version: value.version as string,
		archiveUrl: value.archiveUrl as string,
		sha256: value.sha256 as string,
	};
}

export function parseBackendServerState(value: unknown): BackendServerState | null {
	if (!isRecord(value) || !isWorkerRuntime(value.runtime)) return null;
	if (value.status === "not-installed") {
		return { status: "not-installed", runtime: value.runtime };
	}
	if (value.status === "ready") {
		return typeof value.version === "string"
			? { status: "ready", version: value.version, runtime: value.runtime }
			: null;
	}
	if (value.status === "failed") {
		if (
			typeof value.targetVersion !== "string" ||
			typeof value.error !== "string" ||
			typeof value.retryable !== "boolean"
		) {
			return null;
		}
		return {
			status: "failed",
			targetVersion: value.targetVersion,
			error: value.error,
			retryable: value.retryable,
			runtime: value.runtime,
		};
	}
	if (
		value.status !== "preparing" ||
		typeof value.targetVersion !== "string" ||
		(value.phase !== "download" &&
			value.phase !== "verify" &&
			value.phase !== "extract") ||
		!isNonNegativeInteger(value.progress) ||
		value.progress > 100 ||
		!isNonNegativeInteger(value.phaseElapsedMs) ||
		!isNonNegativeInteger(value.totalElapsedMs)
	) {
		return null;
	}
	return {
		status: "preparing",
		targetVersion: value.targetVersion,
		phase: value.phase,
		progress: value.progress,
		phaseElapsedMs: value.phaseElapsedMs,
		totalElapsedMs: value.totalElapsedMs,
		runtime: value.runtime,
	};
}

export function isBackendServerState(value: unknown): value is BackendServerState {
	return parseBackendServerState(value) !== null;
}

export function isWorkerRuntime(value: unknown): value is WorkerRuntime {
	return (
		isRecord(value) &&
		((value.computeBackend === "cpu" && value.cudaVersion === null) ||
			((value.computeBackend === undefined || value.computeBackend === "cuda") &&
				typeof value.cudaVersion === "string")) &&
		typeof value.pythonVersion === "string" &&
		typeof value.torchVersion === "string" &&
		typeof value.torchvisionVersion === "string" &&
		typeof value.torchaudioVersion === "string" &&
		typeof value.uvVersion === "string"
	);
}

export function isComfyVersion(value: unknown): value is string {
	return typeof value === "string" && COMFY_VERSION_PATTERN.test(value);
}
