import { isBoundedString, isNonNegativeInteger, isRecord } from "./validation";

const MAX_MODELS = 250;
const MODEL_EXTENSIONS = [
	".bin",
	".ckpt",
	".gguf",
	".onnx",
	".pt",
	".pth",
	".safetensors",
	".sft",
] as const;

export type ModelProvider = "huggingface" | "civitai";

export type ModelArtifact = {
	provider: ModelProvider;
	modelId: string;
	versionId: string;
	versionLabel: string;
	fileId: string;
	fileName: string;
	sizeBytes: number;
};

export type ModelSyncTarget = {
	name: string;
	path: string;
	artifact: ModelArtifact;
};

export type ModelSyncCredentials = Partial<Record<ModelProvider, string>>;

export type ModelSyncRequest = {
	models: ModelSyncTarget[];
	credentials: ModelSyncCredentials;
};

export type ModelSyncSelection = Pick<ModelSyncRequest, "models">;

export const MODEL_SYNC_CONTRACT_VERSION = 2 as const;

export type ModelSyncCapabilities = {
	forceRedownload?: boolean;
};

export type ModelSyncOperationKind = "sync" | "redownload";

export type ModelSyncFileStatus =
	| "ready"
	| "downloading"
	| "not-downloaded"
	| "failed"
	| "needs-redownload";

export type ModelSyncFileState = {
	path: string;
	status: ModelSyncFileStatus;
	downloadedBytes: number;
	error?: string;
};

export type ModelSyncSnapshot = {
	models: ModelSyncFileState[];
};

type ModelSyncCapabilitiesField = {
	capabilities?: ModelSyncCapabilities;
};

type ModelSyncSnapshotField = {
	modelSnapshot?: ModelSyncSnapshot;
};

type ModelSyncOperation = {
	contractVersion: typeof MODEL_SYNC_CONTRACT_VERSION;
	target: ModelSyncSelection;
	operationId: string;
	operationKind: ModelSyncOperationKind;
} & ModelSyncCapabilitiesField &
	ModelSyncSnapshotField;

export type ModelSyncState =
	| ({
			contractVersion: typeof MODEL_SYNC_CONTRACT_VERSION;
			target: ModelSyncSelection | null;
			operationId: null;
			operationKind?: undefined;
			status: "idle";
			models: ModelSyncTarget[] | null;
	  } & ModelSyncCapabilitiesField &
			ModelSyncSnapshotField)
	| (ModelSyncOperation & {
			status: "checking";
			total: number;
			totalBytes: number;
	  })
	| (ModelSyncOperation & {
			status: "syncing";
			completed: number;
			total: number;
			completedBytes: number;
			totalBytes: number;
			present: number;
			active: string[];
	  })
	| (ModelSyncOperation & { status: "canceling" })
	| (ModelSyncOperation & {
			status: "canceled";
			models: ModelSyncTarget[];
	  })
	| (ModelSyncOperation & { status: "synced"; models: ModelSyncTarget[] })
	| (ModelSyncOperation & {
			status: "failed";
			models: ModelSyncTarget[];
			total?: number;
			error: string;
	  });

export type ModelSyncServerState = ModelSyncState;

export type ModelSyncParseIssue =
	| "request"
	| "credential"
	| "selection"
	| "duplicate-path"
	| "target"
	| "civitai-target"
	| "huggingface-target";

export type ModelSyncParseResult<Value> =
	| { ok: true; value: Value }
	| { ok: false; issue: ModelSyncParseIssue };

export function isModelArtifact(value: unknown): value is ModelArtifact {
	return (
		isRecord(value) &&
		(value.provider === "huggingface" || value.provider === "civitai") &&
		typeof value.modelId === "string" &&
		value.modelId.length > 0 &&
		typeof value.versionId === "string" &&
		value.versionId.length > 0 &&
		typeof value.versionLabel === "string" &&
		value.versionLabel.length > 0 &&
		typeof value.fileId === "string" &&
		value.fileId.length > 0 &&
		typeof value.fileName === "string" &&
		value.fileName.length > 0 &&
		isNonNegativeInteger(value.sizeBytes) &&
		value.sizeBytes > 0
	);
}

