import type {
	CustomNodeInventoryEntry,
	WorkerComfyMemoryCleanupRequest,
} from "@kastard/common";
import type {
	BackendTarget,
	ConnectionRequest,
	ConnectionResult,
	ConnectionSettings,
	ConnectionSettingsResult,
	ModelSyncRequest,
	ServerLogsResult,
	SyncVerificationRequest,
	SyncVerificationResult,
	WorkerBackendResult,
	WorkerCustomNodeSyncResult,
	WorkerModelSyncResult,
	WorkerSessionSnapshot,
	WorkerSessionState,
	WorkerSessionStateChange,
} from "../../../shared/api";
import {
	type ServerCredential,
	type SyncVerificationRequestResult,
	verifyWorkerSynchronization,
} from "../client";
import type { CustomNodeSyncPlan } from "../sync-plan";
import {
	cancelCurrentWorkerWorkflow,
	clearPendingWorkerWorkflows,
	createWorkerWorkflowActor,
	deletePendingWorkerWorkflows,
	failWorkerWorkflowsForConnectionLoss,
	getCurrentWorkerWorkflow,
	getWorkerWorkflowQueue,
	stopWorkerWorkflowActor,
	submitWorkerWorkflow,
	updateWorkerWorkflowReadiness,
	type WorkerWorkflowActorOptions,
	type WorkerWorkflowQueue,
} from "../workflow-actor";
import {
	CONNECTION_OFFLINE_FAILURE_LIMIT,
	CONNECTION_RECHECK_MS,
	initialWorkerSessionState,
	WorkerConnectionLifecycle,
	type WorkerConnectionLifecycleOptions,
	type WorkerSessionPreferencesStore,
} from "./connection-lifecycle";
import {
	customNodeRunning,
	WorkerCustomNodeSync,
	type WorkerCustomNodeSyncOptions,
} from "./custom-node-sync";
import { createWorkerSessionMachineActor } from "./machine";
import {
	modelRunning,
	WorkerModelSync,
	type WorkerModelSyncOptions,
} from "./model-sync";
import {
	type WorkerSessionRequestFetch as RequestFetch,
	WorkerSessionRequestScope,
	type WorkerSessionResource,
} from "./request-scope";
import { WorkerRuntimeState, type WorkerRuntimeStateOptions } from "./runtime-state";
import { WorkerSetupCoordinator } from "./setup-coordinator";
import { WorkerSessionStateStore } from "./state";

type WorkerSessionDependencies = {
	store: WorkerSessionPreferencesStore;
	getBackendTarget: () => BackendTarget | null;
	getBackendTargetError: () => string | undefined;
	buildCustomNodeSyncPlan: () => Promise<CustomNodeSyncPlan>;
	buildModelSyncPlan: () => Promise<ModelSyncRequest>;
	buildSyncVerificationRequest: () => Promise<SyncVerificationRequest>;
	shouldSyncModels: () => boolean;
};

type WorkerSessionOptions = {
	workflow?: WorkerWorkflowActorOptions;
	connection?: WorkerConnectionLifecycleOptions;
	runtime?: WorkerRuntimeStateOptions;
	customNodes?: WorkerCustomNodeSyncOptions;
	models?: WorkerModelSyncOptions;
	verification?: {
		verify?: (
			credential: ServerCredential,
			request: SyncVerificationRequest,
			requestFetch?: RequestFetch,
		) => Promise<SyncVerificationRequestResult>;
	};
};

export { CONNECTION_OFFLINE_FAILURE_LIMIT, CONNECTION_RECHECK_MS };

const SETUP_SYNCHRONIZATION_UNAVAILABLE_ERROR =
	"Individual synchronization is unavailable during this Worker setup phase.";

export class WorkerSession {
	private readonly actor;
	private readonly workflowActor;
	private readonly state;
	private readonly requests = new WorkerSessionRequestScope<WorkerSessionResource>();
	private readonly customNodes;
	private readonly models;
	private readonly runtime;
	private readonly connection;
	private readonly setup;
	private sessionUnsubscribe: (() => void) | null = null;
	private workflowUnsubscribe: (() => void) | null = null;
	private readonly getBackendTarget: () => BackendTarget | null;
	private readonly getBackendTargetError: () => string | undefined;
	private readonly buildSyncVerificationRequest: () => Promise<SyncVerificationRequest>;
	private readonly shouldSyncModels: () => boolean;
	private readonly requestVerification: NonNullable<
		NonNullable<WorkerSessionOptions["verification"]>["verify"]
	>;
	private verificationOperation = 0;
	private activeVerification: Promise<SyncVerificationResult> | null = null;

