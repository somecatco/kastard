import {
	type BackendState,
	type CustomNodeInventoryEntry,
	type CustomNodeSyncNodeStatus,
	type CustomNodeSyncState,
	isBackendState,
	isCustomNodeInventoryEntry,
	isCustomNodeManagerId,
	isCustomNodeManagerVersion,
	isCustomNodeName,
	isGitCommit,
	isGitHubRepositoryId,
	isModelArtifact,
	isModelRelativePath,
	isModelSyncState,
	isSyncVerification,
	isWorkerComfyRuntimeState,
	isWorkerLogEntry,
	isWorkerSystemStatus,
	type ModelArtifact,
	type ModelProvider,
	type ModelSyncFileStatus,
	type ModelSyncState,
	type ModelSyncTarget,
	normalizeGitHubRepository,
	parseCustomNodeSyncState,
	parseModelSyncTarget,
	parseReleaseIdentity,
	type ReleaseIdentity,
	type SyncVerification,
	type WorkerComfyRuntimeState,
	type WorkerLogEntry,
	type WorkerSystemStatus,
} from "@kastard/common";

export type {
	BackendState,
	BackendTarget,
	BackendVerification,
	CollectionVerification,
	CustomNodeInventoryEntry,
	CustomNodeSyncNodeStatus,
	CustomNodeSyncState,
	CustomNodeSyncTarget,
	GpuSystemStatus,
	ModelArtifact,
	ModelProvider,
	ModelSyncCredentials,
	ModelSyncFileState,
	ModelSyncFileStatus,
	ModelSyncRequest,
	ModelSyncSnapshot,
	ModelSyncState,
	ModelSyncTarget,
	ReleaseChannel,
	ReleaseIdentity,
	SyncVerification,
	SyncVerificationRequest,
	VerificationProblem,
	VerificationStatus,
	WorkerComfyRuntimeState,
	WorkerLogEntry,
	WorkerLogLevel,
	WorkerRuntime,
	WorkerSystemStatus,
} from "@kastard/common";
export {
	isBackendState,
	isCustomNodeSyncState,
	isModelArtifact,
	isModelSyncState,
	isSyncVerification,
	isWorkerComfyRuntimeState,
	isWorkerLogEntry,
	isWorkerSystemStatus,
	parseCustomNodeSyncState,
} from "@kastard/common";

export const APP_INFO_GET_CHANNEL = "app-info:get";
export const DEBUG_INFO_COPY_CHANNEL = "debug-info:copy";
export const COMFY_RESTART_CHANNEL = "comfy:restart";
export const COMFY_START_CHANNEL = "comfy:start";
export const COMFY_STATE_CHANNEL = "comfy:state";
export const COMFY_VERSION_GET_CHANNEL = "comfy-version:get";
export const COMFY_VERSION_CATALOG_CHANNEL = "comfy-version:catalog";
export const COMFY_VERSION_UPDATE_CHANNEL = "comfy-version:update";
export const COMFY_VERSION_STATE_CHANNEL = "comfy-version:state";
export const CUSTOM_NODES_LIST_CHANNEL = "custom-nodes:list";
export const CUSTOM_NODES_REMOVE_CHANNEL = "custom-nodes:remove";
export const CUSTOM_NODES_UPDATE_CHANNEL = "custom-nodes:update";
export const EDITOR_DIRECTORY_GET_CHANNEL = "editor-directory:get";
export const EDITOR_DIRECTORY_OPEN_CHANNEL = "editor-directory:open";
export const MODEL_LIBRARY_LIST_CHANNEL = "model-library:list";
export const MODEL_LIBRARY_ADD_CHANNEL = "model-library:add";
export const MODEL_LIBRARY_UPDATE_CHANNEL = "model-library:update";
export const MODEL_LIBRARY_REMOVE_CHANNEL = "model-library:remove";
export const MODEL_PROVIDER_FILES_CHANNEL = "model-provider:files";
export const MODEL_PROVIDER_SETTINGS_GET_CHANNEL = "model-provider-settings:get";
export const MODEL_PROVIDER_SETTINGS_UPDATE_CHANNEL = "model-provider-settings:update";
export const WORKER_SESSION_GET_CHANNEL = "worker-session:get";
export const WORKER_SESSION_INITIALIZE_CHANNEL = "worker-session:initialize";
export const WORKER_SESSION_CONNECT_CHANNEL = "worker-session:connect";
export const WORKER_SESSION_RETRY_CHANNEL = "worker-session:retry";
export const WORKER_SESSION_DISCONNECT_CHANNEL = "worker-session:disconnect";
export const WORKER_SESSION_PREPARE_BACKEND_CHANNEL = "worker-session:prepare-backend";
export const WORKER_SESSION_START_SETUP_CHANNEL = "worker-session:start-setup";
export const WORKER_SESSION_CANCEL_SETUP_CHANNEL = "worker-session:cancel-setup";
export const WORKER_SESSION_RESTART_COMFY_CHANNEL = "worker-session:restart-comfy";
export const WORKER_SESSION_SYNC_CUSTOM_NODES_CHANNEL =
	"worker-session:sync-custom-nodes";
export const WORKER_SESSION_REINSTALL_CUSTOM_NODE_CHANNEL =
	"worker-session:reinstall-custom-node";
export const WORKER_SESSION_REMOVE_CUSTOM_NODE_CHANNEL =
	"worker-session:remove-custom-node";
export const WORKER_SESSION_CANCEL_CUSTOM_NODES_CHANNEL =
	"worker-session:cancel-custom-nodes";
export const WORKER_SESSION_SYNC_MODELS_CHANNEL = "worker-session:sync-models";
export const WORKER_SESSION_REDOWNLOAD_MODEL_CHANNEL =
	"worker-session:redownload-model";