export function parseModelSyncTarget(
	value: unknown,
): ModelSyncParseResult<ModelSyncTarget> {
	if (!isRecord(value) || !isRecord(value.artifact)) {
		return { ok: false, issue: "target" };
	}
	const artifact = value.artifact;
	if (
		typeof value.name !== "string" ||
		value.name.length === 0 ||
		value.name.length > 200 ||
		value.name.trim() !== value.name ||
		typeof value.path !== "string" ||
		!isModelRelativePath(value.path) ||
		(artifact.provider !== "huggingface" && artifact.provider !== "civitai") ||
		!isBoundedString(artifact.modelId, 512) ||
		!isBoundedString(artifact.versionId, 256) ||
		!isBoundedString(artifact.versionLabel, 512) ||
		!isBoundedString(artifact.fileId, 1_024) ||
		!isBoundedString(artifact.fileName, 1_024) ||
		!hasModelExtension(artifact.fileName) ||
		!isNonNegativeInteger(artifact.sizeBytes) ||
		artifact.sizeBytes === 0
	) {
		return { ok: false, issue: "target" };
	}
	if (
		artifact.provider === "civitai" &&
		(!/^[1-9]\d*$/u.test(artifact.modelId) ||
			!/^[1-9]\d*$/u.test(artifact.versionId) ||
			!/^[1-9]\d*$/u.test(artifact.fileId))
	) {
		return { ok: false, issue: "civitai-target" };
	}
	if (
		artifact.provider === "huggingface" &&
		(!isHuggingFaceModelId(artifact.modelId) ||
			!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(artifact.versionId) ||
			!isProviderFilePath(artifact.fileId))
	) {
		return { ok: false, issue: "huggingface-target" };
	}
	return {
		ok: true,
		value: {
			name: value.name,
			path: value.path,
			artifact: {
				provider: artifact.provider,
				modelId: artifact.modelId,
				versionId: artifact.versionId,
				versionLabel: artifact.versionLabel,
				fileId: artifact.fileId,
				fileName: artifact.fileName,
				sizeBytes: artifact.sizeBytes,
			},
		},
	};
}
export function parseModelSyncTargets(
	value: unknown,
	options: { allowEmpty: boolean; maximum?: number },
): ModelSyncParseResult<ModelSyncTarget[]> {
	const maximum = options.maximum ?? MAX_MODELS;
	if (
		!Array.isArray(value) ||
		(!options.allowEmpty && value.length === 0) ||
		value.length > maximum
	) {
		return { ok: false, issue: "selection" };
	}
	const paths = new Set<string>();
	const targets: ModelSyncTarget[] = [];
	for (const candidate of value) {
		const parsed = parseModelSyncTarget(candidate);
		if (!parsed.ok) return parsed;
		if (paths.has(parsed.value.path)) {
			return { ok: false, issue: "duplicate-path" };
		}
		paths.add(parsed.value.path);
		targets.push(parsed.value);
	}
	return { ok: true, value: targets };
}

export function parseModelSyncRequest(
	value: unknown,
): ModelSyncParseResult<ModelSyncRequest> {
	if (
		!isRecord(value) ||
		!Array.isArray(value.models) ||
		!isRecord(value.credentials)
	) {
		return { ok: false, issue: "request" };
	}
	const models = parseModelSyncTargets(value.models, { allowEmpty: false });
	if (!models.ok) return models;
	const credentials: ModelSyncCredentials = {};
	for (const provider of ["huggingface", "civitai"] as const) {
		const token = value.credentials[provider];
		if (token === undefined) continue;
		if (
			typeof token !== "string" ||
			token.length === 0 ||
			token.length > 8_192 ||
			token.trim() !== token
		) {
			return { ok: false, issue: "credential" };
		}
		credentials[provider] = token;
	}
	if (
		Object.keys(value.credentials).some(
			(key) => key !== "huggingface" && key !== "civitai",
		)
	) {
		return { ok: false, issue: "credential" };
	}
	return { ok: true, value: { models: models.value, credentials } };
}

export function parseModelVerificationRequest(
	value: unknown,
): ModelSyncParseResult<{ models: ModelSyncTarget[] }> {
	if (!isRecord(value) || !Array.isArray(value.models)) {
		return { ok: false, issue: "request" };
	}
	const models = parseModelSyncTargets(value.models, { allowEmpty: true });
	return models.ok ? { ok: true, value: { models: models.value } } : models;
}

