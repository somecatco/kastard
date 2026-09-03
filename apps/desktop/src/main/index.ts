import { mkdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	Notification,
	nativeTheme,
	safeStorage,
	session,
	shell,
} from "electron";
import {
	APP_INFO_GET_CHANNEL,
	type BackendTarget,
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
	type CustomNodeRemoveResult,
	DEBUG_INFO_COPY_CHANNEL,
	EDITOR_DIRECTORY_GET_CHANNEL,
	EDITOR_DIRECTORY_OPEN_CHANNEL,
	type EditorDirectory,
	isComfyVersionUpdate,
	isConnectionRequest,
	isConnectionSettings,
	isCustomNodeRemoveRequest,
	isCustomNodeUpdateRequest,
	isDesktopTheme,
	isEditorDirectory,
	isModelLibraryInput,
	isModelLibraryRemoveRequest,
	isModelLibraryUpdateRequest,
	isModelProviderFilesRequest,
	isModelProviderTokenUpdate,
	isSyncCompletionNotificationSettings,
	isWorkerCustomNodeReinstallRequest,
	isWorkerCustomNodeRemovalRequest,
	isWorkerModelRedownloadRequest,
	MODEL_LIBRARY_ADD_CHANNEL,
	MODEL_LIBRARY_LIST_CHANNEL,
	MODEL_LIBRARY_REMOVE_CHANNEL,
	MODEL_LIBRARY_UPDATE_CHANNEL,
	MODEL_PROVIDER_FILES_CHANNEL,
	MODEL_PROVIDER_SETTINGS_GET_CHANNEL,
	MODEL_PROVIDER_SETTINGS_UPDATE_CHANNEL,
	type ModelProvider,
	SYNC_COMPLETION_NOTIFICATION_SETTINGS_GET_CHANNEL,
	SYNC_COMPLETION_NOTIFICATION_SETTINGS_UPDATE_CHANNEL,
	type SyncVerificationRequest,
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
import { readDesktopAppInfo } from "./app-info";
import { installAppMenu } from "./app-menu";
import { ComfyGateway } from "./comfy-gateway/gateway";
import { ComfyGatewayPortStore } from "./comfy-gateway/port-store";
import { ComfyGatewayRequestError } from "./comfy-gateway/worker-port";
import { ComfyReleaseCatalog } from "./comfy-release-catalog";
import { ComfyRuntime, readManagerVersion } from "./comfy-runtime";
import { ComfySourceInstaller } from "./comfy-source-installer";
import { ComfyVersionStore } from "./comfy-version-store";
import { ComfyVersions } from "./comfy-versions";
import { IpcHandlerRegistry } from "./ipc-handler-registry";
import { ModelLibrary } from "./model-library";
import {
	modelArtifactsEqual,
	resolveModelProviderInfo,
	verifyModelProviderArtifact,
} from "./model-provider";
import { ModelProviderTokenStore } from "./model-provider-settings";
import { ThemeStore } from "./theme-store";
import { readWorkerBackendTarget } from "./worker/backend-target";
import { ConnectionPreferencesStore } from "./worker/connection-store";
import { CustomNodeSyncStore } from "./worker/custom-node-sync-store";
import { WorkerSession } from "./worker/session/worker-session";
import { SyncCompletionNotificationSettingsStore } from "./worker/sync-completion-notification-settings";
import { SyncCompletionNotifier } from "./worker/sync-completion-notifier";
import {
	type CustomNodeSyncPlan,
	createCustomNodeSyncPlan,
	createModelSyncPlan,
	createModelSyncTargets,
} from "./worker/sync-plan";
import { WorkerWorkflowSubmissionError } from "./worker/workflow-actor";
import { openWorkerWorkflowEvents } from "./worker/workflow-events";
import { WorkflowInputSnapshotStore } from "./worker/workflow-input-snapshot";
import { WorkflowResultStore } from "./worker/workflow-result-store";

let comfyRuntime: ComfyRuntime | null = null;
let comfyRestartQueue: Promise<unknown> = Promise.resolve();
let comfyManualRestartPromise: Promise<string | null> | null = null;
let comfyVersions: ComfyVersions | null = null;
let comfyGateway: ComfyGateway | null = null;
let comfyGatewayPortError: string | null = null;
let workerSession: WorkerSession | null = null;
let customNodeSync: CustomNodeSyncStore | null = null;
let modelLibrary: ModelLibrary | null = null;
let modelProviderTokens: ModelProviderTokenStore | null = null;
let themeStore: ThemeStore | null = null;
let syncCompletionNotificationSettings: SyncCompletionNotificationSettingsStore | null =
	null;
let syncCompletionNotifier: SyncCompletionNotifier | null = null;
let modelLibraryError: string | null = null;
let modelProviderSettingsError: string | null = null;
let themeSettingsError: string | null = null;
let syncCompletionNotificationSettingsError: string | null = null;
let customNodeSyncError: string | null = null;
let customNodeDeletionActive = false;
const ipcHandlers = new IpcHandlerRegistry(ipcMain);

function enqueueComfyRuntimeRestart(): Promise<string | null> {
	const restart = comfyRestartQueue
		.catch(() => undefined)
		.then(async () => {
			assertCustomNodeDeletionInactive();
			const runtime = comfyRuntime;
			const gateway = comfyGateway;
			if (runtime === null || gateway === null) return null;
			if (comfyGatewayPortError !== null) throw new Error(comfyGatewayPortError);
			await gateway.start();
			if (comfyRuntime !== runtime || comfyGateway !== gateway) return null;
			assertCustomNodeDeletionInactive();
			return runtime.restart();
		});
	comfyRestartQueue = restart;
	return restart;
}

function assertCustomNodeDeletionInactive(): void {
	if (customNodeDeletionActive) {
		throw new Error(
			"ComfyUI cannot start or restart while a custom-node deletion is in progress.",
		);
	}
}

function restartComfyRuntimeManually(): Promise<string | null> {
	if (comfyManualRestartPromise !== null) return comfyManualRestartPromise;
	const restart = enqueueComfyRuntimeRestart().finally(() => {
		if (comfyManualRestartPromise === restart) comfyManualRestartPromise = null;
	});
	comfyManualRestartPromise = restart;
	return restart;
}
let unsubscribeComfy: (() => void) | null = null;
let comfyVersionsError: string | null = null;
let unsubscribeComfyVersions: (() => void) | null = null;
let unsubscribeWorkerSession: (() => void) | null = null;
const E2E_HIDDEN_WINDOW = process.env.KASTARD_E2E_HIDDEN_WINDOW === "1";
const DARK_WINDOW_BACKGROUND = "#111314";
const LIGHT_WINDOW_BACKGROUND = "#ffffff";

if (process.env.KASTARD_E2E_USER_DATA_DIR) {
	mkdirSync(process.env.KASTARD_E2E_USER_DATA_DIR, { recursive: true });
	app.setPath("userData", process.env.KASTARD_E2E_USER_DATA_DIR);
}

function resourceRoot(name: string): string {
	return app.isPackaged
		? join(process.resourcesPath, name)
		: join(app.getAppPath(), "resources", name);
}

function readModelProviderToken(provider: ModelProvider): string | null {
	return modelProviderSettingsError
		? null
		: (modelProviderTokens?.getToken(provider) ?? null);
}

async function initializeComfyVersions(
	bundledBackendTarget: BackendTarget | null,
	bundledBackendTargetError: string | undefined,
): Promise<string | null> {
	// Without a packaged manifest there is nothing to fall back to, so version selection
	// stays off while the runtime keeps running whatever is on disk.
	if (bundledBackendTarget === null) {
		return bundledBackendTargetError ?? "The bundled ComfyUI manifest is unavailable.";
	}
	try {
		const store = new ComfyVersionStore(
			join(app.getPath("userData"), "comfy-version.json"),
		);
		await store.initialize();
		const bundled = {
			backend: bundledBackendTarget,
			frontend: await readBundledFrontendRelease(),
		};
		const catalog = new ComfyReleaseCatalog({
			path: join(app.getPath("userData"), "comfy-release-catalog.json"),
			getBundled: () => bundled,
		});
		await catalog.initialize();
		const installer = new ComfySourceInstaller({
			rootDirectory: join(app.getPath("userData"), "comfy-sources"),
		});
		await installer.initialize();
		const bundledBackendDirectory = join(resourceRoot("comfyui-runtime"), "backend");
		comfyVersions = new ComfyVersions({
			store,
			catalog,
			installer,
			bundled,
			bundledBackendDirectory,
			bundledManagerVersion: await readManagerVersion(bundledBackendDirectory),
			bundledBackendTarget,
			restartRuntime: enqueueComfyRuntimeRestart,
			onBackendTargetChange: () => workerSession?.refreshEditorComfyVersion(),
			onManagerTargetChange: () => workerSession?.refreshEditorCustomNodeTarget(),
		});
		await comfyVersions.initialize();
		return null;
	} catch (error) {
		comfyVersions = null;
		return errorMessage(error);
	}
}

async function readBundledFrontendRelease(): Promise<{
	version: string;
	archiveUrl: string;
}> {
	const raw = await readFile(
		join(resourceRoot("comfyui-frontend"), ".kastard-source.json"),
		"utf8",
	);
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("version" in parsed) ||
		typeof parsed.version !== "string" ||
		!("archiveUrl" in parsed) ||
		typeof parsed.archiveUrl !== "string"
	) {
		throw new Error("Invalid packaged ComfyUI frontend manifest.");
	}
	return { version: parsed.version, archiveUrl: parsed.archiveUrl };
}

