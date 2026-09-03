import type { WorkerComfyMemoryCleanupRequest } from "@kastard/common";
import type {
	BackendState,
	BackendTarget,
	ConnectionResult,
	WorkerBackendResult,
	WorkerBackendState,
	WorkerComfyState,
	WorkerSessionState,
} from "../../../shared/api";
import {
	type BackendRequestResult,
	fetchWorkerBackend,
	fetchWorkerComfy,
	fetchWorkerSystemMetrics,
	freeWorkerComfyMemory,
	prepareWorkerBackend,
	restartWorkerComfy,
	startWorkerComfy,
	type WorkerComfyRequestResult,
	type WorkerSessionCredential,
} from "../client";
import { replacedConnectionResult } from "./machine";
import type {
	WorkerSessionRequestFetch,
	WorkerSessionRequestScope,
	WorkerSessionResource,
} from "./request-scope";
import type { WorkerSessionStateStore } from "./state";

export type WorkerRuntimeStateOptions = {
	readBackend?: (
		credential: WorkerSessionCredential,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<BackendRequestResult>;
	prepareBackend?: (
		credential: WorkerSessionCredential,
		target: BackendTarget,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<BackendRequestResult>;
	readComfy?: (
		credential: WorkerSessionCredential,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<WorkerComfyRequestResult>;
	startComfy?: (
		credential: WorkerSessionCredential,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<WorkerComfyRequestResult>;
	restartComfy?: (
		credential: WorkerSessionCredential,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<WorkerComfyRequestResult>;
	freeComfyMemory?: typeof freeWorkerComfyMemory;
	readSystemMetrics?: typeof fetchWorkerSystemMetrics;
	pollMs?: number;
	systemMetricsPollMs?: number;
};

type WorkerRuntimeStateDependencies = {
	state: WorkerSessionStateStore;
	requests: WorkerSessionRequestScope<WorkerSessionResource>;
	getCredential: () => WorkerSessionCredential | null;
	getBackendTarget: () => BackendTarget | null;
	getBackendTargetError: () => string | undefined;
	invalidateVerification: () => void;
	isWorkflowRunning: () => boolean;
	waitForLifecycle: (
		predicate: (state: WorkerSessionState) => boolean,
		signal: AbortSignal,
		generation: number,
	) => Promise<WorkerSessionState | null>;
	isSetupCurrent: (signal: AbortSignal, generation: number) => boolean;
};

export class WorkerRuntimeState {
	private readonly readBackend;
	private readonly prepareBackendRequest;
	private readonly readComfy;
	private readonly startComfyRequest;
	private readonly restartComfyRequest;
	private readonly freeMemoryRequest;
	private readonly readMetrics;
	private readonly pollMs;
	private readonly metricsPollMs;
	private metricsEnabled = true;

	constructor(
		private readonly dependencies: WorkerRuntimeStateDependencies,
		options?: WorkerRuntimeStateOptions,
	) {
		this.readBackend = options?.readBackend ?? fetchWorkerBackend;
		this.prepareBackendRequest = options?.prepareBackend ?? prepareWorkerBackend;
		this.readComfy = options?.readComfy ?? fetchWorkerComfy;
		this.startComfyRequest = options?.startComfy ?? startWorkerComfy;
		this.restartComfyRequest = options?.restartComfy ?? restartWorkerComfy;
		this.freeMemoryRequest = options?.freeComfyMemory ?? freeWorkerComfyMemory;
		this.readMetrics = options?.readSystemMetrics ?? fetchWorkerSystemMetrics;
		this.pollMs = options?.pollMs ?? 1_000;
		this.metricsPollMs = options?.systemMetricsPollMs ?? 1_000;
	}

	get systemMetricsEnabled(): boolean {
		return this.metricsEnabled;
	}

	setSystemMetricsEnabled(enabled: boolean, apply: boolean): void {
		const changed = enabled !== this.metricsEnabled;
		this.metricsEnabled = enabled;
		if (changed && apply) this.applySystemMetricsSetting();
	}

	refreshEditorComfyVersion(): void {
		const backend = this.dependencies.state.getState().backend;
		if (
			backend.status === "unavailable" &&
			this.dependencies.getBackendTarget() !== null
		) {
			void this.prepareBackend().catch(() => undefined);
			return;
		}
		const editorComfyVersion = this.editorComfyVersion();
		if (backend.editorComfyVersion === editorComfyVersion) return;
		this.setBackend({ ...backend, editorComfyVersion });
	}

	async prepareBackend(): Promise<WorkerBackendResult> {
		const target = this.dependencies.getBackendTarget();
		if (target === null) {
			const error =
				this.dependencies.getBackendTargetError() ??
				"The Worker backend target is unavailable.";
			this.setBackend({
				status: "unavailable",
				editorComfyVersion: "",
				error,
				retryable: false,
			});
			return { ok: false, error };
		}
		const credential = this.dependencies.getCredential();
		if (credential === null) {
			return { ok: false, error: "No active Worker connection is available." };
		}
		const generation = this.dependencies.requests.currentGeneration;
		this.dependencies.requests.clearPoll("backend");
		this.setBackend({ status: "loading", editorComfyVersion: target.version });
		const result = await this.dependencies.requests.run(
			"backend",
			generation,
			(requestFetch) => this.prepareBackendRequest(credential, target, requestFetch),
		);
		if (result === null) return replacedBackendResult();
		if (!result.ok) {
			this.setBackend({
				status: "unavailable",
				editorComfyVersion: target.version,
				error: result.error,
				retryable: result.retryable === true,
			});
			if (result.retryable === true) this.scheduleBackendPoll(generation);
			return result;
		}
		const state = this.setBackendState(result.state);
		if (result.state.status === "preparing") this.scheduleBackendPoll(generation);
		return { ok: true, state };
	}

	async restartComfy(): Promise<ConnectionResult> {
		if (this.dependencies.state.getState().connection.status !== "connected") {
			return {
				ok: false,
				error: "Worker ComfyUI restart requires an active Worker connection.",
			};
		}
		if (this.dependencies.isWorkflowRunning()) {
			return {
				ok: false,
				error: "Worker ComfyUI cannot restart while a workflow is running.",
			};
		}
		const credential = this.dependencies.getCredential();
		if (credential === null) {
			return { ok: false, error: "No active Worker connection is available." };
		}
		const generation = this.dependencies.requests.currentGeneration;
		this.dependencies.requests.clearPoll("comfy");
		this.setComfy({ status: "loading" });
		const result = await this.dependencies.requests.run(
			"comfy",
			generation,
			(requestFetch) => this.restartComfyRequest(credential, requestFetch),
		);
		if (result === null) return replacedConnectionResult();
		if (!result.ok) {
			await this.loadComfy(generation, true);
			return { ok: false, error: result.error };
		}
		this.setComfy(result.state);
		if (result.state.status === "starting") this.scheduleComfyPoll(generation);
		return { ok: true };
	}

	async freeComfyMemory(
		request: WorkerComfyMemoryCleanupRequest,
	): Promise<ConnectionResult> {
		if (this.dependencies.state.getState().connection.status !== "connected") {
			return {
				ok: false,
				error: "Worker ComfyUI memory cleanup requires an active Worker connection.",
			};
		}
		const credential = this.dependencies.getCredential();
		if (credential === null) {
			return { ok: false, error: "No active Worker connection is available." };
		}
		const result = await this.dependencies.requests.run(
			Symbol("comfyMemory"),
			this.dependencies.requests.currentGeneration,
			(requestFetch) => this.freeMemoryRequest(credential, request, requestFetch),
		);
		if (result === null) return replacedConnectionResult();
		return result.ok ? { ok: true } : { ok: false, error: result.error };
	}

	async ensureBackend(signal: AbortSignal, generation: number): Promise<void> {
		let state = this.dependencies.state.getState().backend;
		if (
			state.status === "loading" ||
			state.status === "preparing" ||
			(state.status === "unavailable" && state.retryable)
		) {
			const settled = await this.dependencies.waitForLifecycle(
				(current) => backendTerminal(current.backend),
				signal,
				generation,
			);
			if (settled === null) return;
			state = settled.backend;
			if (state.status === "failed") throw new Error(state.error);
		}
		if (backendMatches(state)) return;
		if (state.status === "failed" && !state.retryable) throw new Error(state.error);
		const result = await this.prepareBackend();
		if (!this.dependencies.isSetupCurrent(signal, generation)) return;
		if (!result.ok && result.retryable !== true) throw new Error(result.error);
		state = this.dependencies.state.getState().backend;
		if (backendMatches(state)) return;
		if (backendTerminal(state)) throw new Error(backendError(state));
		const settled = await this.dependencies.waitForLifecycle(
			(current) => backendTerminal(current.backend),
			signal,
			generation,
		);
		if (settled !== null && !backendMatches(settled.backend)) {
			throw new Error(backendError(settled.backend));
		}
	}

	async startComfy(
		signal: AbortSignal,
		generation: number,
	): Promise<ConnectionResult | null> {
		let state = this.dependencies.state.getState().comfy;
		if (comfyPending(state)) {
			const settled = await this.dependencies.waitForLifecycle(
				(current) => !comfyPending(current.comfy),
				signal,
				generation,
			);
			if (settled === null) return null;
			state = settled.comfy;
		}
		if (state.status === "ready") return { ok: true };
		const credential = this.dependencies.getCredential();
		if (credential === null)
			return { ok: false, error: "No active Worker connection." };
		this.dependencies.requests.clearPoll("comfy");
		this.setComfy({ status: "loading" });
		const result = await this.dependencies.requests.run(
			"comfy",
			generation,
			(requestFetch) => this.startComfyRequest(credential, requestFetch),
		);
		if (result === null || !this.dependencies.isSetupCurrent(signal, generation)) {
			return null;
		}
		if (!result.ok) {
			this.setComfy({
				status: "unavailable",
				error: result.error,
				retryable: result.retryable === true,
			});
			if (result.retryable === true) this.scheduleComfyPoll(generation);
		} else {
			this.setComfy(result.state);
			if (result.state.status === "starting") this.scheduleComfyPoll(generation);
		}
		state = this.dependencies.state.getState().comfy;
		if (comfyPending(state)) {
			const settled = await this.dependencies.waitForLifecycle(
				(current) => !comfyPending(current.comfy),
				signal,
				generation,
			);
			if (settled === null) return null;
			state = settled.comfy;
		}
		return state.status === "ready"
			? { ok: true }
			: { ok: false, error: comfyError(state, result.ok ? undefined : result.error) };
	}

	async loadBackend(generation: number, showLoading: boolean): Promise<void> {
		const target = this.dependencies.getBackendTarget();
		if (target === null) {
			this.setBackend({
				status: "unavailable",
				editorComfyVersion: "",
				error:
					this.dependencies.getBackendTargetError() ??
					"The Worker backend target is unavailable.",
				retryable: false,
			});
			return;
		}
		const credential = this.dependencies.getCredential();
		if (credential === null) return;
		if (showLoading) {
			this.setBackend({ status: "loading", editorComfyVersion: target.version });
		}
		const result = await this.dependencies.requests.run(
			"backend",
			generation,
			(requestFetch) => this.readBackend(credential, requestFetch),
		);
		if (result === null) return;
		if (!result.ok) {
			this.setBackend({
				status: "unavailable",
				editorComfyVersion: target.version,
				error: result.error,
				retryable: result.retryable === true,
			});
			if (result.retryable === true) this.scheduleBackendPoll(generation);
			return;
		}
		this.setBackendState(result.state);
		if (result.state.status === "preparing") this.scheduleBackendPoll(generation);
	}

	async loadComfy(generation: number, showLoading: boolean): Promise<void> {
		const credential = this.dependencies.getCredential();
		if (credential === null) return;
		if (showLoading) this.setComfy({ status: "loading" });
		const result = await this.dependencies.requests.run(
			"comfy",
			generation,
			(requestFetch) => this.readComfy(credential, requestFetch),
		);
		if (result === null) return;
		if (!result.ok) {
			this.setComfy({
				status: "unavailable",
				error: result.error,
				retryable: result.retryable === true,
			});
			if (result.retryable === true) this.scheduleComfyPoll(generation);
			return;
		}
		this.setComfy(result.state);
		if (result.state.status === "starting") this.scheduleComfyPoll(generation);
	}

	async loadSystemMetrics(generation: number, showLoading: boolean): Promise<void> {
		if (!this.metricsEnabled) return;
		const credential = this.dependencies.getCredential();
		if (credential === null) return;
		this.dependencies.requests.clearPoll("systemMetrics");
		if (showLoading) this.dependencies.state.setSystemMetrics({ status: "loading" });
		const result = await this.dependencies.requests.run(
			"systemMetrics",
			generation,
			(requestFetch) => this.readMetrics(credential, requestFetch),
		);
		if (result === null) return;
		this.dependencies.state.setSystemMetrics(
			result.ok
				? { status: "available", metrics: result.state }
				: { status: "unavailable", error: result.error },
		);
		if (this.metricsEnabled) {
			this.dependencies.requests.schedule(
				"systemMetrics",
				generation,
				() => this.loadSystemMetrics(generation, false),
				this.metricsPollMs,
				this.dependencies.getCredential() !== null,
			);
		}
	}

	startSystemMetrics(generation: number, showLoading: boolean): void {
		if (!this.metricsEnabled) {
			if (this.dependencies.state.getState().connection.status === "connected") {
				this.dependencies.state.setSystemMetrics({ status: "disabled" });
			}
			return;
		}
		void this.loadSystemMetrics(generation, showLoading);
	}

	async refresh(generation: number, showLoading: boolean): Promise<void> {
		await Promise.all([
			this.loadBackend(generation, showLoading),
			this.loadComfy(generation, showLoading),
		]);
	}

	async refreshSettled(generation: number): Promise<void> {
		const session = this.dependencies.state.getState();
		const requests: Promise<void>[] = [];
		if (
			session.backend.status !== "loading" &&
			session.backend.status !== "preparing" &&
			!this.dependencies.requests.has("backend")
		) {
			requests.push(this.loadBackend(generation, false));
		}
		if (!comfyPending(session.comfy) && !this.dependencies.requests.has("comfy")) {
			requests.push(this.loadComfy(generation, false));
		}
		await Promise.all(requests);
	}

	private applySystemMetricsSetting(): void {
		if (this.metricsEnabled) {
			if (this.dependencies.state.getState().connection.status === "connected") {
				this.startSystemMetrics(this.dependencies.requests.currentGeneration, true);
			}
			return;
		}
		this.dependencies.requests.invalidate("systemMetrics");
		if (this.dependencies.state.getState().connection.status === "connected") {
			this.dependencies.state.setSystemMetrics({ status: "disabled" });
		}
	}

	private setBackend(state: WorkerBackendState): WorkerBackendState {
		const changed = this.dependencies.state.setBackend(state);
		if (changed) this.dependencies.invalidateVerification();
		return state;
	}

	private setBackendState(state: BackendState): WorkerBackendState {
		return this.setBackend({ ...state, editorComfyVersion: this.editorComfyVersion() });
	}

	private setComfy(state: WorkerComfyState): WorkerComfyState {
		this.dependencies.state.setComfy(state);
		return state;
	}

	private editorComfyVersion(): string {
		return this.dependencies.getBackendTarget()?.version ?? "";
	}

	private scheduleBackendPoll(generation: number): void {
		this.dependencies.requests.schedule(
			"backend",
			generation,
			() => this.loadBackend(generation, false),
			this.pollMs,
			this.dependencies.getCredential() !== null,
		);
	}

	private scheduleComfyPoll(generation: number): void {
		this.dependencies.requests.schedule(
			"comfy",
			generation,
			() => this.loadComfy(generation, false),
			this.pollMs,
			this.dependencies.getCredential() !== null,
		);
	}
}

export function comfyPending(state: WorkerComfyState): boolean {
	return (
		state.status === "loading" ||
		state.status === "starting" ||
		(state.status === "unavailable" && state.retryable === true)
	);
}

function backendMatches(state: WorkerBackendState): boolean {
	return state.status === "ready" && state.version === state.editorComfyVersion;
}

function backendTerminal(state: WorkerBackendState): boolean {
	return (
		state.status === "ready" ||
		state.status === "failed" ||
		(state.status === "unavailable" && !state.retryable) ||
		state.status === "not-installed" ||
		state.status === "disconnected"
	);
}

function backendError(state: WorkerBackendState): string {
	if (state.status === "failed" || state.status === "unavailable") return state.error;
	if (state.status === "ready") {
		return `Worker ComfyUI backend v${state.version} does not match Kastard ComfyUI v${state.editorComfyVersion}.`;
	}
	if (state.status === "not-installed") {
		return "The Worker ComfyUI backend is not installed.";
	}
	return "The Worker ComfyUI backend preparation was interrupted.";
}

function comfyError(state: WorkerComfyState, fallback?: string): string {
	if (state.status === "failed" || state.status === "unavailable") return state.error;
	if (fallback !== undefined) return fallback;
	if (state.status === "stopped") {
		return "Worker ComfyUI stopped before it became ready.";
	}
	if (state.status === "disconnected") {
		return "The Worker connection ended before Worker ComfyUI became ready.";
	}
	return "Worker ComfyUI did not become ready.";
}

function replacedBackendResult(): WorkerBackendResult {
	return { ok: false, error: "A newer Worker backend request replaced this one." };
}