export function isUnsupportedModelSyncContract(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if ("contractVersion" in value) {
		return (
			isNonNegativeInteger(value.contractVersion) &&
			value.contractVersion !== MODEL_SYNC_CONTRACT_VERSION
		);
	}
	if (value.status === "idle") return hasModelTargets(value, true);
	if (value.status === "canceling") return true;
	if (value.status === "canceled" || value.status === "synced") {
		return hasModelTargets(value, false);
	}
	if (value.status === "failed") {
		return (
			hasModelTargets(value, false) &&
			value.models !== null &&
			typeof value.error === "string" &&
			(value.total === undefined ||
				(isNonNegativeInteger(value.total) &&
					value.total > 0 &&
					value.models.length <= value.total))
		);
	}
	if (value.status === "checking") return hasSyncTotals(value);
	return value.status === "syncing" && hasModelSyncProgress(value);
}

export function parseModelSyncState(value: unknown): ModelSyncState | null {
	if (!isRecord(value) || value.contractVersion !== MODEL_SYNC_CONTRACT_VERSION) {
		return null;
	}
	if ("credentials" in value) return null;
	if (!isOptionalModelSyncCapabilities(value.capabilities)) return null;
	if (value.status === "idle") {
		const target = value.target === null ? null : parseModelSyncSelection(value.target);
		if (
			value.operationId !== null ||
			value.operationKind !== undefined ||
			(value.target !== null && target === null) ||
			!hasModelTargets(value, true) ||
			!isOptionalModelSyncSnapshot(value.modelSnapshot, target)
		) {
			return null;
		}
		return { ...value, target } as ModelSyncState;
	}
	const target = parseModelSyncSelection(value.target);
	if (
		target === null ||
		!isModelSyncOperationId(value.operationId) ||
		(value.operationKind !== "sync" && value.operationKind !== "redownload") ||
		!isOptionalModelSyncSnapshot(value.modelSnapshot, target)
	) {
		return null;
	}
	if (value.operationKind === "redownload" && target.models.length !== 1) return null;
	if (value.status === "checking") {
		return hasSyncTotals(value) && value.total === target.models.length
			? ({ ...value, target } as ModelSyncState)
			: null;
	}
	if (value.status === "syncing") {
		return hasModelSyncProgress(value, target.models)
			? ({ ...value, target } as ModelSyncState)
			: null;
	}
	if (value.status === "canceling") {
		return { ...value, target } as ModelSyncState;
	}
	if (value.status === "canceled" || value.status === "synced") {
		return hasModelTargets(value, false) && value.models !== null
			? ({ ...value, target } as ModelSyncState)
			: null;
	}
	return value.status === "failed" &&
		hasModelTargets(value, false) &&
		value.models !== null &&
		typeof value.error === "string" &&
		(value.total === undefined ||
			(isNonNegativeInteger(value.total) &&
				value.total > 0 &&
				value.models.length <= value.total))
		? ({ ...value, target } as ModelSyncState)
		: null;
}
export function isModelSyncState(value: unknown): value is ModelSyncServerState {
	return parseModelSyncState(value) !== null;
}

export function sameModelSyncTargets(
	left: readonly ModelSyncTarget[],
	right: readonly ModelSyncTarget[],
): boolean {
	return (
		left.length === right.length &&
		left.every((target, index) => {
			const other = right[index];
			return other !== undefined && sameModelSyncTarget(target, other);
		})
	);
}

export function sameModelSyncTarget(
	left: ModelSyncTarget,
	right: ModelSyncTarget,
): boolean {
	return (
		left.path === right.path &&
		left.artifact.provider === right.artifact.provider &&
		left.artifact.modelId === right.artifact.modelId &&
		left.artifact.versionId === right.artifact.versionId &&
		left.artifact.versionLabel === right.artifact.versionLabel &&
		left.artifact.fileId === right.artifact.fileId &&
		left.artifact.fileName === right.artifact.fileName &&
		left.artifact.sizeBytes === right.artifact.sizeBytes
	);
}