	constructor(dependencies: WorkerSessionDependencies, options?: WorkerSessionOptions) {
		this.getBackendTarget = dependencies.getBackendTarget;
		this.getBackendTargetError = dependencies.getBackendTargetError;
		this.buildSyncVerificationRequest = dependencies.buildSyncVerificationRequest;
		this.shouldSyncModels = dependencies.shouldSyncModels;
		this.requestVerification =
			options?.verification?.verify ?? verifyWorkerSynchronization;
		this.workflowActor = createWorkerWorkflowActor(options?.workflow);
		this.state = new WorkerSessionStateStore(
			initialWorkerSessionState(this.getBackendTarget()?.version ?? "", null, null),
		);
		this.customNodes = new WorkerCustomNodeSync(
			{
				state: this.state,
				requests: this.requests,
				getCredential: () => this.getActiveCredential(),
				buildPlan: dependencies.buildCustomNodeSyncPlan,
				setupStartError: () => this.setupSynchronizationStartError(),
				invalidateSetup: () => {
					const setup = this.getState().setup;
					this.actor.send({
						type: "setup.invalidate",
						runningStatus: setup.status === "running" ? "canceled" : "idle",
					});
				},
				invalidateVerification: () => this.invalidateVerification(),
			},
			options?.customNodes,
		);
		this.models = new WorkerModelSync(
			{
				state: this.state,
				requests: this.requests,
				getCredential: () => this.getActiveCredential(),
				buildPlan: dependencies.buildModelSyncPlan,
				setupStartError: () => this.setupSynchronizationStartError(),
				invalidateSetup: () => {
					const setup = this.getState().setup;
					this.actor.send({
						type: "setup.invalidate",
						runningStatus: setup.status === "running" ? "canceled" : "idle",
					});
				},
				invalidateVerification: () => this.invalidateVerification(),
			},
			options?.models,
		);
		this.runtime = new WorkerRuntimeState(
			{
				state: this.state,
				requests: this.requests,
				getCredential: () => this.getActiveCredential(),
				getBackendTarget: this.getBackendTarget,
				getBackendTargetError: this.getBackendTargetError,
				invalidateVerification: () => this.invalidateVerification(),
				isWorkflowRunning: () => getCurrentWorkerWorkflow(this.workflowActor) !== null,
				waitForLifecycle: (predicate, signal, generation) =>
					this.waitForLifecycle(predicate, signal, generation),
				isSetupCurrent: (signal, generation) => this.isSetupCurrent(signal, generation),
			},
			options?.runtime,
		);
		this.connection = new WorkerConnectionLifecycle(
			{
				store: dependencies.store,
				state: this.state,
				requests: this.requests,
				getBackendTarget: this.getBackendTarget,
				getSystemMetricsEnabled: () => this.runtime.systemMetricsEnabled,
				setSystemMetricsEnabled: (enabled, apply) =>
					this.runtime.setSystemMetricsEnabled(enabled, apply),
				startSystemMetrics: (generation, showLoading) =>
					this.runtime.startSystemMetrics(generation, showLoading),
				refreshWorkerState: (generation, showLoading) =>
					this.refreshWorkerState(generation, showLoading),
				refreshSettledWorkerState: (generation) =>
					this.refreshSettledWorkerState(generation),
				resetSyncState: () => {
					this.customNodes.reset();
					this.models.reset();
				},
				invalidateSessionWork: () => this.invalidateSessionWork(),
				onRecovered: (serverUrl, connectedAt, worker) =>
					this.actor.send({
						type: "connection.recovered",
						serverUrl,
						connectedAt,
						...(worker === undefined ? {} : { worker }),
					}),
				onOffline: (message, reconnectRequired) =>
					this.actor.send({
						type: "connection.offline",
						message,
						...(reconnectRequired === undefined ? {} : { reconnectRequired }),
					}),
			},
			options?.connection,
		);
		this.setup = new WorkerSetupCoordinator({
			state: this.state,
			requests: this.requests,
			customNodes: this.customNodes,
			models: this.models,
			runtime: this.runtime,
			verify: () => this.verify(),
			isCurrent: (generation) => this.isCurrent(generation),
			isSetupCurrent: (signal, generation) => this.isSetupCurrent(signal, generation),
			waitForLifecycle: (predicate, signal, generation) =>
				this.waitForLifecycle(predicate, signal, generation),
			sendCancel: () => this.actor.send({ type: "setup.cancel" }),
			waitForCancellation: () => this.waitForSetupCancellation(),
		});
		this.actor = createWorkerSessionMachineActor({
			beginInitialize: () => this.connection.beginInitialize(),
			initialize: (signal) => this.connection.initialize(signal),
			beginConnect: (request) => this.connection.beginConnect(request),
			connect: (signal, request) => this.connection.connect(signal, request),
			beginRetry: () => this.connection.stopRecheck(),
			retry: (signal) => this.connection.retry(signal),
			applyConnectionOutcome: (outcome) => this.connection.applyOutcome(outcome),
			disconnect: () => this.connection.disconnect(),
			goOffline: (message, reconnectRequired) =>
				this.connection.goOffline(message, reconnectRequired),
			recoverConnection: (serverUrl, connectedAt, worker) =>
				this.connection.recover(serverUrl, connectedAt, worker),
			setSetupState: (setup) => this.state.setSetup(setup),
			getComfyState: () => this.getState().comfy,
			prepareSetup: (signal, initialRefresh) =>
				this.setup.prepare(signal, initialRefresh),
			selectSetupModels: () => this.shouldSyncModels(),
			synchronizeSetupModels: (signal, initialRefresh, synchronizeModels) =>
				this.setup.synchronizeModels(signal, initialRefresh, synchronizeModels),
			settleSetupSynchronization: (signal, synchronizeModels) =>
				this.setup.settleSynchronization(signal, synchronizeModels),
			verifySetup: (signal) => this.setup.verify(signal),
			startSetupComfy: (signal) => this.setup.startComfy(signal),
			cancelSetup: (signal) => this.setup.cancelWork(signal),
		});
		this.actor.start();
		let previousSession = this.getState();
		this.sessionUnsubscribe = this.state.subscribe((nextSession) => {
			const previous = previousSession;
			previousSession = nextSession;
			this.syncWorkflowReadiness(previous, nextSession);
		});
		this.workflowActor.start();
		const workflowSubscription = this.workflowActor.subscribe(() =>
			this.syncWorkflowProjection(),
		);
		this.workflowUnsubscribe = () => workflowSubscription.unsubscribe();
		this.syncWorkflowProjection();
	}