async function buildCustomNodeSyncPlan(): Promise<CustomNodeSyncPlan> {
	if (customNodeDeletionActive) {
		throw new Error("Custom nodes cannot sync while a local deletion is in progress.");
	}
	if (customNodeSyncError) throw new Error(customNodeSyncError);
	if (comfyRuntime === null) throw new Error("The ComfyUI runtime is unavailable.");
	if (customNodeSync === null) {
		throw new Error("Custom-node sync settings are unavailable.");
	}
	const syncStore = customNodeSync;
	const entries = await comfyRuntime.listCustomNodes();
	const managerVersion =
		comfyVersions?.getManagerVersion() ?? (await comfyRuntime.getManagerVersion());
	const selected = await Promise.all(
		entries.map(async (node) => ({ ...node, sync: await syncStore.get(node.name) })),
	);
	return createCustomNodeSyncPlan(selected, managerVersion);
}

async function buildModelSyncPlan() {
	if (modelLibraryError) throw new Error(modelLibraryError);
	if (modelProviderSettingsError) throw new Error(modelProviderSettingsError);
	if (modelLibrary === null || modelProviderTokens === null) {
		throw new Error("Model synchronization settings are unavailable.");
	}
	return createModelSyncPlan(modelLibrary.list(), {
		huggingface: modelProviderTokens.getToken("huggingface"),
		civitai: modelProviderTokens.getToken("civitai"),
	});
}

