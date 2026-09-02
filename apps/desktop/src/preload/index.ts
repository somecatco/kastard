import { contextBridge, ipcRenderer } from "electron";
import {
	APP_INFO_GET_CHANNEL,
	COMFY_RESTART_CHANNEL,
	COMFY_START_CHANNEL,
	COMFY_STATE_CHANNEL,
	COMFY_VERSION_CATALOG_CHANNEL,
	COMFY_VERSION_GET_CHANNEL,
	COMFY_VERSION_STATE_CHANNEL,
	COMFY_VERSION_UPDATE_CHANNEL,
	CONNECTION_COPY_LOGS_CHANNEL,
	CONNECTION_LOGS_CHANNEL,
	CONNECTION_SETTINGS_GET_CHANNEL,
	CONNECTION_SETTINGS_UPDATE_CHANNEL,
	type ConnectionResult,
	CUSTOM_NODES_LIST_CHANNEL,
	CUSTOM_NODES_REMOVE_CHANNEL,
	CUSTOM_NODES_UPDATE_CHANNEL,
	DEBUG_INFO_COPY_CHANNEL,
	EDITOR_DIRECTORY_GET_CHANNEL,
	EDITOR_DIRECTORY_OPEN_CHANNEL,
	isComfyRuntimeState,
	isComfyStartResult,
	isComfyVersionCatalogResult,
	isComfyVersionResult,
	isComfyVersionState,
	isConnectionResult,
	isConnectionSettingsResult,
	isCustomNodeRemoveResult,
	isCustomNodesListResult,
	isDesktopAppInfo,
	isDesktopTheme,
	isDesktopThemeResult,
	isEditorDirectoryResult,
	isModelLibraryListResult,
	isModelLibraryMutationResult,
	isModelProviderFilesResult,
	isModelProviderSettingsResult,
	isServerLogsResult,
	isSyncCompletionNotificationSettingsResult,
	isSyncVerificationResult,
	isWorkerBackendResult,
	isWorkerCustomNodeSyncResult,
	isWorkerModelSyncResult,
	isWorkerSessionSnapshot,
	isWorkerSessionStateChange,
	type KastardApi,
	MENU_OPEN_SETTINGS_CHANNEL,
	MODEL_LIBRARY_ADD_CHANNEL,
	MODEL_LIBRARY_LIST_CHANNEL,
	MODEL_LIBRARY_REMOVE_CHANNEL,
	MODEL_LIBRARY_UPDATE_CHANNEL,
	MODEL_PROVIDER_FILES_CHANNEL,
	MODEL_PROVIDER_SETTINGS_GET_CHANNEL,
	MODEL_PROVIDER_SETTINGS_UPDATE_CHANNEL,
	SYNC_COMPLETION_NOTIFICATION_SETTINGS_GET_CHANNEL,
	SYNC_COMPLETION_NOTIFICATION_SETTINGS_UPDATE_CHANNEL,
	THEME_GET_CHANNEL,
	THEME_UPDATE_CHANNEL,
	WORKER_SESSION_CANCEL_CUSTOM_NODES_CHANNEL,
	WORKER_SESSION_CANCEL_MODELS_CHANNEL,
	WORKER_SESSION_CANCEL_SETUP_CHANNEL,
	WORKER_SESSION_CONNECT_CHANNEL,
	WORKER_SESSION_DISCONNECT_CHANNEL,
	WORKER_SESSION_GET_CHANNEL,
	WORKER_SESSION_INITIALIZE_CHANNEL,
	WORKER_SESSION_PREPARE_BACKEND_CHANNEL,
	WORKER_SESSION_REDOWNLOAD_MODEL_CHANNEL,
	WORKER_SESSION_REINSTALL_CUSTOM_NODE_CHANNEL,
	WORKER_SESSION_REMOVE_CUSTOM_NODE_CHANNEL,
	WORKER_SESSION_RESTART_COMFY_CHANNEL,
	WORKER_SESSION_RETRY_CHANNEL,
	WORKER_SESSION_START_SETUP_CHANNEL,
	WORKER_SESSION_STATE_CHANNEL,
	WORKER_SESSION_SYNC_CUSTOM_NODES_CHANNEL,
	WORKER_SESSION_SYNC_MODELS_CHANNEL,
	WORKER_SESSION_VERIFY_CHANNEL,
} from "../shared/api";

const openSettingsListeners = new Set<() => void>();
let pendingOpenSettings = false;
const initialThemeArgument = process.argv.find((argument) =>
	argument.startsWith("--kastard-theme="),
);
const initialThemeValue = initialThemeArgument?.slice("--kastard-theme=".length);
const initialTheme = isDesktopTheme(initialThemeValue) ? initialThemeValue : "system";