	getState(): WorkerSessionState {
		return this.state.getState();
	}

	private get generation(): number {
		return this.requests.currentGeneration;
	}

	subscribe(listener: (state: WorkerSessionState) => void): () => void {
		return this.state.subscribe(listener);
	}

	getSnapshot(): WorkerSessionSnapshot {
		return this.state.getSnapshot();
	}

	subscribeChanges(listener: (change: WorkerSessionStateChange) => void): () => void {
		return this.state.subscribe((_state, change) => listener(change));
	}

	getActiveCredential(): ServerCredential | null {
		return this.connection.credential;
	}

	getWorkflowQueue(): WorkerWorkflowQueue {
		return getWorkerWorkflowQueue(this.workflowActor);
	}

	submitWorkflow(
		prompt: Record<string, unknown>,
		clientId: string | null,
		extraData: Record<string, unknown> = {},
	): Promise<{ id: string; number: number }> {
		return submitWorkerWorkflow(this.workflowActor, prompt, clientId, extraData);
	}

	deletePendingWorkflows(ids: string[]): void {
		deletePendingWorkerWorkflows(this.workflowActor, ids);
	}

	clearPendingWorkflows(): void {
		clearPendingWorkerWorkflows(this.workflowActor);
	}

	cancelCurrentWorkflow(): string | null {
		return cancelCurrentWorkerWorkflow(this.workflowActor);
	}

	getSettings(): ConnectionSettingsResult {
		return this.connection.settings;
	}

	async updateSettings(
		settings: ConnectionSettings,
	): Promise<ConnectionSettingsResult> {
		return this.connection.updateSettings(settings);
	}

	initialize(): Promise<ConnectionResult> {
		return new Promise((reply) => {
			this.actor.send({ type: "connection.initialize", reply });
		});
	}

	connect(request: ConnectionRequest): Promise<ConnectionResult> {
		return new Promise((reply) => {
			this.actor.send({ type: "connection.connect", request, reply });
		});
	}

	retry(): Promise<ConnectionResult> {
		const retry = this.connection.canRetry();
		if (!retry.ok) return Promise.resolve(retry);
		return new Promise((reply) => {
			this.actor.send({ type: "connection.retry", reply });
		});
	}

	async disconnect(): Promise<ConnectionResult> {
		this.actor.send({ type: "connection.disconnect" });
		return { ok: true };
	}

