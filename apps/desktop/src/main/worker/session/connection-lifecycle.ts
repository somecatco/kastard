import type {
	BackendTarget,
	ConnectionRequest,
	ConnectionResult,
	ConnectionSettings,
	ConnectionSettingsResult,
	ReleaseIdentity,
	WorkerLogEntry,
	WorkerLogsResult,
	WorkerProvider,
	WorkerSessionState,
} from "../../../shared/api";
import {
	type ConnectionAttemptResult,
	type ConnectionProbeResult,
	connectToWorker,
	fetchWorkerLogs,
	probeWorkerConnection,
	type WorkerLogsFetchResult,
	type WorkerSessionCredential,
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
		workerAddress: string,
		authenticationCode: string,
		signal?: AbortSignal,
	) => Promise<ConnectionAttemptResult>;
	probe?: (
		credential: WorkerSessionCredential,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<ConnectionProbeResult>;
	readLogs?: (
		credential: WorkerSessionCredential,
		cursor: string,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<WorkerLogsFetchResult>;
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
		workerAddress: string,
		connectedAt: number,
		worker?: ReleaseIdentity,
	) => void;
	onOffline: (message: string, reconnectRequired?: boolean) => void;
};

export const CONNECTION_RECHECK_MS = 10_000;
export const CONNECTION_OFFLINE_FAILURE_LIMIT = 5;
const WORKER_LOG_LIMIT = 1_000;
const SESSION_ENDED_ERROR =
	"The encrypted Worker session ended. Reconnect with the same authentication code while this Worker is running.";

export class WorkerConnectionLifecycle {
	private readonly connectWorker;
	private readonly probeWorker;
	private readonly readLogs;
	private readonly recheckMs;
	private recentProvider: WorkerProvider | null = null;
	private recentWorkerAddress: string | null = null;
	private syncAfterConnect = true;
	private activeWorkerApiUrl: string | null = null;
	private activeWorkerAddress: string | null = null;
	private activeSessionCapability: string | null = null;
	private activeTunnel: WorkerTunnel | null = null;
	private activeTunnelUnsubscribe: (() => void) | null = null;
	private checking = false;
	private consecutiveRecheckFailures = 0;
	private recheckTimer: ReturnType<typeof setInterval> | null = null;
	private logCursor: string | null = null;
	private workerLogs: WorkerLogEntry[] = [];
	private logsTruncated = false;
	private logRequest: Promise<WorkerLogsResult> | null = null;

	constructor(
		private readonly dependencies: WorkerConnectionLifecycleDependencies,
		options?: WorkerConnectionLifecycleOptions,
	) {
		this.connectWorker = options?.connect ?? connectToWorker;
		this.probeWorker = options?.probe ?? probeWorkerConnection;
		this.readLogs = options?.readLogs ?? fetchWorkerLogs;
		this.recheckMs = options?.recheckMs ?? CONNECTION_RECHECK_MS;
	}