export const WORKER_SESSION_CANCEL_MODELS_CHANNEL = "worker-session:cancel-models";
export const WORKER_SESSION_VERIFY_CHANNEL = "worker-session:verify";
export const WORKER_SESSION_STATE_CHANNEL = "worker-session:state";
export const CONNECTION_COPY_LOGS_CHANNEL = "connection:copy-logs";
export const CONNECTION_LOGS_CHANNEL = "connection:logs";
export const CONNECTION_SETTINGS_GET_CHANNEL = "connection-settings:get";
export const CONNECTION_SETTINGS_UPDATE_CHANNEL = "connection-settings:update";
export const THEME_GET_CHANNEL = "theme:get";
export const THEME_UPDATE_CHANNEL = "theme:update";
export const SYNC_COMPLETION_NOTIFICATION_SETTINGS_GET_CHANNEL =
	"sync-completion-notification-settings:get";
export const SYNC_COMPLETION_NOTIFICATION_SETTINGS_UPDATE_CHANNEL =
	"sync-completion-notification-settings:update";
export const MENU_OPEN_SETTINGS_CHANNEL = "menu:open-settings";

export type DesktopAppInfo = ReleaseIdentity & {
	environment: {
		os: string;
		osVersion: string;
		arch: string;
		electronVersion: string;
		chromeVersion: string;
		nodeVersion: string;
	};
};

export type DesktopTheme = "system" | "light" | "dark";

export type DesktopThemeResult =
	| { ok: true; theme: DesktopTheme }
	| { ok: false; error: string };

export type SyncCompletionNotificationSettings = {
	enabled: boolean;
};

export type SyncCompletionNotificationSettingsResult =
	| { ok: true; settings: SyncCompletionNotificationSettings }
	| { ok: false; error: string };

export type WorkerProvider = "runpod" | "vastai" | "other";

export type ConnectionState =
	| {
			status: "disconnected";
			recentProvider: WorkerProvider | null;
			recentWorkerAddress: string | null;
	  }
	| { status: "connecting"; provider: WorkerProvider; workerAddress: string }
	| {
			status: "connected";
			provider: WorkerProvider;
			workerAddress: string;
			connectedAt: number;
			worker?: ReleaseIdentity;
	  }
	| {
			status: "offline";
			provider: WorkerProvider;
			workerAddress: string;
			message: string;
			reconnectRequired?: boolean;
	  }
	| { status: "error"; message: string };

export type ConnectionRequest = {
	provider: WorkerProvider;
	workerAddress: string;
	authenticationCode: string;
	syncAfterConnect: boolean;
};

export type ConnectionResult = { ok: true } | { ok: false; error: string };

export type ConnectionSettings = {
	syncAfterConnect: boolean;
	systemMetricsEnabled: boolean;
};

export type ConnectionSettingsResult =
	| { ok: true; settings: ConnectionSettings }
	| { ok: false; error: string };

export type WorkerLogsResult =
	| { ok: true; logs: WorkerLogEntry[]; truncated: boolean }
	| { ok: false; error: string };

export type WorkerBackendState =
	| { status: "disconnected"; editorComfyVersion: string }
	| { status: "loading"; editorComfyVersion: string }
	| {
			status: "unavailable";
			editorComfyVersion: string;
			error: string;
			retryable?: boolean;
	  }
	| (BackendState & { editorComfyVersion: string });

export type WorkerBackendResult =
	| { ok: true; state: WorkerBackendState }
	| { ok: false; error: string; retryable?: boolean };

export type WorkerComfyState =
	| { status: "disconnected" }
	| { status: "loading" }
	| { status: "unavailable"; error: string; retryable?: boolean }
	| WorkerComfyRuntimeState;

export type WorkerSystemMetricsState =
	| { status: "disconnected" }
	| { status: "disabled" }
	| { status: "loading" }
	| { status: "unavailable"; error: string }
	| { status: "available"; metrics: WorkerSystemStatus };

export type CustomNodeEntry = {
	name: string;
	version: string;
	managerId: string | null;
	repository?: string;
	workerSyncIssue?: string;
	sync: boolean;
};

export function isComfyUiManagerNode(
	node: Pick<CustomNodeEntry, "name" | "managerId">,
): boolean {
	return [node.name, node.managerId]
		.filter((value): value is string => value !== null)
		.some((value) => /^comfyui[-_]manager$/iu.test(value));
}

export type UnsupportedCustomNode = {
	name: string;
	reason: string;
};

type WorkerCustomNodeSyncSelection = {
	unsupportedNodes: UnsupportedCustomNode[];
	targetStatus?: "current" | "stale" | "unknown";
	reinstallNodeId?: string;
	targetNodes?: WorkerCustomNodeTargetState[];
	unselectedNodes?: CustomNodeInventoryEntry[] | null;
};

export type WorkerCustomNodeTargetState = {
	id: string;
	editorVersion: string;
	workerVersion: string | null;
	status: CustomNodeSyncNodeStatus;
	error?: string;
};

type WorkerCustomNodeRemoteState = CustomNodeSyncState extends infer State
	? State extends CustomNodeSyncState
		? Omit<State, "contractVersion" | "target" | "operationId">
		: never
	: never;

export type WorkerCustomNodeSyncState =
	| { status: "disconnected" }
	| { status: "loading" }
	| { status: "unavailable"; error: string; retryable: boolean }
	| (WorkerCustomNodeRemoteState & WorkerCustomNodeSyncSelection);

export type WorkerCustomNodeSyncResult =
	| { ok: true; state: WorkerCustomNodeSyncState }
	| { ok: false; error: string };

export type WorkerCustomNodeReinstallRequest = { id: string };
export type WorkerCustomNodeRemovalRequest = { node: CustomNodeInventoryEntry };

export type WorkerModelTargetStatus =
	| ModelSyncFileStatus
	| "redownloading"
	| "redownload-failed";

export type WorkerModelTargetState = {
	target: ModelSyncTarget;
	status: WorkerModelTargetStatus;
	downloadedBytes: number;
	error?: string;
};

type WorkerModelRemoteState = ModelSyncState extends infer State
	? State extends ModelSyncState
		? Omit<State, "contractVersion" | "target" | "operationId" | "operationKind"> & {
				operationKind?: State["operationKind"];
			}
		: never
	: never;

type WorkerModelSyncSelection = {
	targetStatus?: "current" | "stale" | "unknown";
	targetModels?: WorkerModelTargetState[];
};