	async getLogs(): Promise<ServerLogsResult> {
		return this.connection.getLogs();
	}

	refreshEditorComfyVersion(): void {
		this.runtime.refreshEditorComfyVersion();
	}

	refreshEditorCustomNodeTarget(): void {
		this.customNodes.refreshEditorTarget();
	}

	refreshEditorModelTarget(): void {
		this.models.refreshEditorTarget();
	}

	async prepareBackend(): Promise<WorkerBackendResult> {
		return this.runtime.prepareBackend();
	}

	async syncCustomNodes(): Promise<WorkerCustomNodeSyncResult> {
		return this.customNodes.sync();
	}

	async reinstallCustomNode(id: string): Promise<WorkerCustomNodeSyncResult> {
		return this.customNodes.reinstall(id);
	}

	async removeCustomNode(
		node: CustomNodeInventoryEntry,
	): Promise<WorkerCustomNodeSyncResult> {
		return this.customNodes.remove(node);
	}

	cancelCustomNodes(): Promise<WorkerCustomNodeSyncResult> {
		return this.customNodes.cancel();
	}

	async syncModels(): Promise<WorkerModelSyncResult> {
		return this.models.sync();
	}

	async redownloadModel(path: string): Promise<WorkerModelSyncResult> {
		return this.models.redownload(path);
	}

	cancelModels(): Promise<WorkerModelSyncResult> {
		return this.models.cancel();
	}

	verify(): Promise<SyncVerificationResult> {
		if (this.activeVerification !== null) return this.activeVerification;
		this.state.setVerification(null);
		const request = this.verifyOnce(this.generation, ++this.verificationOperation);
		this.activeVerification = request;
		void request.then(
			() => this.clearActiveVerification(request),
			() => this.clearActiveVerification(request),
		);
		return request;
	}

	startSetup(): ConnectionResult {
		const state = this.getState();
		if (state.connection.status !== "connected") {
			const error = "Worker setup requires an active Worker connection.";
			this.state.setSetup({ status: "failed", phase: "preparation", error });
			return { ok: false, error };
		}
		this.actor.send({
			type: "setup.start",
			initialRefresh: Promise.resolve(),
			startComfyForSetup: state.comfy.status !== "ready",
		});
		return { ok: true };
	}

	async restartComfy(): Promise<ConnectionResult> {
		return this.runtime.restartComfy();
	}

	async freeComfyMemory(
		request: WorkerComfyMemoryCleanupRequest,
	): Promise<ConnectionResult> {
		return this.runtime.freeComfyMemory(request);
	}

	async cancelSetup(): Promise<ConnectionResult> {
		return this.setup.cancel();
	}

	private waitForSetupCancellation(): Promise<ConnectionResult> {
		return new Promise((resolve) => {
			let subscription = { unsubscribe: (): void => undefined };
			const settle = (): void => {
				const snapshot = this.actor.getSnapshot();
				if (snapshot.matches({ connected: "canceled" })) {
					subscription.unsubscribe();
					resolve({ ok: true });
					return;
				}
				if (
					snapshot.matches({ connected: "failed" }) &&
					this.getState().setup.status === "failed"
				) {
					const setup = this.getState().setup;
					subscription.unsubscribe();
					resolve({
						ok: false,
						error:
							setup.status === "failed"
								? setup.error
								: "Worker setup cancellation failed.",
					});
					return;
				}
				if (!snapshot.matches({ connected: "canceling" })) {
					subscription.unsubscribe();
					resolve({
						ok: false,
						error: "A newer Worker setup replaced this cancellation.",
					});
				}
			};
			subscription = this.actor.subscribe(settle);
			settle();
		});
	}

	async stop(): Promise<void> {
		this.actor.send({ type: "connection.disconnect" });
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = null;
		this.workflowUnsubscribe?.();
		this.workflowUnsubscribe = null;
		this.actor.stop();
		await stopWorkerWorkflowActor(this.workflowActor);
	}

	private async refreshWorkerState(
		generation: number,
		showLoading: boolean,
	): Promise<void> {
		await Promise.all([
			this.customNodes.refreshTarget(generation),
			this.models.refreshTarget(generation),
			this.runtime.refresh(generation, showLoading),
			this.customNodes.load(generation, showLoading),
			this.models.load(generation, showLoading),
		]);
	}

