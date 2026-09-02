import { isRecord } from "./validation";

export type WorkerErrorResponse = {
	error: string;
	retryable?: boolean;
};

export type ReleaseChannel = "development" | "preview" | "production";

export type ReleaseIdentity =
	| {
			channel: "development";
			buildNumber: string;
			productVersion: null;
			sourceRevision: null;
	  }
	| {
			channel: "preview";
			buildNumber: string;
			productVersion: null;
			sourceRevision: string;
	  }
	| {
			channel: "production";
			buildNumber: string;
			productVersion: string;
			sourceRevision: string;
	  };

export type WorkerConnectionResponse = {
	status: "connected";
	worker?: ReleaseIdentity;
};

export type WorkerConnectionStartResponse = WorkerConnectionResponse & {
	logCursor: string;
};

export type WorkerComfyServerState =
	| { status: "stopped" }
	| { status: "starting" }
	| { status: "ready"; warnings?: string[] }
	| { status: "failed"; error: string };

export type WorkerComfyMemoryCleanupRequest = {
	unload_models: true;
	free_memory?: true;
};

export function parseWorkerErrorResponse(value: unknown): WorkerErrorResponse | null {
	if (
		!isRecord(value) ||
		typeof value.error !== "string" ||
		(value.retryable !== undefined && typeof value.retryable !== "boolean")
	) {
		return null;
	}
	return {
		error: value.error,
		...(value.retryable === undefined ? {} : { retryable: value.retryable }),
	};
}

export function parseWorkerConnectionResponse(
	value: unknown,
): WorkerConnectionResponse | null {
	if (!isRecord(value) || value.status !== "connected") return null;
	const worker = parseReleaseIdentity(value.worker);
	return {
		status: "connected",
		...(worker === null ? {} : { worker }),
	};
}

export function parseWorkerConnectionStartResponse(
	value: unknown,
): WorkerConnectionStartResponse | null {
	const connection = parseWorkerConnectionResponse(value);
	return connection !== null && isRecord(value) && typeof value.logCursor === "string"
		? { ...connection, logCursor: value.logCursor }
		: null;
}

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
	return value === "development" || value === "preview" || value === "production";
}

export function parseReleaseIdentity(value: unknown): ReleaseIdentity | null {
	if (
		!isRecord(value) ||
		typeof value.buildNumber !== "string" ||
		!/^[1-9]\d*$/.test(value.buildNumber) ||
		!Number.isSafeInteger(Number(value.buildNumber)) ||
		!isReleaseChannel(value.channel)
	) {
		return null;
	}

	const { buildNumber, channel, productVersion, sourceRevision } = value;
	if (channel === "development") {
		return productVersion === null && sourceRevision === null
			? { buildNumber, channel, productVersion, sourceRevision }
			: null;
	}
	if (typeof sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(sourceRevision)) {
		return null;
	}
	if (channel === "preview") {
		return productVersion === null
			? { buildNumber, channel, productVersion, sourceRevision }
			: null;
	}
	return typeof productVersion === "string" && /^\d+\.\d+\.\d+$/.test(productVersion)
		? { buildNumber, channel, productVersion, sourceRevision }
		: null;
}

export function parseWorkerComfyServerState(
	value: unknown,
): WorkerComfyServerState | null {
	if (!isRecord(value)) return null;
	if (value.status === "stopped" || value.status === "starting") {
		return { status: value.status };
	}
	if (value.status === "ready") {
		if (value.warnings === undefined) return { status: "ready" };
		if (
			!Array.isArray(value.warnings) ||
			!value.warnings.every(
				(warning) => typeof warning === "string" && warning.length > 0,
			)
		) {
			return null;
		}
		return { status: "ready", warnings: [...value.warnings] };
	}
	return value.status === "failed" && typeof value.error === "string"
		? { status: "failed", error: value.error }
		: null;
}

export function isWorkerComfyServerState(
	value: unknown,
): value is WorkerComfyServerState {
	return parseWorkerComfyServerState(value) !== null;
}

export function parseWorkerComfyMemoryCleanupRequest(
	value: unknown,
): WorkerComfyMemoryCleanupRequest | null {
	if (!isRecord(value) || value.unload_models !== true) return null;
	if (value.free_memory !== undefined && typeof value.free_memory !== "boolean") {
		return null;
	}
	return value.free_memory === true
		? { unload_models: true, free_memory: true }
		: { unload_models: true };
}