export type WorkerModelSyncState =
	| { status: "disconnected" }
	| { status: "loading" }
	| { status: "unavailable"; error: string; retryable: boolean }
	| (WorkerModelRemoteState & WorkerModelSyncSelection);

export type WorkerModelSyncResult =
	| { ok: true; state: WorkerModelSyncState }
	| { ok: false; error: string };

export type WorkerModelRedownloadRequest = { path: string };

export type SyncVerificationResult =
	| { ok: true; verification: SyncVerification }
	| { ok: false; error: string };

export type WorkerSetupPhase = "preparation" | "verification" | "comfy";

export type WorkerSetupState =
	| { status: "idle"; pendingAutomaticStart?: true }
	| { status: "running"; phase: WorkerSetupPhase }
	| { status: "succeeded"; verification: SyncVerification }
	| { status: "canceled" }
	| {
			status: "failed";
			phase?: WorkerSetupPhase;
			error: string;
			verification?: SyncVerification;
	  };

export type WorkerWorkflowCurrentState = {
	id: string;
	phase: "dispatching" | "running" | "reconciling" | "collecting";
	cancellation: "none" | "requested" | "unconfirmed";
	workerAddress: string;
	lastConfirmedStatus:
		| "running"
		| "canceling"
		| "canceled"
		| "completed"
		| "failed"
		| null;
	lastConfirmedAt: number | null;
};

export type WorkerSessionState = {
	connection: ConnectionState;
	systemMetrics: WorkerSystemMetricsState;
	backend: WorkerBackendState;
	comfy: WorkerComfyState;
	customNodes: WorkerCustomNodeSyncState;
	models: WorkerModelSyncState;
	verification: SyncVerification | null;
	setup: WorkerSetupState;
	workflow?: WorkerWorkflowCurrentState | null;
};

export type WorkerSessionStateChange =
	| { revision: number; type: "session.reset"; state: WorkerSessionState }
	| {
			revision: number;
			type: "lifecycle.changed";
			connection: ConnectionState;
			setup: WorkerSetupState;
	  }
	| { revision: number; type: "connection.changed"; connection: ConnectionState }
	| {
			revision: number;
			type: "system-metrics.changed";
			systemMetrics: WorkerSystemMetricsState;
	  }
	| { revision: number; type: "backend.changed"; backend: WorkerBackendState }
	| { revision: number; type: "comfy.changed"; comfy: WorkerComfyState }
	| {
			revision: number;
			type: "custom-nodes.changed";
			customNodes: WorkerCustomNodeSyncState;
	  }
	| { revision: number; type: "models.changed"; models: WorkerModelSyncState }
	| {
			revision: number;
			type: "verification.changed";
			verification: SyncVerification | null;
	  }
	| { revision: number; type: "setup.changed"; setup: WorkerSetupState }
	| {
			revision: number;
			type: "workflow.changed";
			workflow: WorkerWorkflowCurrentState | null;
	  };

export type WorkerSessionSnapshot = {
	revision: number;
	state: WorkerSessionState;
};

export function applyWorkerSessionStateChange(
	state: WorkerSessionState,
	change: WorkerSessionStateChange,
): WorkerSessionState {
	switch (change.type) {
		case "session.reset":
			return change.state;
		case "lifecycle.changed":
			return { ...state, connection: change.connection, setup: change.setup };
		case "connection.changed":
			return { ...state, connection: change.connection };
		case "system-metrics.changed":
			return { ...state, systemMetrics: change.systemMetrics };
		case "backend.changed":
			return { ...state, backend: change.backend, verification: null };
		case "comfy.changed":
			return { ...state, comfy: change.comfy };
		case "custom-nodes.changed":
			return { ...state, customNodes: change.customNodes, verification: null };
		case "models.changed":
			return { ...state, models: change.models, verification: null };
		case "verification.changed":
			return { ...state, verification: change.verification };
		case "setup.changed":
			return { ...state, setup: change.setup };
		case "workflow.changed":
			return { ...state, workflow: change.workflow };
	}
}

export type CustomNodeUpdateRequest = Pick<CustomNodeEntry, "name" | "sync">;

export type CustomNodeRemoveRequest = Pick<CustomNodeEntry, "name">;

export type CustomNodeRemoveResult =
	| { ok: true; restartRequired: boolean }
	| { ok: false; error: string };

export type CustomNodesListResult =
	| { ok: true; nodes: CustomNodeEntry[] }
	| { ok: false; error: string };

export type EditorDirectory = "comfy" | "custom-nodes" | "model-library";

export type EditorDirectoryResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

export type ModelLibraryEntry = {
	id: string;
	name: string;
	sourceUrl: string;
	path: string;
	sync: boolean;
	artifact: ModelArtifact | null;
};

export type ModelLibraryInput = Omit<ModelLibraryEntry, "id">;

export type ModelLibraryUpdateRequest = {
	id: string;
	input: ModelLibraryInput;
};

export type ModelLibraryRemoveRequest = {
	id: string;
};

export type ModelLibraryListResult =
	| { ok: true; models: ModelLibraryEntry[] }
	| { ok: false; error: string };

export type ModelLibraryMutationResult =
	| { ok: true; model: ModelLibraryEntry }
	| { ok: false; error: string };

export type ModelProviderFilesRequest = {
	sourceUrl: string;
};

export type ModelProviderFilesResult =
	| { ok: true; modelName: string; files: ModelArtifact[] }
	| { ok: false; error: string };

export type ModelProviderSettings = Record<ModelProvider, boolean>;

export type ModelProviderSettingsResult =
	| { ok: true; configured: ModelProviderSettings }
	| { ok: false; error: string };

export type ModelProviderTokenUpdate = {
	provider: ModelProvider;
	token: string | null;
};

export type ComfyRuntimeState =
	| { status: "idle" | "starting" }
	| {
			status: "preparing";
			phase: "python" | "dependencies";
			progress: number;
			firstRun: boolean;
	  }
	| { status: "ready"; url: string }
	| { status: "error"; message: string; reason?: "custom-node" };

export type ComfyStartResult =
	| { ok: true; url: string }
	| { ok: false; error: string; reason?: "custom-node" };

export type ComfyComponent = "frontend" | "backend" | "manager";

