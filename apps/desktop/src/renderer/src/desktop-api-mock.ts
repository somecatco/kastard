import {
	applyWorkerSessionStateChange,
	type ComfyRuntimeState,
	type ComfyVersionCatalog,
	type ComfyVersionState,
	type ConnectionState,
	type DesktopTheme,
	type KastardApi,
	type WorkerLogsResult,
	type WorkerSessionState,
	type WorkerSessionStateChange,
	type WorkerSetupState,
} from "../../shared/api";

export const defaultComfyVersionState: ComfyVersionState = {
	selection: { frontend: null, backend: null, manager: null },
	bundled: { frontend: "v1.49.6", backend: "0.34.0", manager: "4.2.2" },
	recommendedFrontend: "v1.49.6",
	recommendedManager: "4.2.2",
	install: { status: "idle" },
};

const defaultComfyVersionCatalog: ComfyVersionCatalog = {
	frontend: [
		{ version: "v1.52.1", installed: false },
		{ version: "v1.49.6", installed: true },
	],
	backend: [
		{ version: "0.34.0", installed: true },
		{ version: "0.33.1", installed: false },
	],
	manager: [
		{ version: "4.3.0", installed: false },
		{ version: "4.2.2", installed: true },
	],
	error: null,
};

const defaultWorkerSessionState: WorkerSessionState = {
	connection: {
		status: "disconnected",
		recentProvider: null,
		recentWorkerAddress: null,
	},
	systemMetrics: { status: "disconnected" },
	backend: { status: "disconnected", editorComfyVersion: "0.34.0" },
	comfy: { status: "disconnected" },
	customNodes: { status: "disconnected" },
	models: { status: "disconnected" },
	verification: null,
	setup: { status: "idle" },
};

type ConnectedState = Extract<ConnectionState, { status: "connected" }>;

export function connectedState(
	overrides: Partial<Omit<ConnectedState, "status">> = {},
): ConnectedState {
	return {
		status: "connected",
		provider: "other",
		workerAddress: "worker.example.com:22001",
		connectedAt: Date.now(),
		...overrides,
	};
}

function unexpected(error: string) {
	return { ok: false as const, error };
}