	private async refreshSettledWorkerState(generation: number): Promise<void> {
		const state = this.getState();
		const requests: Promise<void>[] = [this.runtime.refreshSettled(generation)];
		if (
			state.customNodes.status !== "loading" &&
			!customNodeRunning(state.customNodes) &&
			!this.requests.has("customNodes")
		) {
			requests.push(this.customNodes.load(generation, false));
		}
		if (
			state.models.status !== "loading" &&
			!modelRunning(state.models) &&
			!this.requests.has("models")
		) {
			requests.push(this.models.load(generation, false));
		}
		await Promise.all(requests);
	}

	private async verifyOnce(
		generation: number,
		operation: number,
	): Promise<SyncVerificationResult> {
		let request: SyncVerificationRequest;
		try {
			request = await this.buildSyncVerificationRequest();
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
		if (!this.isVerificationCurrent(operation, generation)) {
			return replacedVerificationResult();
		}
		const credential = this.getActiveCredential();
		if (credential === null) {
			return { ok: false, error: "No active Worker connection is available." };
		}
		const result = await this.requests.run("verification", generation, (requestFetch) =>
			this.requestVerification(credential, request, requestFetch),
		);
		if (result === null || !this.isVerificationCurrent(operation, generation)) {
			return replacedVerificationResult();
		}
		if (!result.ok) return { ok: false, error: result.error };
		this.state.setVerification(result.state);
		return { ok: true, verification: result.state };
	}

	private invalidateSessionWork(): void {
		this.verificationOperation += 1;
		this.activeVerification = null;
		this.customNodes.reset();
		this.models.reset();
	}

	private waitForLifecycle(
		predicate: (state: WorkerSessionState) => boolean,
		signal: AbortSignal,
		generation: number,
	): Promise<WorkerSessionState | null> {
		if (!this.isSetupCurrent(signal, generation)) return Promise.resolve(null);
		const current = this.getState();
		if (predicate(current)) return Promise.resolve(current);
		return new Promise((resolve) => {
			let settled = false;
			let unsubscribe = (): void => undefined;
			const finish = (state: WorkerSessionState | null): void => {
				if (settled) return;
				settled = true;
				unsubscribe();
				signal.removeEventListener("abort", abort);
				resolve(state);
			};
			const abort = (): void => finish(null);
			signal.addEventListener("abort", abort, { once: true });
			unsubscribe = this.subscribe((state) => {
				if (!this.isSetupCurrent(signal, generation)) finish(null);
				else if (predicate(state)) finish(state);
			});
		});
	}

	private clearActiveVerification(request: Promise<SyncVerificationResult>): void {
		if (this.activeVerification === request) this.activeVerification = null;
	}

	private invalidateVerification(): void {
		this.verificationOperation += 1;
		this.activeVerification = null;
		this.requests.abort("verification");
	}

	private isCurrent(generation: number): boolean {
		return this.connection.isCurrent(generation);
	}

	private setupSynchronizationStartError(): string | null {
		const setup = this.getState().setup;
		if (setup.status !== "running") return null;
		const snapshot = this.actor.getSnapshot();
		if (
			setup.phase === "preparation" &&
			(snapshot.matches({ connected: "setup" }) ||
				snapshot.matches({ connected: "completion" }))
		) {
			return null;
		}
		return SETUP_SYNCHRONIZATION_UNAVAILABLE_ERROR;
	}

	private isSetupCurrent(signal: AbortSignal, generation: number): boolean {
		return (
			!signal.aborted &&
			this.isCurrent(generation) &&
			this.getState().connection.status === "connected"
		);
	}

	private isVerificationCurrent(operation: number, generation: number): boolean {
		return operation === this.verificationOperation && this.isCurrent(generation);
	}

	private syncWorkflowProjection(): void {
		const workflow = getCurrentWorkerWorkflow(this.workflowActor);
		if (workflow === null && !("workflow" in this.getState())) return;
		this.state.setWorkflow(workflow);
	}

	private syncWorkflowReadiness(
		previous: WorkerSessionState,
		next: WorkerSessionState,
	): void {
		if (
			Object.is(previous.connection, next.connection) &&
			Object.is(previous.comfy, next.comfy)
		) {
			return;
		}
		if (
			previous.connection.status !== "offline" &&
			next.connection.status === "offline"
		) {
			failWorkerWorkflowsForConnectionLoss(this.workflowActor);
		}
		const credential =
			next.connection.status === "connected" && next.comfy.status === "ready"
				? this.getActiveCredential()
				: null;
		updateWorkerWorkflowReadiness(this.workflowActor, credential);
	}
}

function replacedVerificationResult(): SyncVerificationResult {
	return { ok: false, error: "A newer Worker verification replaced this one." };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