export type ComfySourceComponent = Exclude<ComfyComponent, "manager">;

/** `null` selects a bundled source or the Manager version pinned by the backend. */
export type ComfyVersionSelection = {
	frontend: string | null;
	backend: string | null;
	/** `null` follows the Manager version pinned by the selected backend. */
	manager: string | null;
};

export type ComfyInstallState =
	| { status: "idle" }
	| {
			status: "installing";
			component: ComfySourceComponent;
			version: string;
			progress: number;
	  };

export type ComfyVersionState = {
	selection: ComfyVersionSelection;
	bundled: { frontend: string; backend: string; manager: string };
	/** Frontend version the active backend pins, when its requirements declare one. */
	recommendedFrontend: string | null;
	/** Manager version the active backend pins, or `null` while that pin is unavailable. */
	recommendedManager: string | null;
	install: ComfyInstallState;
};

export type ComfyReleaseOption = { version: string; installed: boolean };

export type ComfyVersionCatalog = {
	frontend: ComfyReleaseOption[];
	backend: ComfyReleaseOption[];
	manager: ComfyReleaseOption[];
	/** Set when the live release listing could not be refreshed; the lists still hold what is known. */
	error: string | null;
};

export type ComfyVersionUpdate = {
	component: ComfyComponent;
	version: string | null;
};

export type ComfyVersionResult =
	| { ok: true; state: ComfyVersionState }
	| { ok: false; error: string };

export type ComfyVersionCatalogResult =
	| { ok: true; catalog: ComfyVersionCatalog }
	| { ok: false; error: string };

export type KastardApi = {
	appInfo: {
		get: () => Promise<DesktopAppInfo>;
	};
	debugInfo: {
		copy: (text: string) => Promise<ConnectionResult>;
	};
	comfy: {
		restart: () => Promise<ConnectionResult>;
		start: () => Promise<ComfyStartResult>;
		onStateChange: (listener: (state: ComfyRuntimeState) => void) => () => void;
	};
	comfyVersions: {
		getState: () => Promise<ComfyVersionResult>;
		getCatalog: () => Promise<ComfyVersionCatalogResult>;
		select: (request: ComfyVersionUpdate) => Promise<ComfyVersionResult>;
		onStateChange: (listener: (state: ComfyVersionState) => void) => () => void;
	};
	workerSession: {
		getSnapshot: () => Promise<WorkerSessionSnapshot>;
		retryInitialization: () => Promise<ConnectionResult>;
		connect: (request: ConnectionRequest) => Promise<ConnectionResult>;
		retry: () => Promise<ConnectionResult>;
		disconnect: () => Promise<ConnectionResult>;
		prepareBackend: () => Promise<WorkerBackendResult>;
		startSetup: () => Promise<ConnectionResult>;
		cancelSetup: () => Promise<ConnectionResult>;
		restartComfy: () => Promise<ConnectionResult>;
		syncCustomNodes: () => Promise<WorkerCustomNodeSyncResult>;
		reinstallCustomNode: (
			request: WorkerCustomNodeReinstallRequest,
		) => Promise<WorkerCustomNodeSyncResult>;
		removeCustomNode: (
			request: WorkerCustomNodeRemovalRequest,
		) => Promise<WorkerCustomNodeSyncResult>;
		cancelCustomNodes: () => Promise<WorkerCustomNodeSyncResult>;
		syncModels: () => Promise<WorkerModelSyncResult>;
		redownloadModel: (
			request: WorkerModelRedownloadRequest,
		) => Promise<WorkerModelSyncResult>;
		cancelModels: () => Promise<WorkerModelSyncResult>;
		verify: () => Promise<SyncVerificationResult>;
		onStateChange: (listener: (change: WorkerSessionStateChange) => void) => () => void;
	};
	connection: {
		getSettings: () => Promise<ConnectionSettingsResult>;
		updateSettings: (settings: ConnectionSettings) => Promise<ConnectionSettingsResult>;
		copyWorkerLogs: (text: string) => Promise<ConnectionResult>;
		getLogs: () => Promise<WorkerLogsResult>;
	};
	customNodes: {
		list: () => Promise<CustomNodesListResult>;
		remove: (request: CustomNodeRemoveRequest) => Promise<CustomNodeRemoveResult>;
		update: (request: CustomNodeUpdateRequest) => Promise<ConnectionResult>;
	};
	editorDirectories: {
		get: (directory: EditorDirectory) => Promise<EditorDirectoryResult>;
		open: (directory: EditorDirectory) => Promise<ConnectionResult>;
	};
	menu: {
		onOpenSettings: (listener: () => void) => () => void;
	};
	theme: {
		initial: DesktopTheme;
		get: () => Promise<DesktopThemeResult>;
		update: (theme: DesktopTheme) => Promise<DesktopThemeResult>;
	};
	syncCompletionNotification: {
		getSettings: () => Promise<SyncCompletionNotificationSettingsResult>;
		updateSettings: (
			settings: SyncCompletionNotificationSettings,
		) => Promise<SyncCompletionNotificationSettingsResult>;
	};
	models: {
		list: () => Promise<ModelLibraryListResult>;
		add: (input: ModelLibraryInput) => Promise<ModelLibraryMutationResult>;
		update: (request: ModelLibraryUpdateRequest) => Promise<ModelLibraryMutationResult>;
		remove: (request: ModelLibraryRemoveRequest) => Promise<ModelLibraryMutationResult>;
		resolveFiles: (
			request: ModelProviderFilesRequest,
		) => Promise<ModelProviderFilesResult>;
	};
	modelProviders: {
		getSettings: () => Promise<ModelProviderSettingsResult>;
		updateToken: (
			request: ModelProviderTokenUpdate,
		) => Promise<ModelProviderSettingsResult>;
	};
};

export function isDesktopAppInfo(value: unknown): value is DesktopAppInfo {
	return (
		isRecord(value) &&
		parseReleaseIdentity(value) !== null &&
		isRecord(value.environment) &&
		[
			value.environment.os,
			value.environment.osVersion,
			value.environment.arch,
			value.environment.electronVersion,
			value.environment.chromeVersion,
			value.environment.nodeVersion,
		].every((field) => typeof field === "string" && field.length > 0)
	);
}