export function createDesktopApiMock() {
	let workerSessionState = structuredClone(defaultWorkerSessionState);
	let workerSessionRevision = 0;
	let syncAfterConnect = true;
	let systemMetricsEnabled = true;
	let desktopTheme: DesktopTheme = "system";
	let syncCompletionNotificationEnabled = true;
	let workerLogsResult: WorkerLogsResult = {
		ok: true,
		logs: [],
		truncated: false,
	};
	const workerSessionListeners = new Set<(change: WorkerSessionStateChange) => void>();
	const comfyListeners = new Set<(state: ComfyRuntimeState) => void>();
	const comfyVersionListeners = new Set<(state: ComfyVersionState) => void>();
	const openSettingsListeners = new Set<() => void>();

	function emitWorkerSession(patch: Partial<WorkerSessionState>): void {
		for (const key of Object.keys(patch) as Array<keyof WorkerSessionState>) {
			if (
				key !== "connection" &&
				JSON.stringify(workerSessionState[key]) === JSON.stringify(patch[key])
			) {
				continue;
			}
			const revision = ++workerSessionRevision;
			let change: WorkerSessionStateChange;
			switch (key) {
				case "connection": {
					const connection = patch.connection;
					if (connection === undefined) continue;
					change = { revision, type: "connection.changed", connection };
					break;
				}
				case "systemMetrics": {
					const systemMetrics = patch.systemMetrics;
					if (systemMetrics === undefined) continue;
					change = {
						revision,
						type: "system-metrics.changed",
						systemMetrics,
					};
					break;
				}
				case "backend": {
					const backend = patch.backend;
					if (backend === undefined) continue;
					change = { revision, type: "backend.changed", backend };
					break;
				}
				case "comfy": {
					const comfy = patch.comfy;
					if (comfy === undefined) continue;
					change = { revision, type: "comfy.changed", comfy };
					break;
				}
				case "customNodes": {
					const customNodes = patch.customNodes;
					if (customNodes === undefined) continue;
					change = {
						revision,
						type: "custom-nodes.changed",
						customNodes,
					};
					break;
				}
				case "models": {
					const models = patch.models;
					if (models === undefined) continue;
					change = { revision, type: "models.changed", models };
					break;
				}
				case "verification":
					change = {
						revision,
						type: "verification.changed",
						verification: patch.verification ?? null,
					};
					break;
				case "setup": {
					const setup = patch.setup;
					if (setup === undefined) continue;
					change = { revision, type: "setup.changed", setup };
					break;
				}
				case "workflow":
					change = {
						revision,
						type: "workflow.changed",
						workflow: patch.workflow ?? null,
					};
			}
			const cloned = structuredClone(change);
			workerSessionState = applyWorkerSessionStateChange(workerSessionState, cloned);
			for (const listener of workerSessionListeners) listener(cloned);
		}
	}

	const api: KastardApi = {
		appInfo: {
			get: async () => ({
				buildNumber: "1",
				channel: "production",
				productVersion: "0.1.0",
				sourceRevision: "a".repeat(40),
				environment: {
					os: "darwin",
					osVersion: "25.0.0",
					arch: "arm64",
					electronVersion: "43.4.0",
					chromeVersion: "144.0.7559.220",
					nodeVersion: "24.13.0",
				},
			}),
		},
		debugInfo: {
			copy: async () => ({ ok: true as const }),
		},
		comfyVersions: {
			getState: async () => ({
				ok: true as const,
				state: structuredClone(defaultComfyVersionState),
			}),
			getCatalog: async () => ({
				ok: true as const,
				catalog: structuredClone(defaultComfyVersionCatalog),
			}),
			select: async () => ({
				ok: true as const,
				state: structuredClone(defaultComfyVersionState),
			}),
			onStateChange: (listener) => {
				comfyVersionListeners.add(listener);
				return () => comfyVersionListeners.delete(listener);
			},
		},
		comfy: {
			restart: async () => ({ ok: true as const }),
			start: async () => ({ ok: true as const, url: "about:blank" }),
			onStateChange: (listener) => {
				comfyListeners.add(listener);
				return () => comfyListeners.delete(listener);
			},
		},
		models: {
			list: async () => ({ ok: true as const, models: [] }),
			add: async () => unexpected("Unexpected model add."),
			update: async () => unexpected("Unexpected model update."),
			remove: async () => unexpected("Unexpected model removal."),
			resolveFiles: async () => unexpected("Unexpected model-provider lookup."),
		},
		modelProviders: {
			getSettings: async () => ({
				ok: true as const,
				configured: { huggingface: false, civitai: false },
			}),
			updateToken: async ({ provider, token }) => ({
				ok: true as const,
				configured: {
					huggingface: provider === "huggingface" && token !== null,
					civitai: provider === "civitai" && token !== null,
				},
			}),
		},
		theme: {
			initial: "system" as const,
			get: async () => ({ ok: true as const, theme: desktopTheme }),
			update: async (theme) => {
				desktopTheme = theme;
				return { ok: true as const, theme };
			},
		},
		syncCompletionNotification: {
			getSettings: async () => ({
				ok: true as const,
				settings: { enabled: syncCompletionNotificationEnabled },
			}),
			updateSettings: async ({ enabled }) => {
				syncCompletionNotificationEnabled = enabled;
				return { ok: true as const, settings: { enabled } };
			},
		},
		workerSession: {
			getSnapshot: async () => ({
				revision: workerSessionRevision,
				state: structuredClone(workerSessionState),
			}),
			retryInitialization: async () => {
				emitWorkerSession({
					connection: {
						status: "disconnected",
						recentProvider: null,
						recentWorkerAddress: null,
					},
				});
				return { ok: true as const };
			},
			connect: async ({ provider, workerAddress, syncAfterConnect: next }) => {
				syncAfterConnect = next;
				emitWorkerSession({ connection: connectedState({ provider, workerAddress }) });
				return { ok: true as const };
			},
			retry: async () => unexpected("Unexpected retry."),
			disconnect: async () => {
				emitWorkerSession({
					connection: {
						status: "disconnected",
						recentProvider: "other",
						recentWorkerAddress: "worker.example.com:22001",
					},
				});
				return { ok: true as const };
			},
			prepareBackend: async () => unexpected("Unexpected backend preparation."),
			startSetup: async () => unexpected("Unexpected setup start."),
			cancelSetup: async () => unexpected("Unexpected setup cancellation."),
			restartComfy: async () => unexpected("Unexpected ComfyUI restart."),
			syncCustomNodes: async () => unexpected("Unexpected custom node sync."),
			reinstallCustomNode: async () => unexpected("Unexpected custom node reinstall."),
			removeCustomNode: async () => unexpected("Unexpected custom node removal."),
			cancelCustomNodes: async () => unexpected("Unexpected custom node cancellation."),
			syncModels: async () => unexpected("Unexpected model sync."),
			redownloadModel: async () => unexpected("Unexpected model redownload."),
			cancelModels: async () => unexpected("Unexpected model cancellation."),
			verify: async () => unexpected("Unexpected synchronization verification."),
			onStateChange: (listener) => {
				workerSessionListeners.add(listener);
				return () => workerSessionListeners.delete(listener);
			},
		},
		connection: {
			getSettings: async () => ({
				ok: true as const,
				settings: { syncAfterConnect, systemMetricsEnabled },
			}),
			updateSettings: async (settings) => {
				syncAfterConnect = settings.syncAfterConnect;
				systemMetricsEnabled = settings.systemMetricsEnabled;
				return {
					ok: true as const,
					settings: { syncAfterConnect, systemMetricsEnabled },
				};
			},
			copyWorkerLogs: async () => unexpected("Unexpected worker-log copy."),
			getLogs: async () => structuredClone(workerLogsResult),
		},
		customNodes: {
			list: async () => ({ ok: true as const, nodes: [] }),
			getInstallOptions: async () => ({ ok: true as const, options: null }),
			install: async () => unexpected("Unexpected custom-node installation."),
			remove: async () => unexpected("Unexpected custom-node removal."),
			update: async () => unexpected("Unexpected custom-node update."),
		},
		editorDirectories: {
			get: async (directory) => ({
				ok: true as const,
				path:
					directory === "comfy"
						? "/Users/test/Kastard/comfy/data"
						: directory === "custom-nodes"
							? "/Users/test/Kastard/comfy/data/custom_nodes"
							: "/Users/test/Kastard/comfy/virtual-models",
			}),
			open: async () => unexpected("Unexpected editor-directory open."),
		},
		menu: {
			onOpenSettings: (listener) => {
				openSettingsListeners.add(listener);
				return () => openSettingsListeners.delete(listener);
			},
		},
	};

	return {
		api,
		emitWorkerSession,
		emitConnection: (connection: ConnectionState) => emitWorkerSession({ connection }),
		emitWorkerSetup: (setup: WorkerSetupState) =>
			emitWorkerSession({
				setup,
				...((setup.status === "succeeded" || setup.status === "failed") &&
				setup.verification !== undefined
					? { verification: setup.verification }
					: {}),
			}),
		emitComfyRuntime: (state: ComfyRuntimeState) => {
			for (const listener of comfyListeners) listener(structuredClone(state));
		},
		openSettingsFromMenu: () => {
			for (const listener of openSettingsListeners) listener();
		},
		hasOpenSettingsListener: () => openSettingsListeners.size > 0,
		getWorkerSessionState: () => structuredClone(workerSessionState),
		setWorkerSessionState: (state: WorkerSessionState) => {
			const change = {
				revision: ++workerSessionRevision,
				type: "session.reset",
				state: structuredClone(state),
			} satisfies WorkerSessionStateChange;
			workerSessionState = change.state;
			for (const listener of workerSessionListeners) listener(change);
		},
		setWorkerLogsResult: (result: WorkerLogsResult) => {
			workerLogsResult = structuredClone(result);
		},
		setSyncAfterConnect: (value: boolean) => {
			syncAfterConnect = value;
		},
	};
}

export type DesktopApiMock = ReturnType<typeof createDesktopApiMock>;