async function buildSyncVerificationRequest(
	backendVersion: string,
): Promise<SyncVerificationRequest> {
	if (modelLibraryError) throw new Error(modelLibraryError);
	if (modelLibrary === null) {
		throw new Error("Model synchronization settings are unavailable.");
	}
	const customNodes = await buildCustomNodeSyncPlan();
	return {
		backendVersion,
		models: createModelSyncTargets(modelLibrary.list()),
		customNodes: {
			...customNodes,
			unsupportedNodes: customNodes.unsupportedNodes.map(({ name }) => name),
		},
	};
}

function windowBackgroundColor(): string {
	const theme = currentDesktopTheme();
	return theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors)
		? DARK_WINDOW_BACKGROUND
		: LIGHT_WINDOW_BACKGROUND;
}

function currentDesktopTheme() {
	return themeSettingsError ? "system" : (themeStore?.get() ?? "system");
}

function syncWindowBackgrounds(): void {
	const backgroundColor = windowBackgroundColor();
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.setBackgroundColor(backgroundColor);
	}
}

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 900,
		minHeight: 600,
		show: false,
		backgroundColor: windowBackgroundColor(),
		...(process.platform === "darwin"
			? {
					titleBarStyle: "hiddenInset" as const,
					trafficLightPosition: { x: 16, y: 16 },
				}
			: {}),
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			additionalArguments: [`--kastard-theme=${currentDesktopTheme()}`],
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			backgroundThrottling: !E2E_HIDDEN_WINDOW,
		},
	});

	window.once("ready-to-show", () => {
		if (E2E_HIDDEN_WINDOW) return;
		window.show();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("https://") || url.startsWith("http://")) {
			void shell.openExternal(url);
		}
		return { action: "deny" };
	});
	window.webContents.on("will-frame-navigate", (details) => {
		if (details.isMainFrame) return;
		if (details.url === "" || details.url === "about:blank") return;
		const runtimeUrl = comfyGateway?.getUrl();
		if (runtimeUrl === null || runtimeUrl === undefined) {
			details.preventDefault();
			return;
		}
		try {
			if (new URL(details.url).origin !== new URL(runtimeUrl).origin) {
				details.preventDefault();
			}
		} catch {
			details.preventDefault();
		}
	});
	window.webContents.on("will-prevent-unload", (event) => {
		const choice = dialog.showMessageBoxSync(window, {
			type: "warning",
			buttons: ["Cancel", "Close Anyway"],
			defaultId: 0,
			cancelId: 0,
			title: "Unsaved Changes",
			message: "You have unsaved changes.",
			detail: "Close the window anyway?",
		});
		if (choice === 1) event.preventDefault();
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		void window.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void window.loadFile(join(__dirname, "../renderer/index.html"));
	}

	return window;
}