export function isDesktopTheme(value: unknown): value is DesktopTheme {
	return value === "system" || value === "light" || value === "dark";
}

export function isDesktopThemeResult(value: unknown): value is DesktopThemeResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	return value.ok === true
		? "theme" in value && isDesktopTheme(value.theme)
		: value.ok === false && "error" in value && typeof value.error === "string";
}

export function isSyncCompletionNotificationSettings(
	value: unknown,
): value is SyncCompletionNotificationSettings {
	return isRecord(value) && typeof value.enabled === "boolean";
}

export function isSyncCompletionNotificationSettingsResult(
	value: unknown,
): value is SyncCompletionNotificationSettingsResult {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok
		? isSyncCompletionNotificationSettings(value.settings)
		: typeof value.error === "string";
}

export function isComfyRuntimeState(value: unknown): value is ComfyRuntimeState {
	if (typeof value !== "object" || value === null || !("status" in value)) return false;
	const candidate = value as Partial<ComfyRuntimeState>;
	if (candidate.status === "idle" || candidate.status === "starting") return true;
	if (candidate.status === "preparing") {
		return (
			(candidate.phase === "python" || candidate.phase === "dependencies") &&
			isRuntimeProgress(candidate)
		);
	}
	if (candidate.status === "ready") return typeof candidate.url === "string";
	return (
		candidate.status === "error" &&
		typeof candidate.message === "string" &&
		(candidate.reason === undefined || candidate.reason === "custom-node")
	);
}

function isRuntimeProgress(value: { progress?: unknown; firstRun?: unknown }): boolean {
	return (
		typeof value.progress === "number" &&
		Number.isInteger(value.progress) &&
		value.progress >= 0 &&
		value.progress <= 100 &&
		typeof value.firstRun === "boolean"
	);
}

export function isComfyStartResult(value: unknown): value is ComfyStartResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	const candidate = value as Partial<ComfyStartResult>;
	return (
		(candidate.ok === true && typeof candidate.url === "string") ||
		(candidate.ok === false &&
			typeof candidate.error === "string" &&
			(candidate.reason === undefined || candidate.reason === "custom-node"))
	);
}

export function isComfyComponent(value: unknown): value is ComfyComponent {
	return value === "frontend" || value === "backend" || value === "manager";
}

function isComfySourceComponent(value: unknown): value is ComfySourceComponent {
	return value === "frontend" || value === "backend";
}

export function isComfyVersionUpdate(value: unknown): value is ComfyVersionUpdate {
	return (
		isRecord(value) &&
		isComfyComponent(value.component) &&
		(value.version === null || typeof value.version === "string")
	);
}

export function isComfyVersionState(value: unknown): value is ComfyVersionState {
	if (!isRecord(value) || !isRecord(value.selection) || !isRecord(value.bundled)) {
		return false;
	}
	const { selection, bundled } = value;
	return (
		(selection.frontend === null || typeof selection.frontend === "string") &&
		(selection.backend === null || typeof selection.backend === "string") &&
		(selection.manager === null || typeof selection.manager === "string") &&
		typeof bundled.frontend === "string" &&
		typeof bundled.backend === "string" &&
		typeof bundled.manager === "string" &&
		(value.recommendedFrontend === null ||
			typeof value.recommendedFrontend === "string") &&
		(value.recommendedManager === null ||
			typeof value.recommendedManager === "string") &&
		isComfyInstallState(value.install)
	);
}

export function isComfyVersionResult(value: unknown): value is ComfyVersionResult {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok ? isComfyVersionState(value.state) : typeof value.error === "string";
}

export function isComfyVersionCatalogResult(
	value: unknown,
): value is ComfyVersionCatalogResult {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	if (!value.ok) return typeof value.error === "string";
	const catalog: unknown = value.catalog;
	return (
		isRecord(catalog) &&
		isComfyReleaseOptions(catalog.frontend) &&
		isComfyReleaseOptions(catalog.backend) &&
		isComfyReleaseOptions(catalog.manager) &&
		(catalog.error === null || typeof catalog.error === "string")
	);
}

function isComfyInstallState(value: unknown): value is ComfyInstallState {
	if (!isRecord(value)) return false;
	if (value.status === "idle") return true;
	return (
		value.status === "installing" &&
		isComfySourceComponent(value.component) &&
		typeof value.version === "string" &&
		typeof value.progress === "number"
	);
}

function isComfyReleaseOptions(value: unknown): value is ComfyReleaseOption[] {
	return (
		Array.isArray(value) &&
		value.every(
			(option: unknown) =>
				isRecord(option) &&
				typeof option.version === "string" &&
				typeof option.installed === "boolean",
		)
	);
}

export function isConnectionState(value: unknown): value is ConnectionState {
	if (typeof value !== "object" || value === null || !("status" in value)) return false;
	const candidate = value as Partial<ConnectionState>;
	if (candidate.status === "disconnected") {
		return (
			(candidate.recentProvider === null && candidate.recentWorkerAddress === null) ||
			(isWorkerProvider(candidate.recentProvider) &&
				typeof candidate.recentWorkerAddress === "string")
		);
	}
	if (candidate.status === "connecting") {
		return (
			isWorkerProvider(candidate.provider) &&
			typeof candidate.workerAddress === "string"
		);
	}
	if (candidate.status === "connected") {
		return (
			isWorkerProvider(candidate.provider) &&
			typeof candidate.workerAddress === "string" &&
			typeof candidate.connectedAt === "number" &&
			Number.isFinite(candidate.connectedAt) &&
			candidate.connectedAt >= 0 &&
			(candidate.worker === undefined ||
				parseReleaseIdentity(candidate.worker) !== null)
		);
	}
	if (candidate.status === "offline") {
		return (
			isWorkerProvider(candidate.provider) &&
			typeof candidate.workerAddress === "string" &&
			typeof candidate.message === "string" &&
			(candidate.reconnectRequired === undefined ||
				typeof candidate.reconnectRequired === "boolean")
		);
	}
	return candidate.status === "error" && typeof candidate.message === "string";
}