	get credential(): WorkerSessionCredential | null {
		if (this.activeWorkerApiUrl === null || this.activeSessionCapability === null) {
			return null;
		}
		return {
			workerApiUrl: this.activeWorkerApiUrl,
			sessionCapability: this.activeSessionCapability,
			...(this.activeWorkerAddress === null
				? {}
				: { workerAddress: this.activeWorkerAddress }),
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
				recentWorkerAddress: this.recentWorkerAddress,
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
				this.recentWorkerAddress,
			),
		);
	}

	async initialize(signal: AbortSignal): Promise<ConnectionMachineOutcome> {
		try {
			let preferences = await this.dependencies.store.load();
			if (preferences === null) {
				preferences = {
					recentProvider: null,
					recentWorkerAddress: null,
					syncAfterConnect: true,
					systemMetricsEnabled: true,
				};
				await this.dependencies.store.save(preferences);
			}
			if (signal.aborted) return this.replacedOutcome();
			this.recentProvider = preferences.recentProvider;
			this.recentWorkerAddress = preferences.recentWorkerAddress;
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
						this.recentWorkerAddress,
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
							this.recentWorkerAddress,
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
				workerAddress: request.workerAddress.trim(),
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
				request.workerAddress,
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
							this.recentWorkerAddress,
						),
					},
				};
			}

			try {
				await this.dependencies.store.save({
					recentProvider: request.provider,
					recentWorkerAddress: result.tunnel.workerAddress,
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
								this.recentWorkerAddress,
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
			this.recentWorkerAddress = result.tunnel.workerAddress;
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
			this.activeWorkerApiUrl = result.tunnel.endpointUrl;
			this.activeWorkerAddress = result.tunnel.workerAddress;
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
						workerAddress: result.tunnel.workerAddress,
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
						this.recentWorkerAddress,
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
						this.recentWorkerAddress,
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
								workerAddress:
									credential.workerAddress ?? this.recentWorkerAddress ?? "",
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
						workerAddress: credential.workerAddress ?? this.recentWorkerAddress ?? "",
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
							workerAddress: credential.workerAddress ?? this.recentWorkerAddress ?? "",
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

	recover(workerAddress: string, connectedAt: number, worker?: ReleaseIdentity): void {
		const connection = this.dependencies.state.getState().connection;
		if (connection.status !== "offline") return;
		this.dependencies.state.setConnection({
			status: "connected",
			provider: connection.provider,
			workerAddress,
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
				this.recentWorkerAddress,
			),
		);
	}

	goOffline(message: string, reconnectRequired = false): void {
		const workerAddress = this.activeWorkerAddress ?? this.recentWorkerAddress ?? "";
		this.invalidateWorkerWork();
		this.dependencies.state.reset({
			...disconnectedWorkerState(this.editorComfyVersion()),
			connection: {
				status: "offline",
				provider: this.recentProvider ?? "other",
				workerAddress,
				message,
				...(reconnectRequired ? { reconnectRequired: true } : {}),
			},
		});
	}

	async getLogs(): Promise<WorkerLogsResult> {
		if (this.logRequest !== null) return this.logRequest;
		const credential = this.credential;
		const cursor = this.logCursor;
		if (credential === null || cursor === null) {
			return { ok: false, error: "No active Worker connection is available." };
		}
		const generation = this.dependencies.requests.currentGeneration;
		const request = this.loadWorkerLogs(credential, cursor, generation);
		this.logRequest = request;
		try {
			return await request;
		} finally {
			if (this.logRequest === request) this.logRequest = null;
		}
	}

	isCurrent(generation: number): boolean {
		return (
			this.dependencies.requests.isCurrent(generation) &&
			this.activeWorkerApiUrl !== null
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
		credential: WorkerSessionCredential,
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
			const workerAddress = credential.workerAddress ?? this.recentWorkerAddress ?? "";
			const worker = result.worker;
			const connectionChanged =
				previousConnection.status !== "connected" ||
				previousConnection.workerAddress !== workerAddress;
			const connectedAt =
				previousConnection.status === "connected"
					? previousConnection.connectedAt
					: Date.now();
			if (connectionChanged) {
				this.dependencies.onRecovered(workerAddress, connectedAt, worker);
			} else {
				this.dependencies.state.setConnection({
					status: "connected",
					provider: this.recentProvider ?? "other",
					workerAddress: workerAddress,
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
		if (this.recheckTimer !== null || this.activeWorkerApiUrl === null) return;
		this.recheckTimer = setInterval(
			() => void this.checkActiveConnection(),
			this.recheckMs,
		);
	}

	private async loadWorkerLogs(
		credential: WorkerSessionCredential,
		cursor: string,
		generation: number,
	): Promise<WorkerLogsResult> {
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
		this.workerLogs.push(...result.logs);
		this.logsTruncated ||= result.truncated;
		if (this.workerLogs.length > WORKER_LOG_LIMIT) {
			this.workerLogs = this.workerLogs.slice(-WORKER_LOG_LIMIT);
			this.logsTruncated = true;
		}
		return {
			ok: true,
			logs: [...this.workerLogs],
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
		this.activeWorkerApiUrl = null;
		this.activeWorkerAddress = null;
		this.activeSessionCapability = null;
		this.clearWorkerLogs();
		if (tunnel !== null) void tunnel.close();
	}

	private handleTunnelClosed(tunnel: WorkerTunnel): void {
		if (this.activeTunnel !== tunnel) return;
		this.activeTunnelUnsubscribe?.();
		this.activeTunnelUnsubscribe = null;
		this.activeTunnel = null;
		this.activeWorkerApiUrl = null;
		this.activeSessionCapability = null;
		this.stopRecheck();
		this.clearWorkerLogs();
		this.dependencies.onOffline(SESSION_ENDED_ERROR, true);
	}

	private invalidateWorkerWork(): void {
		this.consecutiveRecheckFailures = 0;
		this.dependencies.requests.invalidateAll();
		this.dependencies.invalidateSessionWork();
	}

	private clearWorkerLogs(): void {
		this.logCursor = null;
		this.workerLogs = [];
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
	recentWorkerAddress: string | null,
): WorkerSessionState {
	return {
		connection: { status: "disconnected", recentProvider, recentWorkerAddress },
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
