import {
	parseModelSyncState,
	sameModelSyncTarget,
	sameModelSyncTargets,
} from "@kastard/common";
import type {
	ModelSyncRequest,
	ModelSyncServerState,
	WorkerModelSyncResult,
	WorkerModelSyncState,
	WorkerModelTargetState,
} from "../../../shared/api";
import {
	cancelWorkerModelSync,
	fetchWorkerModelSync,
	type ModelSyncRequestResult,
	type ServerCredential,
	startWorkerModelRedownload,
	startWorkerModelSync,
} from "../client";
import type {
	WorkerSessionRequestFetch,
	WorkerSessionRequestScope,
	WorkerSessionResource,
} from "./request-scope";
import type { WorkerSessionStateStore } from "./state";

const SYNC_IN_PROGRESS_ERROR = "Models are already synchronizing.";

export type WorkerModelSyncOptions = {
	read?: (
		credential: ServerCredential,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<ModelSyncRequestResult>;
	start?: (
		credential: ServerCredential,
		request: ModelSyncRequest,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<ModelSyncRequestResult>;
	redownload?: (
		credential: ServerCredential,
		request: ModelSyncRequest,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<ModelSyncRequestResult>;
	cancel?: (
		credential: ServerCredential,
		operationId: string | null,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<ModelSyncRequestResult>;
	pollMs?: number;
};

type WorkerModelSyncDependencies = {
	state: WorkerSessionStateStore;
	requests: WorkerSessionRequestScope<WorkerSessionResource>;
	getCredential: () => ServerCredential | null;
	buildPlan: () => Promise<ModelSyncRequest>;
	setupStartError: () => string | null;
	invalidateSetup: () => void;
	invalidateVerification: () => void;
};

export class WorkerModelSync {
	private readonly read;
	private readonly start;
	private readonly redownloadRequest;
	private readonly cancelRequest;
	private readonly pollMs;
	private target: Pick<ModelSyncRequest, "models"> | null = null;
	private targetOperation = 0;
	private intentOperation = 0;
	private serverState: ModelSyncServerState | null = null;
	private targetModels: WorkerModelTargetState[] | null = null;
	private cancellation: {
		operationId: string | null;
		request: Promise<WorkerModelSyncResult>;
	} | null = null;

	constructor(
		private readonly dependencies: WorkerModelSyncDependencies,
		options?: WorkerModelSyncOptions,
	) {
		this.read = options?.read ?? fetchWorkerModelSync;
		this.start = options?.start ?? startWorkerModelSync;
		this.redownloadRequest = options?.redownload ?? startWorkerModelRedownload;
		this.cancelRequest = options?.cancel ?? cancelWorkerModelSync;
		this.pollMs = options?.pollMs ?? 1_000;
	}

	refreshEditorTarget(): void {
		const session = this.dependencies.state.getState();
		this.target = null;
		this.targetOperation += 1;
		const intent = ++this.intentOperation;
		if (session.connection.status !== "connected") return;
		this.dependencies.invalidateSetup();
		if (this.cancellation === null) this.dependencies.requests.invalidate("models");
		this.dependencies.invalidateVerification();
		this.reprojectServerState();
		const generation = this.dependencies.requests.currentGeneration;
		void this.refreshTarget(generation).then(async () => {
			if (!this.isCurrent(generation, intent)) return;
			await this.load(generation, false);
			if (!this.isCurrent(generation, intent)) return;
			await this.cancelStaleOperation();
		});
	}

	async sync(): Promise<WorkerModelSyncResult> {
		const setupError = this.dependencies.setupStartError();
		if (setupError !== null) return { ok: false, error: setupError };
		const intent = ++this.intentOperation;
		if (this.cancellation !== null) {
			const result = await this.cancellation.request;
			if (!result.ok) return result;
			if (intent !== this.intentOperation) return replacedResult();
		}
		const generation = this.dependencies.requests.currentGeneration;
		this.dependencies.requests.clearPoll("models");
		this.setState({ status: "loading" });
		let request: ModelSyncRequest;
		try {
			request = await this.dependencies.buildPlan();
		} catch (error) {
			return this.fail(generation, errorMessage(error));
		}
		if (!this.isCurrent(generation, intent)) return replacedResult();
		this.target = { models: request.models };
		const credential = this.dependencies.getCredential();
		if (credential === null) {
			return this.fail(generation, "No active Worker connection is available.");
		}
		const result = await this.dependencies.requests.run(
			"models",
			generation,
			(requestFetch) => this.start(credential, request, requestFetch),
		);
		if (result === null) return replacedResult();
		if (!result.ok) {
			const retryable =
				result.error === SYNC_IN_PROGRESS_ERROR || result.retryable === true;
			this.setState({ status: "unavailable", error: result.error, retryable });
			if (retryable) this.schedulePoll(generation);
			return result;
		}
		const state = this.setServerState(result.state);
		if (modelRunning(state)) this.schedulePoll(generation);
		return { ok: true, state };
	}

	async redownload(path: string): Promise<WorkerModelSyncResult> {
		const setupError = this.dependencies.setupStartError();
		if (setupError !== null) return { ok: false, error: setupError };
		if (this.serverState?.capabilities?.forceRedownload !== true) {
			return {
				ok: false,
				error: "This Worker does not support individual model redownload.",
			};
		}
		const intent = ++this.intentOperation;
		if (this.cancellation !== null) {
			const result = await this.cancellation.request;
			if (!result.ok) return result;
			if (intent !== this.intentOperation) return replacedResult();
		}
		const generation = this.dependencies.requests.currentGeneration;
		this.dependencies.requests.clearPoll("models");
		let request: ModelSyncRequest;
		try {
			request = await this.dependencies.buildPlan();
		} catch (error) {
			return this.fail(generation, errorMessage(error));
		}
		if (!this.isCurrent(generation, intent)) return replacedResult();
		const target = request.models.find((candidate) => candidate.path === path);
		if (target === undefined) {
			return {
				ok: false,
				error: "The selected model is no longer part of the Editor sync target.",
			};
		}
		this.target = { models: request.models };
		const credential = this.dependencies.getCredential();
		if (credential === null) {
			return this.fail(generation, "No active Worker connection is available.");
		}
		const token = request.credentials[target.artifact.provider];
		const redownloadRequest: ModelSyncRequest = {
			models: [target],
			credentials: token === undefined ? {} : { [target.artifact.provider]: token },
		};
		const result = await this.dependencies.requests.run(
			"models",
			generation,
			(requestFetch) =>
				this.redownloadRequest(credential, redownloadRequest, requestFetch),
		);
		if (result === null) return replacedResult();
		if (!result.ok) {
			if (result.retryable === true) this.schedulePoll(generation);
			return result;
		}
		if (
			result.state.operationKind !== "redownload" ||
			result.state.target.models.length !== 1 ||
			!sameModelSyncTarget(result.state.target.models[0] as typeof target, target)
		) {
			const error = "The Worker returned an invalid model redownload status.";
			this.serverState = null;
			this.setState({ status: "unavailable", error, retryable: false });
			return { ok: false, error };
		}
		const state = this.setServerState(result.state);
		if (modelRunning(state)) this.schedulePoll(generation);
		return { ok: true, state };
	}

	cancel(): Promise<WorkerModelSyncResult> {
		return this.cancelOperation(this.serverState?.operationId ?? null);
	}

	cancelStaleOperation(): Promise<WorkerModelSyncResult> | null {
		const state = this.serverState;
		const target = this.target;
		if (
			state === null ||
			target === null ||
			state.operationId === null ||
			state.target === null ||
			(state.status !== "checking" &&
				state.status !== "syncing" &&
				state.status !== "canceling") ||
			operationMatchesTarget(state, target)
		) {
			return null;
		}
		return this.cancelOperation(state.operationId);
	}

	async refreshTarget(
		generation: number,
	): Promise<Pick<ModelSyncRequest, "models"> | null> {
		const operation = ++this.targetOperation;
		let request: ModelSyncRequest;
		try {
			request = await this.dependencies.buildPlan();
		} catch {
			if (this.isTargetCurrent(generation, operation)) {
				this.target = null;
				this.targetModels = null;
				this.reprojectServerState();
			}
			return null;
		}
		if (!this.isTargetCurrent(generation, operation)) return null;
		const target = { models: request.models };
		const currentModels = this.targetModels;
		const preserveState =
			currentModels !== null &&
			sameModelSyncTargets(
				currentModels.map((model) => model.target),
				target.models,
			);
		this.targetModels = target.models.map((model, index) => {
			const current = preserveState ? currentModels[index] : undefined;
			return current === undefined
				? { target: model, status: "not-downloaded", downloadedBytes: 0 }
				: { ...current, target: model };
		});
		this.target = target;
		this.reprojectServerState();
		return target;
	}

	async load(generation: number, showLoading: boolean): Promise<void> {
		const credential = this.dependencies.getCredential();
		if (credential === null) return;
		if (showLoading) this.setState({ status: "loading" });
		const result = await this.dependencies.requests.run(
			"models",
			generation,
			(requestFetch) => this.read(credential, requestFetch),
		);
		if (result === null) return;
		if (!result.ok) {
			this.serverState = null;
			this.setState({
				status: "unavailable",
				error: result.error,
				retryable: result.retryable === true,
			});
			if (result.retryable === true) this.schedulePoll(generation);
			return;
		}
		const state = this.setServerState(result.state);
		if (modelRunning(state)) this.schedulePoll(generation);
	}

	markUnavailable(error: string): void {
		this.setState({ status: "unavailable", error, retryable: false });
	}

	reset(): void {
		this.target = null;
		this.targetOperation += 1;
		this.intentOperation += 1;
		this.serverState = null;
		this.targetModels = null;
		this.cancellation = null;
	}

	private cancelOperation(operationId: string | null): Promise<WorkerModelSyncResult> {
		if (this.cancellation !== null) return this.cancellation.request;
		const cancellation = this.requestCancellation(operationId);
		this.cancellation = { operationId, request: cancellation };
		const clear = () => {
			if (this.cancellation?.request === cancellation) this.cancellation = null;
		};
		void cancellation.then(clear, clear);
		return cancellation;
	}

	private async requestCancellation(
		operationId: string | null,
	): Promise<WorkerModelSyncResult> {
		const generation = this.dependencies.requests.currentGeneration;
		this.dependencies.requests.clearPoll("models");
		const credential = this.dependencies.getCredential();
		if (credential === null) {
			return this.fail(generation, "No active Worker connection is available.");
		}
		const result = await this.dependencies.requests.run(
			"models",
			generation,
			(requestFetch) => this.cancelRequest(credential, operationId, requestFetch),
		);
		if (result === null) return replacedResult();
		if (!result.ok) {
			this.setState({
				status: "unavailable",
				error: result.error,
				retryable: result.retryable === true,
			});
			if (result.retryable === true) this.schedulePoll(generation);
			return result;
		}
		const state = this.setServerState(result.state);
		if (modelRunning(state)) this.schedulePoll(generation);
		return { ok: true, state };
	}

	private setServerState(state: ModelSyncServerState): WorkerModelSyncState {
		const normalized = parseModelSyncState(state);
		if (normalized === null) {
			this.serverState = null;
			return this.setState({
				status: "unavailable",
				error: "The Worker returned an invalid model sync status.",
				retryable: false,
			});
		}
		this.serverState = normalized;
		return this.setState(this.projectServerState(normalized));
	}

	private projectServerState(state: ModelSyncServerState): WorkerModelSyncState {
		const targetStatus =
			this.target === null || state.target === null
				? "unknown"
				: operationMatchesTarget(state, this.target)
					? "current"
					: "stale";
		let targetModels = this.targetModels;
		if (
			state.target !== null &&
			state.modelSnapshot !== undefined &&
			targetStatus === "current"
		) {
			const operationModels = projectSnapshot(state);
			if (state.operationKind === "redownload" && targetModels !== null) {
				const redownload = operationModels[0];
				targetModels = targetModels.map((model) =>
					redownload !== undefined &&
					sameModelSyncTarget(model.target, redownload.target)
						? redownload
						: model,
				);
			} else {
				targetModels = operationModels;
			}
		}
		if (targetStatus === "current" && targetModels !== null) {
			targetModels = targetModels.map((model, index) => {
				const target = this.target?.models[index];
				return target !== undefined && sameModelSyncTarget(model.target, target)
					? { ...model, target }
					: model;
			});
			this.targetModels = targetModels;
		}
		return {
			...state,
			targetStatus,
			...(targetModels === null ? {} : { targetModels }),
		};
	}

	private reprojectServerState(): void {
		if (this.serverState !== null)
			this.setState(this.projectServerState(this.serverState));
	}

	private setState(state: WorkerModelSyncState): WorkerModelSyncState {
		const changed = this.dependencies.state.setModels(state);
		if (changed) this.dependencies.invalidateVerification();
		return state;
	}

	private fail(generation: number, error: string): WorkerModelSyncResult {
		if (!this.dependencies.requests.isCurrent(generation)) return replacedResult();
		this.setState({ status: "unavailable", error, retryable: false });
		return { ok: false, error };
	}

	private schedulePoll(generation: number): void {
		this.dependencies.requests.schedule(
			"models",
			generation,
			() => this.load(generation, false),
			this.pollMs,
			this.dependencies.getCredential() !== null,
		);
	}

	private isCurrent(generation: number, intent: number): boolean {
		return (
			this.dependencies.requests.isCurrent(generation) &&
			intent === this.intentOperation
		);
	}

	private isTargetCurrent(generation: number, operation: number): boolean {
		return (
			this.dependencies.requests.isCurrent(generation) &&
			operation === this.targetOperation
		);
	}
}

export function modelRunning(state: WorkerModelSyncState): boolean {
	return (
		state.status === "checking" ||
		state.status === "syncing" ||
		state.status === "canceling"
	);
}

export function modelRedownloadRunning(state: WorkerModelSyncState): boolean {
	return (
		"operationKind" in state &&
		state.operationKind === "redownload" &&
		modelRunning(state)
	);
}

export function modelTerminal(state: WorkerModelSyncState): boolean {
	return (
		state.status === "synced" ||
		state.status === "canceled" ||
		state.status === "failed" ||
		(state.status === "unavailable" && !state.retryable) ||
		state.status === "disconnected"
	);
}

function projectSnapshot(state: ModelSyncServerState): WorkerModelTargetState[] {
	if (state.target === null || state.modelSnapshot === undefined) return [];
	return state.target.models.map((target, index) => {
		const snapshot = state.modelSnapshot?.models[index];
		if (snapshot === undefined)
			throw new Error("The Worker model snapshot is incomplete.");
		const status =
			state.operationKind === "redownload" &&
			state.status === "failed" &&
			snapshot.status === "not-downloaded"
				? "redownload-failed"
				: state.operationKind === "redownload" &&
						(state.status === "checking" ||
							state.status === "syncing" ||
							state.status === "canceling")
					? "redownloading"
					: snapshot.status;
		return {
			target,
			status,
			downloadedBytes: snapshot.downloadedBytes,
			...(snapshot.error === undefined ? {} : { error: snapshot.error }),
		};
	});
}

function operationMatchesTarget(
	state: ModelSyncServerState,
	target: Pick<ModelSyncRequest, "models">,
): boolean {
	if (state.target === null) return false;
	if (state.operationKind !== "redownload") {
		return sameModelSyncTargets(state.target.models, target.models);
	}
	const redownloadTarget = state.target.models[0];
	return (
		redownloadTarget !== undefined &&
		target.models.some((model) => sameModelSyncTarget(model, redownloadTarget))
	);
}

function replacedResult(): WorkerModelSyncResult {
	return { ok: false, error: "A newer Worker model request replaced this one." };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