export function isConnectionResult(value: unknown): value is ConnectionResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	const candidate = value as Partial<ConnectionResult>;
	return (
		candidate.ok === true ||
		(candidate.ok === false && typeof candidate.error === "string")
	);
}

export function isEditorDirectory(value: unknown): value is EditorDirectory {
	return value === "comfy" || value === "custom-nodes" || value === "model-library";
}

export function isEditorDirectoryResult(
	value: unknown,
): value is EditorDirectoryResult {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok ? typeof value.path === "string" : typeof value.error === "string";
}

export function isConnectionSettings(value: unknown): value is ConnectionSettings {
	return (
		isRecord(value) &&
		typeof value.syncAfterConnect === "boolean" &&
		typeof value.systemMetricsEnabled === "boolean"
	);
}

export function isConnectionSettingsResult(
	value: unknown,
): value is ConnectionSettingsResult {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok
		? isConnectionSettings(value.settings)
		: typeof value.error === "string";
}

export function isWorkerLogsResult(value: unknown): value is WorkerLogsResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	if (value.ok === false) return "error" in value && typeof value.error === "string";
	return (
		value.ok === true &&
		"logs" in value &&
		Array.isArray(value.logs) &&
		value.logs.every(isWorkerLogEntry) &&
		"truncated" in value &&
		typeof value.truncated === "boolean"
	);
}

export function isWorkerBackendState(value: unknown): value is WorkerBackendState {
	if (
		typeof value !== "object" ||
		value === null ||
		!("status" in value) ||
		!("editorComfyVersion" in value) ||
		typeof value.editorComfyVersion !== "string"
	) {
		return false;
	}
	if (value.status === "disconnected" || value.status === "loading") {
		return true;
	}
	if (value.status === "unavailable") {
		return (
			"error" in value &&
			typeof value.error === "string" &&
			(!("retryable" in value) || typeof value.retryable === "boolean")
		);
	}
	return isBackendState(value);
}

export function isWorkerBackendResult(value: unknown): value is WorkerBackendResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	return value.ok === true
		? "state" in value && isWorkerBackendState(value.state)
		: value.ok === false &&
				"error" in value &&
				typeof value.error === "string" &&
				(!("retryable" in value) || typeof value.retryable === "boolean");
}

export function isWorkerComfyState(value: unknown): value is WorkerComfyState {
	if (!isRecord(value) || typeof value.status !== "string") return false;
	if (value.status === "disconnected" || value.status === "loading") return true;
	if (value.status === "unavailable") {
		return (
			typeof value.error === "string" &&
			(!("retryable" in value) || typeof value.retryable === "boolean")
		);
	}
	return isWorkerComfyRuntimeState(value);
}

export function isWorkerSystemMetricsState(
	value: unknown,
): value is WorkerSystemMetricsState {
	if (!isRecord(value) || typeof value.status !== "string") return false;
	if (
		value.status === "disconnected" ||
		value.status === "disabled" ||
		value.status === "loading"
	) {
		return true;
	}
	if (value.status === "unavailable") return typeof value.error === "string";
	return value.status === "available" && isWorkerSystemStatus(value.metrics);
}

export function isWorkerCustomNodeSyncState(
	value: unknown,
): value is WorkerCustomNodeSyncState {
	if (typeof value !== "object" || value === null || !("status" in value)) {
		return false;
	}
	if (value.status === "disconnected" || value.status === "loading") return true;
	if (value.status === "unavailable") {
		return (
			"error" in value &&
			typeof value.error === "string" &&
			"retryable" in value &&
			typeof value.retryable === "boolean"
		);
	}
	return (
		parseCustomNodeSyncState(value) !== null &&
		"unsupportedNodes" in value &&
		Array.isArray(value.unsupportedNodes) &&
		value.unsupportedNodes.every(isUnsupportedCustomNode) &&
		(!("targetStatus" in value) ||
			value.targetStatus === "current" ||
			value.targetStatus === "stale" ||
			value.targetStatus === "unknown") &&
		(!("reinstallNodeId" in value) ||
			isCustomNodeManagerId(value.reinstallNodeId) ||
			isGitHubRepositoryId(value.reinstallNodeId)) &&
		(!("targetNodes" in value) ||
			(Array.isArray(value.targetNodes) &&
				value.targetNodes.every(isWorkerCustomNodeTargetState))) &&
		(!("unselectedNodes" in value) ||
			value.unselectedNodes === null ||
			(Array.isArray(value.unselectedNodes) &&
				value.unselectedNodes.every(isCustomNodeInventoryEntry)))
	);
}

function isWorkerCustomNodeTargetState(
	value: unknown,
): value is WorkerCustomNodeTargetState {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.editorVersion !== "string" ||
		(value.workerVersion !== null && typeof value.workerVersion !== "string") ||
		!isCustomNodeSyncNodeStatus(value.status) ||
		(value.error !== undefined && typeof value.error !== "string")
	) {
		return false;
	}
	if (value.status === "installed") {
		return value.workerVersion === value.editorVersion;
	}
	if (value.status === "version-mismatch") {
		return value.workerVersion !== null && value.workerVersion !== value.editorVersion;
	}
	if (value.status === "not-installed") return value.workerVersion === null;
	return true;
}

function isCustomNodeSyncNodeStatus(value: unknown): value is CustomNodeSyncNodeStatus {
	return (
		value === "installed" ||
		value === "installing" ||
		value === "not-installed" ||
		value === "failed" ||
		value === "version-mismatch"
	);
}

function isUnsupportedCustomNode(value: unknown): value is UnsupportedCustomNode {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		isCustomNodeName(value.name) &&
		"reason" in value &&
		validIssue(value.reason)
	);
}

export function isWorkerCustomNodeSyncResult(
	value: unknown,
): value is WorkerCustomNodeSyncResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	return value.ok === true
		? "state" in value && isWorkerCustomNodeSyncState(value.state)
		: value.ok === false && "error" in value && typeof value.error === "string";
}