ipcRenderer.on(MENU_OPEN_SETTINGS_CHANNEL, () => {
	if (openSettingsListeners.size === 0) {
		pendingOpenSettings = true;
		return;
	}
	for (const listener of openSettingsListeners) listener();
});

async function invokeConnection(
	channel: string,
	description: string,
	...args: unknown[]
): Promise<ConnectionResult> {
	const result: unknown = await ipcRenderer.invoke(channel, ...args);
	if (!isConnectionResult(result)) {
		throw new Error(`Kastard returned an invalid ${description} result.`);
	}
	return result;
}

const api: KastardApi = {
	appInfo: {
		get: async () => {
			const result: unknown = await ipcRenderer.invoke(APP_INFO_GET_CHANNEL);
			if (!isDesktopAppInfo(result)) {
				throw new Error("Kastard returned invalid application information.");
			}
			return result;
		},
	},
	debugInfo: {
		copy: (text) => invokeConnection(DEBUG_INFO_COPY_CHANNEL, "debug-info copy", text),
	},
	comfy: {
		restart: () => invokeConnection(COMFY_RESTART_CHANNEL, "ComfyUI restart"),
		start: async () => {
			const result: unknown = await ipcRenderer.invoke(COMFY_START_CHANNEL);
			if (!isComfyStartResult(result)) {
				throw new Error("Kastard returned an invalid ComfyUI start result.");
			}
			return result;
		},
		onStateChange: (listener) => {
			const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
				if (isComfyRuntimeState(value)) listener(value);
			};
			ipcRenderer.on(COMFY_STATE_CHANNEL, handler);
			return () => ipcRenderer.off(COMFY_STATE_CHANNEL, handler);
		},
	},
	comfyVersions: {
		getState: async () => {
			const result: unknown = await ipcRenderer.invoke(COMFY_VERSION_GET_CHANNEL);
			if (!isComfyVersionResult(result)) {
				throw new Error("Kastard returned an invalid ComfyUI version state.");
			}
			return result;
		},
		getCatalog: async () => {
			const result: unknown = await ipcRenderer.invoke(COMFY_VERSION_CATALOG_CHANNEL);
			if (!isComfyVersionCatalogResult(result)) {
				throw new Error("Kastard returned an invalid ComfyUI release catalog.");
			}
			return result;
		},
		select: async (request) => {
			const result: unknown = await ipcRenderer.invoke(
				COMFY_VERSION_UPDATE_CHANNEL,
				request,
			);
			if (!isComfyVersionResult(result)) {
				throw new Error("Kastard returned an invalid ComfyUI version state.");
			}
			return result;
		},
		onStateChange: (listener) => {
			const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
				if (isComfyVersionState(value)) listener(value);
			};
			ipcRenderer.on(COMFY_VERSION_STATE_CHANNEL, handler);
			return () => ipcRenderer.off(COMFY_VERSION_STATE_CHANNEL, handler);
		},
	},
	workerSession: {
		getSnapshot: async () => {
			const snapshot: unknown = await ipcRenderer.invoke(WORKER_SESSION_GET_CHANNEL);
			if (!isWorkerSessionSnapshot(snapshot)) {
				throw new Error("Kastard returned an invalid Worker session snapshot.");
			}
			return snapshot;
		},
		retryInitialization: () =>
			invokeConnection(WORKER_SESSION_INITIALIZE_CHANNEL, "Worker initialization"),
		connect: (request) =>
			invokeConnection(WORKER_SESSION_CONNECT_CHANNEL, "Worker connection", request),
		retry: () => invokeConnection(WORKER_SESSION_RETRY_CHANNEL, "Worker retry"),
		disconnect: () =>
			invokeConnection(WORKER_SESSION_DISCONNECT_CHANNEL, "Worker disconnection"),
		prepareBackend: async () => {
			const result: unknown = await ipcRenderer.invoke(
				WORKER_SESSION_PREPARE_BACKEND_CHANNEL,
			);
			if (!isWorkerBackendResult(result)) {
				throw new Error("Kastard returned an invalid Worker backend result.");
			}
			return result;
		},
		startSetup: () =>
			invokeConnection(WORKER_SESSION_START_SETUP_CHANNEL, "Worker setup"),
		cancelSetup: () =>
			invokeConnection(
				WORKER_SESSION_CANCEL_SETUP_CHANNEL,
				"Worker setup cancellation",
			),
		restartComfy: () =>
			invokeConnection(WORKER_SESSION_RESTART_COMFY_CHANNEL, "Worker ComfyUI restart"),
		syncCustomNodes: async () => {
			const result: unknown = await ipcRenderer.invoke(
				WORKER_SESSION_SYNC_CUSTOM_NODES_CHANNEL,
			);
			if (!isWorkerCustomNodeSyncResult(result)) {
				throw new Error("Kastard returned an invalid Worker custom node result.");
			}
			return result;
		},
		reinstallCustomNode: async (request) => {
			const result: unknown = await ipcRenderer.invoke(
				WORKER_SESSION_REINSTALL_CUSTOM_NODE_CHANNEL,
				request,
			);
			if (!isWorkerCustomNodeSyncResult(result)) {
				throw new Error("Kastard returned an invalid Worker custom node result.");
			}
			return result;
		},
		removeCustomNode: async (request) => {
			const result: unknown = await ipcRenderer.invoke(
				WORKER_SESSION_REMOVE_CUSTOM_NODE_CHANNEL,
				request,
			);
			if (!isWorkerCustomNodeSyncResult(result)) {
				throw new Error("Kastard returned an invalid Worker custom node result.");
			}
			return result;
		},
		cancelCustomNodes: async () => {
			const result: unknown = await ipcRenderer.invoke(
				WORKER_SESSION_CANCEL_CUSTOM_NODES_CHANNEL,
			);
			if (!isWorkerCustomNodeSyncResult(result)) {
				throw new Error("Kastard returned an invalid Worker custom node result.");
			}
			return result;
		},
		syncModels: async () => {
			const result: unknown = await ipcRenderer.invoke(
				WORKER_SESSION_SYNC_MODELS_CHANNEL,
			);
			if (!isWorkerModelSyncResult(result)) {
				throw new Error("Kastard returned an invalid Worker model result.");
			}
			return result;
		},
		redownloadModel: async (request) => {
			const result: unknown = await ipcRenderer.invoke(
				WORKER_SESSION_REDOWNLOAD_MODEL_CHANNEL,
				request,
			);
			if (!isWorkerModelSyncResult(result)) {
				throw new Error("Kastard returned an invalid Worker model result.");
			}
			return result;
		},
		cancelModels: async () => {
			const result: unknown = await ipcRenderer.invoke(
				WORKER_SESSION_CANCEL_MODELS_CHANNEL,
			);
			if (!isWorkerModelSyncResult(result)) {
				throw new Error("Kastard returned an invalid Worker model result.");
			}
			return result;
		},
		verify: async () => {
			const result: unknown = await ipcRenderer.invoke(WORKER_SESSION_VERIFY_CHANNEL);
			if (!isSyncVerificationResult(result)) {
				throw new Error("Kastard returned an invalid Worker verification result.");
			}
			return result;
		},
		onStateChange: (listener) => {
			const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
				if (isWorkerSessionStateChange(value)) listener(value);
			};
			ipcRenderer.on(WORKER_SESSION_STATE_CHANNEL, handler);
			return () => ipcRenderer.off(WORKER_SESSION_STATE_CHANNEL, handler);
		},
	},
	connection: {
		getSettings: async () => {
			const result: unknown = await ipcRenderer.invoke(CONNECTION_SETTINGS_GET_CHANNEL);
			if (!isConnectionSettingsResult(result)) {
				throw new Error("Kastard returned invalid connection settings.");
			}
			return result;
		},
		updateSettings: async (settings) => {
			const result: unknown = await ipcRenderer.invoke(
				CONNECTION_SETTINGS_UPDATE_CHANNEL,
				settings,
			);
			if (!isConnectionSettingsResult(result)) {
				throw new Error("Kastard returned invalid connection settings.");
			}
			return result;
		},
		copyServerLogs: (text) =>
			invokeConnection(CONNECTION_COPY_LOGS_CHANNEL, "server-log copy", text),
		getLogs: async () => {
			const result: unknown = await ipcRenderer.invoke(CONNECTION_LOGS_CHANNEL);
			if (!isServerLogsResult(result)) {
				throw new Error("Kastard returned an invalid server-logs result.");
			}
			return result;
		},
	},
	customNodes: {
		list: async () => {
			const result: unknown = await ipcRenderer.invoke(CUSTOM_NODES_LIST_CHANNEL);
			if (!isCustomNodesListResult(result)) {
				throw new Error("Kastard returned an invalid custom-nodes result.");
			}
			return result;
		},
		remove: async (request) => {
			const result: unknown = await ipcRenderer.invoke(
				CUSTOM_NODES_REMOVE_CHANNEL,
				request,
			);
			if (!isCustomNodeRemoveResult(result)) {
				throw new Error("Kastard returned an invalid custom-node removal result.");
			}
			return result;
		},
		update: (request) =>
			invokeConnection(CUSTOM_NODES_UPDATE_CHANNEL, "custom-node sync", request),
	},
	editorDirectories: {
		get: async (directory) => {
			const result: unknown = await ipcRenderer.invoke(
				EDITOR_DIRECTORY_GET_CHANNEL,
				directory,
			);
			if (!isEditorDirectoryResult(result)) {
				throw new Error("Kastard returned an invalid Editor directory result.");
			}
			return result;
		},
		open: (directory) =>
			invokeConnection(
				EDITOR_DIRECTORY_OPEN_CHANNEL,
				"Editor directory open",
				directory,
			),
	},
	menu: {
		onOpenSettings: (listener) => {
			openSettingsListeners.add(listener);
			if (pendingOpenSettings) {
				pendingOpenSettings = false;
				listener();
			}
			return () => openSettingsListeners.delete(listener);
		},
	},
	theme: {
		initial: initialTheme,
		get: async () => {
			const result: unknown = await ipcRenderer.invoke(THEME_GET_CHANNEL);
			if (!isDesktopThemeResult(result)) {
				throw new Error("Kastard returned an invalid desktop theme result.");
			}
			return result;
		},
		update: async (theme) => {
			const result: unknown = await ipcRenderer.invoke(THEME_UPDATE_CHANNEL, theme);
			if (!isDesktopThemeResult(result)) {
				throw new Error("Kastard returned an invalid desktop theme result.");
			}
			return result;
		},
	},
	syncCompletionNotification: {
		getSettings: async () => {
			const result: unknown = await ipcRenderer.invoke(
				SYNC_COMPLETION_NOTIFICATION_SETTINGS_GET_CHANNEL,
			);
			if (!isSyncCompletionNotificationSettingsResult(result)) {
				throw new Error(
					"Kastard returned invalid sync completion notification settings.",
				);
			}
			return result;
		},
		updateSettings: async (settings) => {
			const result: unknown = await ipcRenderer.invoke(
				SYNC_COMPLETION_NOTIFICATION_SETTINGS_UPDATE_CHANNEL,
				settings,
			);
			if (!isSyncCompletionNotificationSettingsResult(result)) {
				throw new Error(
					"Kastard returned invalid sync completion notification settings.",
				);
			}
			return result;
		},
	},
	models: {
		list: async () => {
			const result: unknown = await ipcRenderer.invoke(MODEL_LIBRARY_LIST_CHANNEL);
			if (!isModelLibraryListResult(result)) {
				throw new Error("Kastard returned an invalid model-library result.");
			}
			return result;
		},
		add: async (input) => {
			const result: unknown = await ipcRenderer.invoke(
				MODEL_LIBRARY_ADD_CHANNEL,
				input,
			);
			if (!isModelLibraryMutationResult(result)) {
				throw new Error("Kastard returned an invalid model-library mutation.");
			}
			return result;
		},
		update: async (request) => {
			const result: unknown = await ipcRenderer.invoke(
				MODEL_LIBRARY_UPDATE_CHANNEL,
				request,
			);
			if (!isModelLibraryMutationResult(result)) {
				throw new Error("Kastard returned an invalid model-library mutation.");
			}
			return result;
		},
		remove: async (request) => {
			const result: unknown = await ipcRenderer.invoke(
				MODEL_LIBRARY_REMOVE_CHANNEL,
				request,
			);
			if (!isModelLibraryMutationResult(result)) {
				throw new Error("Kastard returned an invalid model-library mutation.");
			}
			return result;
		},
		resolveFiles: async (request) => {
			const result: unknown = await ipcRenderer.invoke(
				MODEL_PROVIDER_FILES_CHANNEL,
				request,
			);
			if (!isModelProviderFilesResult(result)) {
				throw new Error("Kastard returned invalid model-provider files.");
			}
			return result;
		},
	},
	modelProviders: {
		getSettings: async () => {
			const result: unknown = await ipcRenderer.invoke(
				MODEL_PROVIDER_SETTINGS_GET_CHANNEL,
			);
			if (!isModelProviderSettingsResult(result)) {
				throw new Error("Kastard returned invalid model-provider settings.");
			}
			return result;
		},
		updateToken: async (request) => {
			const result: unknown = await ipcRenderer.invoke(
				MODEL_PROVIDER_SETTINGS_UPDATE_CHANNEL,
				request,
			);
			if (!isModelProviderSettingsResult(result)) {
				throw new Error("Kastard returned invalid model-provider settings.");
			}
			return result;
		},
	},
};

contextBridge.exposeInMainWorld("kastard", api);
