import type {
	BackendTarget,
	ConnectionRequest,
	ConnectionResult,
	ConnectionSettings,
	ConnectionSettingsResult,
	ReleaseIdentity,
	ServerLogEntry,
	ServerLogsResult,
	WorkerProvider,
	WorkerSessionState,
} from "../../../shared/api";
import {
	type ConnectionAttemptResult,
	type ConnectionProbeResult,
	connectToServer,
	fetchServerLogs,
	probeServerConnection,
	type ServerCredential,
	type ServerLogsFetchResult,
} from "../client";
import type { ConnectionPreferences } from "../connection-store";
import type { WorkerTunnel } from "../tunnel";
import { type ConnectionMachineOutcome, replacedConnectionResult } from "./machine";
import type {
	WorkerSessionRequestFetch,
	WorkerSessionRequestScope,
	WorkerSessionResource,
} from "./request-scope";
import type { WorkerSessionStateStore } from "./state";

export interface WorkerSessionPreferencesStore {
	load: () => Promise<ConnectionPreferences | null>;
	save: (preferences: ConnectionPreferences) => Promise<void>;
}

export type WorkerConnectionLifecycleOptions = {
	connect?: (
		serverUrl: string,
		authenticationCode: string,
		signal?: AbortSignal,
	) => Promise<ConnectionAttemptResult>;
	probe?: (
		credential: ServerCredential,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<ConnectionProbeResult>;
	readLogs?: (
		credential: ServerCredential,
		cursor: string,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<ServerLogsFetchResult>;
	recheckMs?: number;
};

type WorkerConnectionLifecycleDependencies = {
	store: WorkerSessionPreferencesStore;
	state: WorkerSessionStateStore;
	requests: WorkerSessionRequestScope<WorkerSessionResource>;
	getBackendTarget: () => BackendTarget | null;
	getSystemMetricsEnabled: () => boolean;
	setSystemMetricsEnabled: (enabled: boolean, apply: boolean) => void;
	startSystemMetrics: (generation: number, showLoading: boolean) => void;
	refreshWorkerState: (generation: number, showLoading: boolean) => Promise<void>;
	refreshSettledWorkerState: (generation: number) => Promise<void>;
	resetSyncState: () => void;
	invalidateSessionWork: () => void;
	onRecovered: (
		serverUrl: string,
		connectedAt: number,
		worker?: ReleaseIdentity,
	) => void;
	onOffline: (message: string, reconnectRequired?: boolean) => void;
};

export const CONNECTION_RECHECK_MS = 10_000;
export const CONNECTION_OFFLINE_FAILURE_LIMIT = 5;
const SERVER_LOG_LIMIT = 1_000;
const SESSION_ENDED_ERROR =
	"The encrypted Worker session ended. Reconnect with the same authentication code while this Worker is running.";

export class WorkerConnectionLifecycle {
	private readonly connectWorker;
	private readonly probeWorker;
	private readonly readLogs;
	private readonly recheckMs;
	private recentProvider: WorkerProvider | null = null;
	private recentServerUrl: string | null = null;
	private syncAfterConnect = true;
	private activeServerUrl: string | null = null;
	private activeWorkerUrl: string | null = null;
	private activeSessionCapability: string | null = null;
	private activeTunnel: WorkerTunnel | null = null;
	private activeTunnelUnsubscribe: (() => void) | null = null;
	private checking = false;
	private consecutiveRecheckFailures = 0;
	private recheckTimer: ReturnType<typeof setInterval> | null = null;
	private logCursor: string | null = null;
	private serverLogs: ServerLogEntry[] = [];
	private logsTruncated = false;
	private logRequest: Promise<ServerLogsResult> | null = null;

	constructor(
		private readonly dependencies: WorkerConnectionLifecycleDependencies,
		options?: WorkerConnectionLifecycleOptions,
	) {
		this.connectWorker = options?.connect ?? connectToServer;
		this.probeWorker = options?.probe ?? probeServerConnection;
		this.readLogs = options?.readLogs ?? fetchServerLogs;
		this.recheckMs = options?.recheckMs ?? CONNECTION_RECHECK_MS;
	}

	get credential(): ServerCredential | null {
		if (this.activeServerUrl === null || this.activeSessionCapability === null) {
			return null;
		}
		return {
			serverUrl: this.activeServerUrl,
			sessionCapability: this.activeSessionCapability,
			...(this.activeWorkerUrl === null ? {} : { workerUrl: this.activeWorkerUrl }),
		};
	}

	get settings(): ConnectionSettingsResult {
		return {
			ok: true,
			settings: {
				syncAfterConnect: this.syncAfterConnect,
				systemMetricsEnabled: this.dependencies.getSystemMetricsEnabled(),
			},
		};
	}

	async updateSettings(
		settings: ConnectionSettings,
	): Promise<ConnectionSettingsResult> {
		try {
			await this.dependencies.store.save({
				recentProvider: this.recentProvider,
				recentServerUrl: this.recentServerUrl,
				syncAfterConnect: settings.syncAfterConnect,
				systemMetricsEnabled: settings.systemMetricsEnabled,
			});
			this.syncAfterConnect = settings.syncAfterConnect;
			this.dependencies.setSystemMetricsEnabled(settings.systemMetricsEnabled, true);
			return this.settings;
		} catch (error) {
			return {
				ok: false,
				error: `The connection settings could not be saved. ${errorMessage(error)}`,
			};
		}
	}

	canRetry(): ConnectionResult {
		if (this.credential === null) {
			return { ok: false, error: "No active Worker connection is available." };
		}
		if (this.dependencies.state.getState().connection.status !== "offline") {
			return {
				ok: false,
				error: "Worker connection retry is only available while offline.",
			};
		}
		return { ok: true };
	}

	beginInitialize(): void {
		this.end();
		this.dependencies.state.reset(
			initialWorkerSessionState(
				this.editorComfyVersion(),
				this.recentProvider,
				this.recentServerUrl,
			),
		);
	}

	async initialize(signal: AbortSignal): Promise<ConnectionMachineOutcome> {
		try {
			let preferences = await this.dependencies.store.load();
			if (preferences === null) {
				preferences = {
					recentProvider: null,
					recentServerUrl: null,
					syncAfterConnect: true,
					systemMetricsEnabled: true,
				};
				await this.dependencies.store.save(preferences);
			}
			if (signal.aborted) return this.replacedOutcome();
			this.recentProvider = preferences.recentProvider;
			this.recentServerUrl = preferences.recentServerUrl;
			this.syncAfterConnect = preferences.syncAfterConnect;
			this.dependencies.setSystemMetricsEnabled(
				preferences.systemMetricsEnabled,
				false,
			);
			return {
				result: { ok: true },
				update: {
					type: "reset",
					state: initialWorkerSessionState(
						this.editorComfyVersion(),
						this.recentProvider,
						this.recentServerUrl,
					),
				},
			};
		} catch (error) {
			if (signal.aborted) return this.replacedOutcome();
			const message = errorMessage(error);
			return {
				result: { ok: false, error: message },
				update: {
					type: "reset",
					state: {
						...initialWorkerSessionState(
							this.editorComfyVersion(),
							this.recentProvider,
							this.recentServerUrl,
						),
						connection: { status: "error", message },
					},
				},
			};
		}
	}

	beginConnect(request: ConnectionRequest): void {
		this.end();
		this.dependencies.state.reset({
			connection: {
				status: "connecting",
				provider: request.provider,
				serverUrl: request.serverUrl.trim(),
			},
			...disconnectedWorkerState(this.editorComfyVersion()),
		});
	}

	async connect(
		signal: AbortSignal,
		request: ConnectionRequest,
	): Promise<ConnectionMachineOutcome> {
		try {
			const result = await this.connectWorker(
				request.serverUrl,
				request.authenticationCode,
				signal,
			);
			if (signal.aborted) {
				if (result.ok) void result.tunnel.close();
				return this.replacedOutcome();
			}
			if (!result.ok) {
				return {
					result,
					update: {
						type: "reset",
						state: initialWorkerSessionState(
							this.editorComfyVersion(),
							this.recentProvider,
							this.recentServerUrl,
						),
					},
				};
			}

			try {
				await this.dependencies.store.save({
					recentProvider: request.provider,
					recentServerUrl: result.tunnel.workerAddress,
					syncAfterConnect: request.syncAfterConnect,
					systemMetricsEnabled: this.dependencies.getSystemMetricsEnabled(),
				});
			} catch (error) {
				void result.tunnel.close();
				if (signal.aborted) return this.replacedOutcome();
				const message = `The Worker connected, but its address could not be saved. ${errorMessage(error)}`;
				return {
					result: { ok: false, error: message },
					update: {
						type: "reset",
						state: {
							...initialWorkerSessionState(
								this.editorComfyVersion(),
								this.recentProvider,
								this.recentServerUrl,
							),
							connection: { status: "error", message },
						},
					},
				};
			}

			if (signal.aborted) {
				void result.tunnel.close();
				return this.replacedOutcome();
			}
			this.recentProvider = request.provider;
			this.recentServerUrl = result.tunnel.workerAddress;
			this.syncAfterConnect = request.syncAfterConnect;
			let tunnelClosed = false;
			const unsubscribe = result.tunnel.onClose(() => {
				tunnelClosed = true;
				this.handleTunnelClosed(result.tunnel);
			});
			if (tunnelClosed) {
				unsubscribe();
				throw new Error(SESSION_ENDED_ERROR);
			}
			this.activeServerUrl = result.tunnel.endpointUrl;
			this.activeWorkerUrl = result.tunnel.workerAddress;
			this.activeSessionCapability = result.tunnel.sessionCapability;
			this.activeTunnel = result.tunnel;
			this.activeTunnelUnsubscribe = unsubscribe;
			this.logCursor = result.logCursor;
			this.dependencies.resetSyncState();
			const generation = this.dependencies.requests.currentGeneration;
			return {
				result: { ok: true },
				update: {
					type: "lifecycle",
					connection: {
						status: "connected",
						provider: request.provider,
						serverUrl: result.tunnel.workerAddress,
						connectedAt: Date.now(),
						...(result.worker === undefined ? {} : { worker: result.worker }),
					},
					setup: request.syncAfterConnect
						? { status: "idle", pendingAutomaticStart: true }
						: { status: "idle" },
				},
				initialRefresh: () => {
					const refresh = this.dependencies.refreshWorkerState(generation, true);
					this.dependencies.startSystemMetrics(generation, true);
					this.startRecheck();
					return refresh;
				},
				...(request.syncAfterConnect ? { automaticSetup: true as const } : {}),
			};
		} catch (error) {
			if (signal.aborted) return this.replacedOutcome();
			const message = errorMessage(error);
			return {
				result: { ok: false, error: message },
				update: {
					type: "reset",
					state: initialWorkerSessionState(
						this.editorComfyVersion(),
						this.recentProvider,
						this.recentServerUrl,
					),
				},
			};
		}
	}

	async retry(signal: AbortSignal): Promise<ConnectionMachineOutcome> {
		const credential = this.credential;
		if (credential === null) {
			return {
				result: { ok: false, error: "No active Worker connection is available." },
				update: {
					type: "reset",
					state: initialWorkerSessionState(
						this.editorComfyVersion(),
						this.recentProvider,
						this.recentServerUrl,
					),
				},
			};
		}
		const generation = this.dependencies.requests.currentGeneration;
		try {
			const result = await this.dependencies.requests.run(
				"connection",
				generation,
				(requestFetch) => this.probeWorker(credential, requestFetch),
			);
			if (signal.aborted || result === null) return this.replacedOutcome();
			if (result.status === "offline") {
				this.startRecheck();
				this.invalidateWorkerWork();
				return {
					result: { ok: false, error: result.error },
					update: {
						type: "reset",
						state: {
							...disconnectedWorkerState(this.editorComfyVersion()),
							connection: {
								status: "offline",
								provider: this.recentProvider ?? "other",
								serverUrl: credential.workerUrl ?? this.recentServerUrl ?? "",
								message: result.error,
							},
						},
					},
				};
			}

			this.consecutiveRecheckFailures = 0;
			return {
				result: { ok: true },
				update: {
					type: "connection",
					connection: {
						status: "connected",
						provider: this.recentProvider ?? "other",
						serverUrl: credential.workerUrl ?? this.recentServerUrl ?? "",
						connectedAt: Date.now(),
						...(result.worker === undefined ? {} : { worker: result.worker }),
					},
				},
				initialRefresh: () => {
					const refresh = this.dependencies.refreshWorkerState(generation, false);
					this.dependencies.startSystemMetrics(generation, true);
					this.startRecheck();
					return refresh;
				},
			};
		} catch (error) {
			if (signal.aborted) return this.replacedOutcome();
			const message = errorMessage(error);
			this.startRecheck();
			this.invalidateWorkerWork();
			return {
				result: { ok: false, error: message },
				update: {
					type: "reset",
					state: {
						...disconnectedWorkerState(this.editorComfyVersion()),
						connection: {
							status: "offline",
							provider: this.recentProvider ?? "other",
							serverUrl: credential.workerUrl ?? this.recentServerUrl ?? "",
							message,
						},
					},
				},
			};
		}
	}

	applyOutcome(outcome: ConnectionMachineOutcome): void {
		switch (outcome.update.type) {
			case "reset": {
				const current = this.dependencies.state.getState();
				this.dependencies.state.reset(
					"workflow" in current
						? { ...outcome.update.state, workflow: current.workflow }
						: outcome.update.state,
				);
				return;
			}
			case "lifecycle":
				this.dependencies.state.setLifecycle(
					outcome.update.connection,
					outcome.update.setup,
				);
				return;
			case "connection":
				this.dependencies.state.setConnection(outcome.update.connection);
		}
	}

	recover(serverUrl: string, connectedAt: number, worker?: ReleaseIdentity): void {
		const connection = this.dependencies.state.getState().connection;
		if (connection.status !== "offline") return;
		this.dependencies.state.setConnection({
			status: "connected",
			provider: connection.provider,
			serverUrl,
			connectedAt,
			...(worker === undefined ? {} : { worker }),
		});
	}

	disconnect(): void {
		this.end();
		this.dependencies.state.reset(
			initialWorkerSessionState(
				this.editorComfyVersion(),
				this.recentProvider,
				this.recentServerUrl,
			),
		);
	}

	goOffline(message: string, reconnectRequired = false): void {
		const serverUrl = this.activeWorkerUrl ?? this.recentServerUrl ?? "";
		this.invalidateWorkerWork();
		this.dependencies.state.reset({
			...disconnectedWorkerState(this.editorComfyVersion()),
			connection: {
				status: "offline",
				provider: this.recentProvider ?? "other",
				serverUrl,
				message,
				...(reconnectRequired ? { reconnectRequired: true } : {}),
			},
		});
	}

	async getLogs(): Promise<ServerLogsResult> {
		if (this.logRequest !== null) return this.logRequest;
		const credential = this.credential;
		const cursor = this.logCursor;
		if (credential === null || cursor === null) {
			return { ok: false, error: "No active Worker connection is available." };
		}
		const generation = this.dependencies.requests.currentGeneration;
		const request = this.loadServerLogs(credential, cursor, generation);
		this.logRequest = request;
		try {
			return await request;
		} finally {
			if (this.logRequest === request) this.logRequest = null;
		}
	}

	isCurrent(generation: number): boolean {
		return (
			this.dependencies.requests.isCurrent(generation) && this.activeServerUrl !== null
		);
	}

	stopRecheck(): void {
		if (this.recheckTimer === null) return;
		clearInterval(this.recheckTimer);
		this.recheckTimer = null;
	}

	private replacedOutcome(): ConnectionMachineOutcome {
		return {
			result: replacedConnectionResult(),
			update: {
				type: "connection",
				connection: this.dependencies.state.getState().connection,
			},
		};
	}

	private async probeOnce(
		credential: ServerCredential,
		generation: number,
		offlineFailureLimit = 1,
	): Promise<ConnectionResult | null> {
		const previousConnection = this.dependencies.state.getState().connection;
		const result = await this.dependencies.requests.run(
			"connection",
			generation,
			(requestFetch) => this.probeWorker(credential, requestFetch),
		);
		if (result === null) return null;
		if (result.status === "connected") {
			this.consecutiveRecheckFailures = 0;
			const workerUrl = credential.workerUrl ?? this.recentServerUrl ?? "";
			const worker = result.worker;
			const connectionChanged =
				previousConnection.status !== "connected" ||
				previousConnection.serverUrl !== workerUrl;
			const connectedAt =
				previousConnection.status === "connected"
					? previousConnection.connectedAt
					: Date.now();
			if (connectionChanged) {
				this.dependencies.onRecovered(workerUrl, connectedAt, worker);
			} else {
				this.dependencies.state.setConnection({
					status: "connected",
					provider: this.recentProvider ?? "other",
					serverUrl: workerUrl,
					connectedAt,
					...(worker === undefined ? {} : { worker }),
				});
			}
			if (connectionChanged) {
				this.dependencies.startSystemMetrics(generation, true);
				void this.dependencies.refreshWorkerState(generation, false);
			} else {
				void this.dependencies.refreshSettledWorkerState(generation);
			}
			return { ok: true };
		}
		this.consecutiveRecheckFailures += 1;
		if (this.consecutiveRecheckFailures < offlineFailureLimit) {
			return { ok: false, error: result.error };
		}
		this.dependencies.onOffline(result.error);
		return { ok: false, error: result.error };
	}

	private async checkActiveConnection(): Promise<void> {
		if (this.checking) return;
		const credential = this.credential;
		if (credential === null) return;
		this.checking = true;
		try {
			await this.probeOnce(
				credential,
				this.dependencies.requests.currentGeneration,
				CONNECTION_OFFLINE_FAILURE_LIMIT,
			);
		} finally {
			this.checking = false;
		}
	}

	private startRecheck(): void {
		if (this.recheckTimer !== null || this.activeServerUrl === null) return;
		this.recheckTimer = setInterval(
			() => void this.checkActiveConnection(),
			this.recheckMs,
		);
	}

	private async loadServerLogs(
		credential: ServerCredential,
		cursor: string,
		generation: number,
	): Promise<ServerLogsResult> {
		const result = await this.dependencies.requests.run(
			"logs",
			generation,
			(requestFetch) => this.readLogs(credential, cursor, requestFetch),
		);
		if (result === null) {
			return { ok: false, error: "A newer Worker connection replaced this one." };
		}
		if (!result.ok) return result;
		this.logCursor = result.cursor;
		this.serverLogs.push(...result.logs);
		this.logsTruncated ||= result.truncated;
		if (this.serverLogs.length > SERVER_LOG_LIMIT) {
			this.serverLogs = this.serverLogs.slice(-SERVER_LOG_LIMIT);
			this.logsTruncated = true;
		}
		return {
			ok: true,
			logs: [...this.serverLogs],
			truncated: this.logsTruncated,
		};
	}

	private end(): void {
		const tunnel = this.activeTunnel;
		this.activeTunnelUnsubscribe?.();
		this.activeTunnelUnsubscribe = null;
		this.activeTunnel = null;
		this.invalidateWorkerWork();
		this.stopRecheck();
		this.activeServerUrl = null;
		this.activeWorkerUrl = null;
		this.activeSessionCapability = null;
		this.clearServerLogs();
		if (tunnel !== null) void tunnel.close();
	}

	private handleTunnelClosed(tunnel: WorkerTunnel): void {
		if (this.activeTunnel !== tunnel) return;
		this.activeTunnelUnsubscribe?.();
		this.activeTunnelUnsubscribe = null;
		this.activeTunnel = null;
		this.activeServerUrl = null;
		this.activeSessionCapability = null;
		this.stopRecheck();
		this.clearServerLogs();
		this.dependencies.onOffline(SESSION_ENDED_ERROR, true);
	}

	private invalidateWorkerWork(): void {
		this.consecutiveRecheckFailures = 0;
		this.dependencies.requests.invalidateAll();
		this.dependencies.invalidateSessionWork();
	}

	private clearServerLogs(): void {
		this.logCursor = null;
		this.serverLogs = [];
		this.logsTruncated = false;
		this.logRequest = null;
	}

	private editorComfyVersion(): string {
		return this.dependencies.getBackendTarget()?.version ?? "";
	}
}

export function initialWorkerSessionState(
	editorComfyVersion: string,
	recentProvider: WorkerProvider | null,
	recentServerUrl: string | null,
): WorkerSessionState {
	return {
		connection: { status: "disconnected", recentProvider, recentServerUrl },
		...disconnectedWorkerState(editorComfyVersion),
	};
}

function disconnectedWorkerState(
	editorComfyVersion: string,
): Omit<WorkerSessionState, "connection"> {
	return {
		systemMetrics: { status: "disconnected" },
		backend: { status: "disconnected", editorComfyVersion },
		comfy: { status: "disconnected" },
		customNodes: { status: "disconnected" },
		models: { status: "disconnected" },
		verification: null,
		setup: { status: "idle" },
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