export function isWorkerModelSyncState(value: unknown): value is WorkerModelSyncState {
	if (typeof value !== "object" || value === null || !("status" in value)) {
		return false;
	}
	if (value.status === "disconnected" || value.status === "loading") return true;
	if (value.status === "unavailable") {
		return (
			"error" in value &&
			typeof value.error === "string" &&
			"retryable" in value &&
			typeof value.retryable === "boolean"
		);
	}
	return (
		isModelSyncState(value) &&
		(!("targetStatus" in value) ||
			value.targetStatus === "current" ||
			value.targetStatus === "stale" ||
			value.targetStatus === "unknown") &&
		(!("targetModels" in value) ||
			(Array.isArray(value.targetModels) &&
				value.targetModels.every(isWorkerModelTargetState)))
	);
}

function isWorkerModelTargetState(value: unknown): value is WorkerModelTargetState {
	if (
		!isRecord(value) ||
		!parseModelSyncTarget(value.target).ok ||
		!isWorkerModelTargetStatus(value.status) ||
		!Number.isSafeInteger(value.downloadedBytes) ||
		(value.downloadedBytes as number) < 0 ||
		(value.error !== undefined && typeof value.error !== "string")
	) {
		return false;
	}
	const target = value.target as ModelSyncTarget;
	return (value.downloadedBytes as number) <= target.artifact.sizeBytes;
}

function isWorkerModelTargetStatus(value: unknown): value is WorkerModelTargetStatus {
	return (
		value === "ready" ||
		value === "downloading" ||
		value === "not-downloaded" ||
		value === "failed" ||
		value === "needs-redownload" ||
		value === "redownloading" ||
		value === "redownload-failed"
	);
}

export function isWorkerModelSyncResult(
	value: unknown,
): value is WorkerModelSyncResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	return value.ok === true
		? "state" in value && isWorkerModelSyncState(value.state)
		: value.ok === false && "error" in value && typeof value.error === "string";
}

export function isSyncVerificationResult(
	value: unknown,
): value is SyncVerificationResult {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok
		? isSyncVerification(value.verification)
		: typeof value.error === "string";
}

export function isWorkerSetupState(value: unknown): value is WorkerSetupState {
	if (!isRecord(value) || typeof value.status !== "string") return false;
	if (value.status === "idle" || value.status === "canceled") return true;
	if (value.status === "running") {
		return (
			value.phase === "preparation" ||
			value.phase === "verification" ||
			value.phase === "comfy"
		);
	}
	if (value.status === "succeeded") {
		return isSyncVerification(value.verification);
	}
	return (
		value.status === "failed" &&
		typeof value.error === "string" &&
		(!("phase" in value) ||
			value.phase === "preparation" ||
			value.phase === "verification" ||
			value.phase === "comfy") &&
		(!("verification" in value) || isSyncVerification(value.verification))
	);
}

export function isWorkerSessionState(value: unknown): value is WorkerSessionState {
	return (
		isRecord(value) &&
		isConnectionState(value.connection) &&
		isWorkerSystemMetricsState(value.systemMetrics) &&
		isWorkerBackendState(value.backend) &&
		isWorkerComfyState(value.comfy) &&
		isWorkerCustomNodeSyncState(value.customNodes) &&
		isWorkerModelSyncState(value.models) &&
		(value.verification === null || isSyncVerification(value.verification)) &&
		isWorkerSetupState(value.setup) &&
		(!("workflow" in value) ||
			value.workflow === null ||
			isWorkerWorkflowCurrentState(value.workflow))
	);
}

export function isWorkerSessionSnapshot(
	value: unknown,
): value is WorkerSessionSnapshot {
	return (
		isRecord(value) &&
		typeof value.revision === "number" &&
		Number.isSafeInteger(value.revision) &&
		value.revision >= 0 &&
		isWorkerSessionState(value.state)
	);
}

export function isWorkerSessionStateChange(
	value: unknown,
): value is WorkerSessionStateChange {
	if (
		!isRecord(value) ||
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 1 ||
		typeof value.type !== "string"
	) {
		return false;
	}
	switch (value.type) {
		case "session.reset":
			return isWorkerSessionState(value.state);
		case "lifecycle.changed":
			return isConnectionState(value.connection) && isWorkerSetupState(value.setup);
		case "connection.changed":
			return isConnectionState(value.connection);
		case "system-metrics.changed":
			return isWorkerSystemMetricsState(value.systemMetrics);
		case "backend.changed":
			return isWorkerBackendState(value.backend);
		case "comfy.changed":
			return isWorkerComfyState(value.comfy);
		case "custom-nodes.changed":
			return isWorkerCustomNodeSyncState(value.customNodes);
		case "models.changed":
			return isWorkerModelSyncState(value.models);
		case "verification.changed":
			return value.verification === null || isSyncVerification(value.verification);
		case "setup.changed":
			return isWorkerSetupState(value.setup);
		case "workflow.changed":
			return value.workflow === null || isWorkerWorkflowCurrentState(value.workflow);
		default:
			return false;
	}
}

export function isWorkerCustomNodeReinstallRequest(
	value: unknown,
): value is WorkerCustomNodeReinstallRequest {
	return (
		isRecord(value) &&
		(isCustomNodeManagerId(value.id) || isGitHubRepositoryId(value.id))
	);
}

export function isWorkerCustomNodeRemovalRequest(
	value: unknown,
): value is WorkerCustomNodeRemovalRequest {
	return isRecord(value) && isCustomNodeInventoryEntry(value.node);
}

export function isWorkerModelRedownloadRequest(
	value: unknown,
): value is WorkerModelRedownloadRequest {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		value.path.length <= 2_048 &&
		isModelRelativePath(value.path)
	);
}

function isWorkerWorkflowCurrentState(
	value: unknown,
): value is WorkerWorkflowCurrentState {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		(value.phase === "dispatching" ||
			value.phase === "running" ||
			value.phase === "reconciling" ||
			value.phase === "collecting") &&
		(value.cancellation === "none" ||
			value.cancellation === "requested" ||
			value.cancellation === "unconfirmed") &&
		typeof value.workerAddress === "string" &&
		(value.lastConfirmedStatus === null ||
			value.lastConfirmedStatus === "running" ||
			value.lastConfirmedStatus === "canceling" ||
			value.lastConfirmedStatus === "canceled" ||
			value.lastConfirmedStatus === "completed" ||
			value.lastConfirmedStatus === "failed") &&
		(value.lastConfirmedAt === null || typeof value.lastConfirmedAt === "number")
	);
}