function hasModelTargets(
	value: Record<string, unknown>,
	allowNull: boolean,
): value is Record<string, unknown> & { models: ModelSyncTarget[] | null } {
	return (
		(allowNull && value.models === null) ||
		(Array.isArray(value.models) &&
			value.models.every((model) => parseModelSyncTarget(model).ok))
	);
}

function hasSyncTotals(
	value: Record<string, unknown>,
): value is Record<string, unknown> & { total: number; totalBytes: number } {
	return isNonNegativeInteger(value.total) && isNonNegativeInteger(value.totalBytes);
}

function hasModelSyncProgress(
	value: Record<string, unknown>,
	targets?: readonly ModelSyncTarget[],
): value is Record<string, unknown> & {
	completed: number;
	total: number;
	completedBytes: number;
	totalBytes: number;
	present: number;
	active: string[];
} {
	if (
		!hasSyncTotals(value) ||
		!isNonNegativeInteger(value.completed) ||
		value.completed > value.total ||
		!isNonNegativeInteger(value.completedBytes) ||
		value.completedBytes > value.totalBytes ||
		!isNonNegativeInteger(value.present) ||
		value.present > value.completed ||
		!Array.isArray(value.active) ||
		!value.active.every((path) => typeof path === "string")
	) {
		return false;
	}
	if (targets === undefined) return true;
	const paths = new Set(targets.map((target) => target.path));
	return (
		value.total === targets.length && value.active.every((path) => paths.has(path))
	);
}

function parseModelSyncSelection(value: unknown): ModelSyncSelection | null {
	if (
		!isRecord(value) ||
		!Array.isArray(value.models) ||
		"credentials" in value ||
		Object.keys(value).some((key) => key !== "models")
	) {
		return null;
	}
	const models = parseModelSyncTargets(value.models, { allowEmpty: false });
	return models.ok ? { models: models.value } : null;
}

function isOptionalModelSyncCapabilities(
	value: unknown,
): value is ModelSyncCapabilities | undefined {
	return (
		value === undefined ||
		(isRecord(value) &&
			(!("forceRedownload" in value) || typeof value.forceRedownload === "boolean"))
	);
}

function isOptionalModelSyncSnapshot(
	value: unknown,
	target: ModelSyncSelection | null,
): value is ModelSyncSnapshot | undefined {
	if (value === undefined) return true;
	if (target === null || !isRecord(value) || !Array.isArray(value.models)) return false;
	if (value.models.length !== target.models.length) return false;
	return value.models.every((candidate, index) => {
		const targetModel = target.models[index];
		if (
			targetModel === undefined ||
			!isRecord(candidate) ||
			candidate.path !== targetModel.path ||
			!isModelSyncFileStatus(candidate.status) ||
			!isNonNegativeInteger(candidate.downloadedBytes) ||
			candidate.downloadedBytes > targetModel.artifact.sizeBytes ||
			(candidate.error !== undefined && typeof candidate.error !== "string")
		) {
			return false;
		}
		return (
			candidate.status !== "ready" ||
			candidate.downloadedBytes === targetModel.artifact.sizeBytes
		);
	});
}

function isModelSyncFileStatus(value: unknown): value is ModelSyncFileStatus {
	return (
		value === "ready" ||
		value === "downloading" ||
		value === "not-downloaded" ||
		value === "failed" ||
		value === "needs-redownload"
	);
}

function isModelSyncOperationId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value
	);
}

export function isModelRelativePath(value: string): boolean {
	if (value.includes("\\") || value.startsWith("/") || !hasModelExtension(value)) {
		return false;
	}
	const segments = value.split("/");
	return (
		segments.length >= 2 &&
		segments.every(
			(segment) =>
				segment.length > 0 &&
				segment !== "." &&
				segment !== ".." &&
				!segment.includes(":"),
		)
	);
}

function hasModelExtension(value: string): boolean {
	const lower = value.toLowerCase();
	return MODEL_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isHuggingFaceModelId(value: string): boolean {
	const segments = value.split("/");
	return (
		segments.length >= 1 &&
		segments.length <= 2 &&
		segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))
	);
}

function isProviderFilePath(value: string): boolean {
	if (value.includes("\\") || value.startsWith("/") || !hasModelExtension(value)) {
		return false;
	}
	return value
		.split("/")
		.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