app.whenReady().then(async () => {
	ipcHandlers.handle(APP_INFO_GET_CHANNEL, () => readDesktopAppInfo());
	ipcHandlers.handle(DEBUG_INFO_COPY_CHANNEL, (_event, text: unknown) => {
		if (typeof text !== "string" || text.length === 0) {
			return { ok: false, error: "No debug information is available to copy." };
		}
		try {
			clipboard.writeText(text);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: `Could not copy debug information. ${errorMessage(error)}`,
			};
		}
	});
	themeStore = new ThemeStore(join(app.getPath("userData"), "theme.json"));
	try {
		await themeStore.initialize();
	} catch (error) {
		themeSettingsError = errorMessage(error);
	}
	nativeTheme.on("updated", syncWindowBackgrounds);
	ipcHandlers.handle(THEME_GET_CHANNEL, () =>
		themeSettingsError
			? { ok: false, error: themeSettingsError }
			: { ok: true, theme: themeStore?.get() ?? "system" },
	);
	ipcHandlers.handle(THEME_UPDATE_CHANNEL, async (_event, theme: unknown) => {
		if (!isDesktopTheme(theme)) return { ok: false, error: "Invalid desktop theme." };
		if (themeStore === null) {
			return { ok: false, error: "Desktop theme settings are unavailable." };
		}
		try {
			await themeStore.update(theme);
			themeSettingsError = null;
			syncWindowBackgrounds();
			return { ok: true, theme };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	syncCompletionNotificationSettings = new SyncCompletionNotificationSettingsStore(
		join(app.getPath("userData"), "sync-completion-notification.json"),
	);
	try {
		await syncCompletionNotificationSettings.initialize();
	} catch (error) {
		syncCompletionNotificationSettingsError = errorMessage(error);
	}
	ipcHandlers.handle(SYNC_COMPLETION_NOTIFICATION_SETTINGS_GET_CHANNEL, () =>
		syncCompletionNotificationSettingsError
			? { ok: false, error: syncCompletionNotificationSettingsError }
			: {
					ok: true,
					settings: syncCompletionNotificationSettings?.get() ?? { enabled: true },
				},
	);
	ipcHandlers.handle(
		SYNC_COMPLETION_NOTIFICATION_SETTINGS_UPDATE_CHANNEL,
		async (_event, settings: unknown) => {
			if (!isSyncCompletionNotificationSettings(settings)) {
				return { ok: false, error: "Invalid sync completion notification settings." };
			}
			if (syncCompletionNotificationSettings === null) {
				return {
					ok: false,
					error: "Sync completion notification settings are unavailable.",
				};
			}
			try {
				await syncCompletionNotificationSettings.update(settings);
				syncCompletionNotificationSettingsError = null;
				return { ok: true, settings: syncCompletionNotificationSettings.get() };
			} catch (error) {
				return { ok: false, error: errorMessage(error) };
			}
		},
	);
	syncCompletionNotifier = new SyncCompletionNotifier(
		() =>
			syncCompletionNotificationSettingsError === null &&
			(syncCompletionNotificationSettings?.get().enabled ?? true),
		() => {
			if (E2E_HIDDEN_WINDOW || !Notification.isSupported()) return;
			new Notification({
				title: "Worker setup complete",
				body: "Synchronization completed and Worker ComfyUI is ready.",
				silent: false,
			}).show();
		},
	);
	modelProviderTokens = new ModelProviderTokenStore(
		join(app.getPath("userData"), "model-provider-settings.json"),
		safeStorage,
	);
	try {
		await modelProviderTokens.initialize();
	} catch (error) {
		modelProviderSettingsError = errorMessage(error);
	}
	customNodeSync = new CustomNodeSyncStore(
		join(app.getPath("userData"), "custom-node-sync.json"),
	);
	try {
		await customNodeSync.initialize();
	} catch (error) {
		customNodeSyncError = errorMessage(error);
	}
	modelLibrary = new ModelLibrary(join(app.getPath("userData"), "kastard.sqlite"));
	try {
		await modelLibrary.initialize();
	} catch (error) {
		modelLibraryError = errorMessage(error);
	}
	const comfyDataDirectory =
		(E2E_HIDDEN_WINDOW && process.env.KASTARD_E2E_COMFY_DATA_DIR) ||
		join(app.getPath("userData"), "comfy");
	const editorDirectories: Record<EditorDirectory, string> = {
		comfy: join(comfyDataDirectory, "data"),
		"custom-nodes": join(comfyDataDirectory, "data", "custom_nodes"),
		"model-library": join(comfyDataDirectory, "virtual-models"),
	};
	comfyRuntime = new ComfyRuntime({
		resourcesDirectory: resourceRoot("comfyui-runtime"),
		frontendDirectory: resourceRoot("comfyui-frontend"),
		dataDirectory: comfyDataDirectory,
		getModels: () => (modelLibraryError ? [] : (modelLibrary?.list() ?? [])),
		resolveBackend: async () => comfyVersions?.resolveBackend() ?? null,
		resolveFrontend: async () => comfyVersions?.resolveFrontend() ?? null,
		selectedBackendDirectory: async () =>
			comfyVersions?.selectedBackendDirectory() ?? null,
		resolveManagerVersion: (backendDirectory) =>
			comfyVersions?.getRuntimeManagerVersion() ?? readManagerVersion(backendDirectory),
		trashItem: (path) => shell.trashItem(path),
	});
	const backendTargetPath = app.isPackaged
		? join(resourceRoot("comfyui-runtime"), ".kastard-source.json")
		: join(app.getAppPath(), "../../vendor/comfyui-backend.json");
	let backendTarget: Awaited<ReturnType<typeof readWorkerBackendTarget>> | null = null;
	let backendTargetError: string | undefined;
	try {
		backendTarget = await readWorkerBackendTarget(backendTargetPath);
	} catch (error) {
		backendTargetError = errorMessage(error);
	}
	comfyVersionsError = await initializeComfyVersions(backendTarget, backendTargetError);
	const getBackendTarget = (): typeof backendTarget =>
		comfyVersions === null ? backendTarget : comfyVersions.getBackendTarget();
	const getBackendTargetError = (): string | undefined =>
		comfyVersions === null ? backendTargetError : comfyVersions.getBackendTargetError();
	const workflowInputs = new WorkflowInputSnapshotStore({
		dataDirectory: comfyDataDirectory,
		rootDirectory: join(app.getPath("userData"), "workflow-input-snapshots"),
		getRuntimeUrl: () => comfyRuntime?.getUrl() ?? null,
	});
	await workflowInputs.initialize();
	const workflowResults = new WorkflowResultStore(
		join(comfyDataDirectory, "data", "output", "kastard"),
		join(app.getPath("userData"), "workflow-results"),
	);
	await workflowResults.initialize();
	const comfyGatewayPort = new ComfyGatewayPortStore(
		join(app.getPath("userData"), "comfy-gateway.json"),
	);
	try {
		await comfyGatewayPort.initialize();
	} catch (error) {
		comfyGatewayPortError = errorMessage(error);
	}
	const savedComfyGatewayPort = comfyGatewayPort.get();
	comfyGateway = new ComfyGateway({
		...(savedComfyGatewayPort === null
			? { persistPort: (port) => comfyGatewayPort.update(port) }
			: { listenPort: savedComfyGatewayPort }),
		getUpstreamUrl: () => comfyRuntime?.getUrl() ?? null,
		isWorkerConnected: () =>
			workerSession?.getState().connection.status === "connected",
		freeWorkerMemory: async (request) => {
			if (workerSession === null)
				throw new Error("The Worker connection is unavailable.");
			const result = await workerSession.freeComfyMemory(request);
			if (!result.ok) throw new Error(result.error);
		},
		getQueue: () => workerSession?.getWorkflowQueue() ?? { running: [], pending: [] },
		updateQueue: (mutation) => {
			try {
				if ("clear" in mutation) workerSession?.clearPendingWorkflows();
				else workerSession?.deletePendingWorkflows(mutation.delete);
			} catch (error) {
				throw mapWorkerWorkflowError(error);
			}
		},
		cancelCurrent: () => {
			try {
				return workerSession?.cancelCurrentWorkflow() ?? null;
			} catch (error) {
				throw mapWorkerWorkflowError(error);
			}
		},
		getHistory: () => workflowResults.list(),
		getHistoryJob: (jobId) => workflowResults.get(jobId),
		updateHistory: (mutation) =>
			"clear" in mutation
				? workflowResults.clearHistory()
				: workflowResults.deleteHistory(mutation.delete),
		submitPrompt: async (prompt, clientId, extraData) => {
			if (workerSession === null) {
				throw new ComfyGatewayRequestError(
					"Worker workflow execution is unavailable.",
					409,
				);
			}
			try {
				return await workerSession.submitWorkflow(prompt, clientId, extraData);
			} catch (error) {
				throw mapWorkerWorkflowError(error);
			}
		},
	});
	session.defaultSession.webRequest.onBeforeSendHeaders(
		{ urls: ["http://127.0.0.1:*/*"] },
		(details, callback) => {
			const runtimeUrl = comfyGateway?.getUrl();
			if (
				details.resourceType !== "subFrame" ||
				runtimeUrl === null ||
				runtimeUrl === undefined ||
				!sameOrigin(details.url, runtimeUrl)
			) {
				callback({ requestHeaders: details.requestHeaders });
				return;
			}
			const requestHeaders = { ...details.requestHeaders };
			for (const header of Object.keys(requestHeaders)) {
				if (header.toLowerCase() === "sec-fetch-site") delete requestHeaders[header];
			}
			callback({ requestHeaders });
		},
	);
	ipcHandlers.handle(COMFY_START_CHANNEL, async () => {
		const runtime = comfyRuntime;
		let runtimeStartAttempted = false;
		try {
			assertCustomNodeDeletionInactive();
			if (comfyGatewayPortError !== null) throw new Error(comfyGatewayPortError);
			const gatewayUrl = await comfyGateway?.start();
			assertCustomNodeDeletionInactive();
			runtimeStartAttempted = runtime !== null;
			const runtimeUrl = await runtime?.start();
			return gatewayUrl === undefined || runtimeUrl === undefined
				? { ok: false, error: "ComfyUI runtime is unavailable." }
				: { ok: true, url: gatewayUrl };
		} catch (error) {
			const state = runtimeStartAttempted ? runtime?.getState() : undefined;
			return {
				ok: false,
				error: errorMessage(error),
				...(state?.status === "error" && state.reason !== undefined
					? { reason: state.reason }
					: {}),
			};
		}
	});
	ipcHandlers.handle(COMFY_RESTART_CHANNEL, () => {
		if (comfyRuntime === null) {
			return { ok: false, error: "The ComfyUI runtime is unavailable." };
		}
		return restartComfyRuntimeManually().then(
			(url): ConnectionResult =>
				url === null
					? { ok: false, error: "The ComfyUI runtime is unavailable." }
					: { ok: true },
			(error: unknown): ConnectionResult => ({
				ok: false,
				error: errorMessage(error),
			}),
		);
	});
	unsubscribeComfy = comfyRuntime.subscribe((state) => {
		const gatewayUrl = comfyGateway?.getUrl();
		const visibleState =
			state.status === "ready" && gatewayUrl !== null && gatewayUrl !== undefined
				? { ...state, url: gatewayUrl }
				: state;
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed())
				window.webContents.send(COMFY_STATE_CHANNEL, visibleState);
		}
	});
	ipcHandlers.handle(COMFY_VERSION_GET_CHANNEL, () =>
		comfyVersions === null
			? { ok: false, error: comfyVersionsError ?? "ComfyUI versions are unavailable." }
			: { ok: true, state: comfyVersions.getState() },
	);
	ipcHandlers.handle(COMFY_VERSION_CATALOG_CHANNEL, async () => {
		if (comfyVersions === null) {
			return {
				ok: false,
				error: comfyVersionsError ?? "ComfyUI versions are unavailable.",
			};
		}
		try {
			return { ok: true, catalog: await comfyVersions.listCatalog() };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	ipcHandlers.handle(COMFY_VERSION_UPDATE_CHANNEL, async (_event, request: unknown) => {
		if (!isComfyVersionUpdate(request)) {
			return { ok: false, error: "Invalid ComfyUI version selection." };
		}
		if (comfyVersions === null) {
			return {
				ok: false,
				error: comfyVersionsError ?? "ComfyUI versions are unavailable.",
			};
		}
		try {
			assertCustomNodeDeletionInactive();
			return { ok: true, state: await comfyVersions.select(request) };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	unsubscribeComfyVersions =
		comfyVersions?.subscribe((state) => {
			for (const window of BrowserWindow.getAllWindows()) {
				if (!window.isDestroyed())
					window.webContents.send(COMFY_VERSION_STATE_CHANNEL, state);
			}
		}) ?? null;
	ipcHandlers.handle(CUSTOM_NODES_LIST_CHANNEL, async () => {
		if (customNodeSyncError) return { ok: false, error: customNodeSyncError };
		if (comfyRuntime === null) {
			return { ok: false, error: "The ComfyUI runtime is unavailable." };
		}
		const syncStore = customNodeSync;
		if (syncStore === null) {
			return { ok: false, error: "Custom-node sync settings are unavailable." };
		}
		try {
			const nodes = await Promise.all(
				(await comfyRuntime.listCustomNodes()).map(async (node) => ({
					...node,
					sync: await syncStore.get(node.name),
				})),
			);
			return { ok: true, nodes };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	ipcHandlers.handle(CUSTOM_NODES_UPDATE_CHANNEL, async (_event, request: unknown) => {
		if (!isCustomNodeUpdateRequest(request)) {
			return { ok: false, error: "Invalid custom-node sync update." };
		}
		if (customNodeDeletionActive) {
			return {
				ok: false,
				error: "Custom-node sync settings cannot change during deletion.",
			};
		}
		if (customNodeSyncError) return { ok: false, error: customNodeSyncError };
		if (customNodeSync === null) {
			return { ok: false, error: "Custom-node sync settings are unavailable." };
		}
		try {
			await customNodeSync.update(request.name, request.sync);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	ipcHandlers.handle(CUSTOM_NODES_REMOVE_CHANNEL, async (_event, request: unknown) => {
		if (!isCustomNodeRemoveRequest(request)) {
			return { ok: false, error: "Invalid custom-node removal request." };
		}
		if (customNodeDeletionActive) {
			return { ok: false, error: "Another custom-node deletion is in progress." };
		}
		if (customNodeSyncError) return { ok: false, error: customNodeSyncError };
		const runtime = comfyRuntime;
		const syncStore = customNodeSync;
		if (runtime === null) {
			return { ok: false, error: "The ComfyUI runtime is unavailable." };
		}
		if (syncStore === null) {
			return { ok: false, error: "Custom-node sync settings are unavailable." };
		}
		const workerCustomNodes = workerSession?.getState().customNodes;
		if (
			workerCustomNodes?.status === "loading" ||
			workerCustomNodes?.status === "syncing" ||
			workerCustomNodes?.status === "canceling"
		) {
			return {
				ok: false,
				error: "Custom nodes cannot be removed during Worker synchronization.",
			};
		}

		customNodeDeletionActive = true;
		let response: CustomNodeRemoveResult;
		let previousSync: boolean | undefined;
		let selectionRemoved = false;
		try {
			previousSync = await syncStore.remove(request.name);
			selectionRemoved = true;
			const result = await runtime.removeCustomNode(request.name);
			response = { ok: true, restartRequired: result.restartRequired };
		} catch (error) {
			let message = errorMessage(error);
			if (selectionRemoved && previousSync !== undefined) {
				try {
					await syncStore.update(request.name, previousSync);
				} catch (restoreError) {
					message = `Custom-node removal failed and its sync setting could not be restored. Removal: ${message} Restore: ${errorMessage(restoreError)}`;
				}
			}
			response = { ok: false, error: message };
		} finally {
			customNodeDeletionActive = false;
		}
		if (response.ok) workerSession?.refreshEditorCustomNodeTarget();
		return response;
	});
	ipcHandlers.handle(EDITOR_DIRECTORY_GET_CHANNEL, (_event, directory: unknown) => {
		if (!isEditorDirectory(directory)) {
			return { ok: false, error: "Invalid Editor directory." };
		}
		return { ok: true, path: editorDirectories[directory] };
	});
	ipcHandlers.handle(
		EDITOR_DIRECTORY_OPEN_CHANNEL,
		async (_event, directory: unknown) => {
			if (!isEditorDirectory(directory)) {
				return { ok: false, error: "Invalid Editor directory." };
			}
			try {
				const path = editorDirectories[directory];
				await mkdir(path, { recursive: true });
				const openError = await shell.openPath(path);
				return openError.length === 0
					? { ok: true }
					: { ok: false, error: `Could not open the folder. ${openError}` };
			} catch (error) {
				return {
					ok: false,
					error: `Could not open the folder. ${errorMessage(error)}`,
				};
			}
		},
	);
	ipcHandlers.handle(MODEL_LIBRARY_LIST_CHANNEL, () => {
		if (modelLibraryError) return { ok: false, error: modelLibraryError };
		try {
			return { ok: true, models: modelLibrary?.list() ?? [] };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	ipcHandlers.handle(MODEL_PROVIDER_FILES_CHANNEL, async (_event, request: unknown) => {
		if (!isModelProviderFilesRequest(request)) {
			return { ok: false, error: "Invalid model-provider file request." };
		}
		try {
			const info = await resolveModelProviderInfo(
				request.sourceUrl,
				readModelProviderToken,
			);
			return { ok: true, ...info };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	ipcHandlers.handle(MODEL_LIBRARY_ADD_CHANNEL, async (_event, input: unknown) => {
		if (!isModelLibraryInput(input)) {
			return { ok: false, error: "Invalid model-library input." };
		}
		if (modelLibraryError) return { ok: false, error: modelLibraryError };
		try {
			await verifyModelProviderArtifact(
				input.sourceUrl,
				input.artifact,
				readModelProviderToken,
			);
			const model = await modelLibrary?.add(
				input,
				(models) => comfyRuntime?.syncModels(models) ?? Promise.resolve(),
			);
			if (!model) return unavailableModelLibrary();
			workerSession?.refreshEditorModelTarget();
			return { ok: true, model };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	ipcHandlers.handle(MODEL_LIBRARY_UPDATE_CHANNEL, async (_event, request: unknown) => {
		if (!isModelLibraryUpdateRequest(request)) {
			return { ok: false, error: "Invalid model-library update." };
		}
		if (modelLibraryError) return { ok: false, error: modelLibraryError };
		try {
			const previous = modelLibrary?.list().find((model) => model.id === request.id);
			if (
				previous === undefined ||
				previous.sourceUrl !== request.input.sourceUrl ||
				!modelArtifactsEqual(previous.artifact, request.input.artifact)
			) {
				await verifyModelProviderArtifact(
					request.input.sourceUrl,
					request.input.artifact,
					readModelProviderToken,
				);
			}
			const model = await modelLibrary?.update(
				request.id,
				request.input,
				(models) => comfyRuntime?.syncModels(models) ?? Promise.resolve(),
			);
			if (!model) return unavailableModelLibrary();
			workerSession?.refreshEditorModelTarget();
			return { ok: true, model };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	ipcHandlers.handle(MODEL_LIBRARY_REMOVE_CHANNEL, async (_event, request: unknown) => {
		if (!isModelLibraryRemoveRequest(request)) {
			return { ok: false, error: "Invalid model-library removal." };
		}
		if (modelLibraryError) return { ok: false, error: modelLibraryError };
		try {
			const model = await modelLibrary?.remove(
				request.id,
				(models) => comfyRuntime?.syncModels(models) ?? Promise.resolve(),
			);
			if (!model) return unavailableModelLibrary();
			workerSession?.refreshEditorModelTarget();
			return { ok: true, model };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	});
	ipcHandlers.handle(MODEL_PROVIDER_SETTINGS_GET_CHANNEL, () =>
		modelProviderSettingsError
			? { ok: false, error: modelProviderSettingsError }
			: {
					ok: true,
					configured: modelProviderTokens?.getSettings() ?? {
						huggingface: false,
						civitai: false,
					},
				},
	);
	ipcHandlers.handle(
		MODEL_PROVIDER_SETTINGS_UPDATE_CHANNEL,
		async (_event, request: unknown) => {
			if (!isModelProviderTokenUpdate(request)) {
				return { ok: false, error: "Invalid model-provider token update." };
			}
			if (modelProviderTokens === null) {
				return { ok: false, error: "Model-provider settings are unavailable." };
			}
			if (modelProviderSettingsError) {
				return { ok: false, error: modelProviderSettingsError };
			}
			try {
				await modelProviderTokens.updateToken(request.provider, request.token);
				return { ok: true, configured: modelProviderTokens.getSettings() };
			} catch (error) {
				return { ok: false, error: errorMessage(error) };
			}
		},
	);
	workerSession = new WorkerSession(
		{
			store: new ConnectionPreferencesStore(
				join(app.getPath("userData"), "worker-connection.json"),
				join(app.getPath("userData"), "server-connection.json"),
			),
			getBackendTarget,
			getBackendTargetError,
			buildCustomNodeSyncPlan,
			buildModelSyncPlan,
			buildSyncVerificationRequest: () => {
				const target = getBackendTarget();
				if (target === null) {
					throw new Error(
						getBackendTargetError() ?? "The Worker backend target is unavailable.",
					);
				}
				return buildSyncVerificationRequest(target.version);
			},
			shouldSyncModels: () =>
				modelLibraryError !== null ||
				(modelLibrary?.list().some((model) => model.sync) ?? true),
		},
		{
			workflow: {
				captureInputs: (jobId, prompt) => workflowInputs.create(jobId, prompt),
				cleanupInputs: (jobId) => workflowInputs.cleanup(jobId),
				openEvents: openWorkerWorkflowEvents,
				collect: (credential, context, signal) =>
					workflowResults.collect(credential, context, fetch, signal),
				recordFailure: (context, error) =>
					workflowResults.recordFailure(context, error),
				recordCanceled: (context) => workflowResults.recordCanceled(context),
				onQueueChanged: (queue) => comfyGateway?.sendQueueStatus(queue),
				onStarted: (jobId, clientId) => comfyGateway?.sendStarted(jobId, clientId),
				onLive: (event) => comfyGateway?.sendLive(event),
				onTerminal: (event) => comfyGateway?.sendTerminal(event),
			},
		},
	);
	await workerSession.initialize();
	ipcHandlers.handle(WORKER_SESSION_GET_CHANNEL, () => workerSession?.getSnapshot());
	ipcHandlers.handle(CONNECTION_SETTINGS_GET_CHANNEL, () =>
		workerSession?.getSettings(),
	);
	ipcHandlers.handle(
		CONNECTION_SETTINGS_UPDATE_CHANNEL,
		(_event, settings: unknown) => {
			if (!isConnectionSettings(settings)) {
				return { ok: false, error: "Invalid connection settings." };
			}
			return workerSession?.updateSettings(settings);
		},
	);
	ipcHandlers.handle(WORKER_SESSION_INITIALIZE_CHANNEL, () =>
		workerSession?.initialize(),
	);
	ipcHandlers.handle(WORKER_SESSION_CONNECT_CHANNEL, (_event, request: unknown) => {
		if (!isConnectionRequest(request)) {
			return { ok: false, error: "Invalid connection request." };
		}
		return workerSession?.connect(request);
	});
	ipcHandlers.handle(WORKER_SESSION_RETRY_CHANNEL, () => workerSession?.retry());
	ipcHandlers.handle(WORKER_SESSION_DISCONNECT_CHANNEL, () =>
		workerSession?.disconnect(),
	);
	ipcHandlers.handle(WORKER_SESSION_PREPARE_BACKEND_CHANNEL, () =>
		workerSession?.prepareBackend(),
	);
	ipcHandlers.handle(WORKER_SESSION_START_SETUP_CHANNEL, () =>
		workerSession?.startSetup(),
	);
	ipcHandlers.handle(WORKER_SESSION_CANCEL_SETUP_CHANNEL, () =>
		workerSession?.cancelSetup(),
	);
	ipcHandlers.handle(WORKER_SESSION_RESTART_COMFY_CHANNEL, () =>
		workerSession?.restartComfy(),
	);
	ipcHandlers.handle(WORKER_SESSION_SYNC_CUSTOM_NODES_CHANNEL, () =>
		workerSession?.syncCustomNodes(),
	);
	ipcHandlers.handle(
		WORKER_SESSION_REINSTALL_CUSTOM_NODE_CHANNEL,
		(_event, request: unknown) => {
			if (!isWorkerCustomNodeReinstallRequest(request)) {
				return { ok: false, error: "Invalid custom node reinstall request." };
			}
			return workerSession?.reinstallCustomNode(request.id);
		},
	);
	ipcHandlers.handle(
		WORKER_SESSION_REMOVE_CUSTOM_NODE_CHANNEL,
		(_event, request: unknown) => {
			if (!isWorkerCustomNodeRemovalRequest(request)) {
				return { ok: false, error: "Invalid custom node removal request." };
			}
			return workerSession?.removeCustomNode(request.node);
		},
	);
	ipcHandlers.handle(WORKER_SESSION_CANCEL_CUSTOM_NODES_CHANNEL, () =>
		workerSession?.cancelCustomNodes(),
	);
	ipcHandlers.handle(WORKER_SESSION_SYNC_MODELS_CHANNEL, () =>
		workerSession?.syncModels(),
	);
	ipcHandlers.handle(
		WORKER_SESSION_REDOWNLOAD_MODEL_CHANNEL,
		(_event, request: unknown) => {
			if (!isWorkerModelRedownloadRequest(request)) {
				return { ok: false, error: "Invalid model redownload request." };
			}
			return workerSession?.redownloadModel(request.path);
		},
	);
	ipcHandlers.handle(WORKER_SESSION_CANCEL_MODELS_CHANNEL, () =>
		workerSession?.cancelModels(),
	);
	ipcHandlers.handle(WORKER_SESSION_VERIFY_CHANNEL, () => workerSession?.verify());
	ipcHandlers.handle(CONNECTION_LOGS_CHANNEL, () => workerSession?.getLogs());
	ipcHandlers.handle(CONNECTION_COPY_LOGS_CHANNEL, (_event, text: unknown) => {
		if (typeof text !== "string" || text.length === 0) {
			return { ok: false, error: "No Worker logs are available to copy." };
		}
		try {
			clipboard.writeText(text);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: `Could not copy Worker logs. ${errorMessage(error)}` };
		}
	});
	const unsubscribeSyncCompletion = workerSession.subscribe((state) => {
		syncCompletionNotifier?.handle(state.setup);
	});
	const unsubscribeStateChanges = workerSession.subscribeChanges((change) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed())
				window.webContents.send(WORKER_SESSION_STATE_CHANNEL, change);
		}
	});
	unsubscribeWorkerSession = () => {
		unsubscribeSyncCompletion();
		unsubscribeStateChanges();
	};
	const openWindow = (): BrowserWindow => createWindow();
	installAppMenu(openWindow, !E2E_HIDDEN_WINDOW);
	openWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0 && comfyRuntime !== null) {
			openWindow();
		}
	});
});

let stoppingBeforeQuit = false;
let readyToQuit = false;

app.on("will-quit", (event) => {
	if (readyToQuit) return;
	event.preventDefault();
	if (stoppingBeforeQuit) return;
	stoppingBeforeQuit = true;
	const finishQuit = (): void => {
		readyToQuit = true;
		app.quit();
	};
	void stopBeforeQuit().then(finishQuit, finishQuit);
});

async function stopBeforeQuit(): Promise<void> {
	nativeTheme.removeListener("updated", syncWindowBackgrounds);
	const stoppingComfyGateway = comfyGateway?.stop();
	comfyGateway = null;
	const finishingComfyRestarts = comfyRestartQueue;
	const stoppingComfyRuntime = comfyRuntime?.stop();
	comfyRuntime = null;
	session.defaultSession.webRequest.onBeforeSendHeaders(null);
	unsubscribeComfy?.();
	unsubscribeComfy = null;
	unsubscribeComfyVersions?.();
	unsubscribeComfyVersions = null;
	comfyVersions = null;
	comfyVersionsError = null;
	comfyGatewayPortError = null;
	unsubscribeWorkerSession?.();
	unsubscribeWorkerSession = null;
	const stoppingWorkerSession = workerSession?.stop();
	workerSession = null;
	modelLibrary?.close();
	modelLibrary = null;
	modelLibraryError = null;
	customNodeSync = null;
	customNodeSyncError = null;
	modelProviderTokens = null;
	modelProviderSettingsError = null;
	themeStore = null;
	themeSettingsError = null;
	syncCompletionNotificationSettings = null;
	syncCompletionNotificationSettingsError = null;
	syncCompletionNotifier = null;
	ipcHandlers.removeAll();
	await Promise.allSettled([
		stoppingComfyGateway,
		finishingComfyRestarts,
		stoppingComfyRuntime,
		stoppingWorkerSession,
	]);
}

function unavailableModelLibrary(): { ok: false; error: string } {
	return { ok: false, error: "The model library is unavailable." };
}

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function mapWorkerWorkflowError(error: unknown): unknown {
	return error instanceof WorkerWorkflowSubmissionError
		? new ComfyGatewayRequestError(error.message, error.statusCode)
		: error;
}

function sameOrigin(left: string, right: string): boolean {
	try {
		return new URL(left).origin === new URL(right).origin;
	} catch {
		return false;
	}
}