export function isCustomNodeEntry(value: unknown): value is CustomNodeEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<CustomNodeEntry>;
	if (
		!isCustomNodeName(candidate.name) ||
		typeof candidate.version !== "string" ||
		(candidate.managerId !== null && !isCustomNodeManagerId(candidate.managerId)) ||
		(candidate.workerSyncIssue !== undefined &&
			!validIssue(candidate.workerSyncIssue)) ||
		typeof candidate.sync !== "boolean"
	) {
		return false;
	}
	if (candidate.managerId !== null) {
		return (
			candidate.workerSyncIssue === undefined &&
			isCustomNodeManagerVersion(candidate.version) &&
			(candidate.repository === undefined ||
				isCustomNodeRepositoryUrl(candidate.repository))
		);
	}
	if (candidate.repository === undefined) {
		return candidate.workerSyncIssue !== undefined;
	}
	return (
		canonicalGitHubRepository(candidate.repository) &&
		(candidate.workerSyncIssue !== undefined || isGitCommit(candidate.version))
	);
}

function validIssue(value: unknown): value is string {
	return typeof value === "string" && value.trim() === value && value.length > 0;
}

function canonicalGitHubRepository(repository: unknown): repository is string {
	if (typeof repository !== "string") return false;
	const normalized = normalizeGitHubRepository(repository);
	return normalized !== null && normalized.url === repository;
}

export function isCustomNodeRepositoryUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.trim() !== value) return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			url.hostname !== "" &&
			url.username === "" &&
			url.password === ""
		);
	} catch {
		return false;
	}
}

export function isCustomNodeUpdateRequest(
	value: unknown,
): value is CustomNodeUpdateRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		isCustomNodeName(value.name) &&
		"sync" in value &&
		typeof value.sync === "boolean"
	);
}

export function isCustomNodeRemoveRequest(
	value: unknown,
): value is CustomNodeRemoveRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		isCustomNodeName(value.name)
	);
}

export function isCustomNodeRemoveResult(
	value: unknown,
): value is CustomNodeRemoveResult {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok
		? typeof value.restartRequired === "boolean"
		: typeof value.error === "string";
}

export function isCustomNodesListResult(
	value: unknown,
): value is CustomNodesListResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	if (value.ok === false) return "error" in value && typeof value.error === "string";
	return (
		value.ok === true &&
		"nodes" in value &&
		Array.isArray(value.nodes) &&
		value.nodes.every(isCustomNodeEntry)
	);
}

export function isConnectionRequest(value: unknown): value is ConnectionRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"provider" in value &&
		isWorkerProvider(value.provider) &&
		"workerAddress" in value &&
		typeof value.workerAddress === "string" &&
		"authenticationCode" in value &&
		typeof value.authenticationCode === "string" &&
		"syncAfterConnect" in value &&
		typeof value.syncAfterConnect === "boolean"
	);
}

export function isWorkerProvider(value: unknown): value is WorkerProvider {
	return value === "runpod" || value === "vastai" || value === "other";
}

export function isModelLibraryEntry(value: unknown): value is ModelLibraryEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ModelLibraryEntry>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.name === "string" &&
		typeof candidate.sourceUrl === "string" &&
		typeof candidate.path === "string" &&
		typeof candidate.sync === "boolean" &&
		(candidate.artifact === null || isModelArtifact(candidate.artifact))
	);
}

export function isModelLibraryInput(value: unknown): value is ModelLibraryInput {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ModelLibraryInput>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.sourceUrl === "string" &&
		typeof candidate.path === "string" &&
		typeof candidate.sync === "boolean" &&
		(candidate.artifact === null || isModelArtifact(candidate.artifact))
	);
}

export function isModelProviderFilesRequest(
	value: unknown,
): value is ModelProviderFilesRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"sourceUrl" in value &&
		typeof value.sourceUrl === "string"
	);
}

export function isModelProviderFilesResult(
	value: unknown,
): value is ModelProviderFilesResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	if (value.ok === false) return "error" in value && typeof value.error === "string";
	return (
		value.ok === true &&
		"modelName" in value &&
		isNonEmptyString(value.modelName) &&
		"files" in value &&
		Array.isArray(value.files) &&
		value.files.every(isModelArtifact)
	);
}

export function isModelLibraryUpdateRequest(
	value: unknown,
): value is ModelLibraryUpdateRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"input" in value &&
		isModelLibraryInput(value.input)
	);
}

export function isModelLibraryRemoveRequest(
	value: unknown,
): value is ModelLibraryRemoveRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string"
	);
}

export function isModelLibraryListResult(
	value: unknown,
): value is ModelLibraryListResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	if (value.ok === false) return "error" in value && typeof value.error === "string";
	return (
		value.ok === true &&
		"models" in value &&
		Array.isArray(value.models) &&
		value.models.every(isModelLibraryEntry)
	);
}

export function isModelLibraryMutationResult(
	value: unknown,
): value is ModelLibraryMutationResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	if (value.ok === false) return "error" in value && typeof value.error === "string";
	return value.ok === true && "model" in value && isModelLibraryEntry(value.model);
}

export function isModelProviderSettingsResult(
	value: unknown,
): value is ModelProviderSettingsResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	if (value.ok === false) return "error" in value && typeof value.error === "string";
	if (value.ok !== true || !("configured" in value)) return false;
	const configured = value.configured;
	return (
		typeof configured === "object" &&
		configured !== null &&
		"huggingface" in configured &&
		typeof configured.huggingface === "boolean" &&
		"civitai" in configured &&
		typeof configured.civitai === "boolean"
	);
}

export function isModelProviderTokenUpdate(
	value: unknown,
): value is ModelProviderTokenUpdate {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ModelProviderTokenUpdate>;
	return (
		(candidate.provider === "huggingface" || candidate.provider === "civitai") &&
		(candidate.token === null || typeof candidate.token === "string")
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
