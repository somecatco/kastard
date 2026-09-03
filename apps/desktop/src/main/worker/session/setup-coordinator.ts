import type {
	ConnectionResult,
	SyncVerificationResult,
	WorkerCustomNodeSyncState,
	WorkerModelSyncState,
	WorkerSessionState,
} from "../../../shared/api";
import {
	customNodeRunning,
	customNodeTerminal,
	type WorkerCustomNodeSync,
} from "./custom-node-sync";
import {
	replacedConnectionResult,
	type SetupPreparationOutcome,
	type SetupVerificationOutcome,
} from "./machine";
import {
	modelRedownloadRunning,
	modelRunning,
	modelTerminal,
	type WorkerModelSync,
} from "./model-sync";
import type { WorkerSessionRequestScope, WorkerSessionResource } from "./request-scope";
import type { WorkerRuntimeState } from "./runtime-state";
import type { WorkerSessionStateStore } from "./state";

type WorkerSetupCoordinatorDependencies = {
	state: WorkerSessionStateStore;
	requests: WorkerSessionRequestScope<WorkerSessionResource>;
	customNodes: WorkerCustomNodeSync;
	models: WorkerModelSync;
	runtime: WorkerRuntimeState;
	verify: () => Promise<SyncVerificationResult>;
	isCurrent: (generation: number) => boolean;
	isSetupCurrent: (signal: AbortSignal, generation: number) => boolean;
	waitForLifecycle: (
		predicate: (state: WorkerSessionState) => boolean,
		signal: AbortSignal,
		generation: number,
	) => Promise<WorkerSessionState | null>;
	sendCancel: () => void;
	waitForCancellation: () => Promise<ConnectionResult>;
};

const MAX_TARGET_START_RETRIES = 3;

export class WorkerSetupCoordinator {
	constructor(private readonly dependencies: WorkerSetupCoordinatorDependencies) {}

	async cancel(): Promise<ConnectionResult> {
		const state = this.dependencies.state.getState();
		if (state.connection.status !== "connected") {
			return {
				ok: false,
				error: "Worker setup cancellation requires an active connection.",
			};
		}
		if (state.setup.status !== "running" || state.setup.phase !== "preparation") {
			return { ok: false, error: "Worker synchronization is not running." };
		}

		const customNodesActive =
			state.customNodes.status === "loading" || customNodeRunning(state.customNodes);
		const modelsActive =
			state.models.status === "loading" || modelRunning(state.models);
		if (!customNodesActive && !modelsActive) {
			return { ok: false, error: "Worker synchronization has not started." };
		}

		this.dependencies.sendCancel();
		return this.dependencies.waitForCancellation();
	}

	async cancelWork(signal: AbortSignal): Promise<ConnectionResult> {
		const state = this.dependencies.state.getState();
		const generation = this.dependencies.requests.currentGeneration;
		const cancellations: Array<{
			label: string;
			request: Promise<ConnectionResult>;
		}> = [];
		if (
			state.customNodes.status === "loading" ||
			state.customNodes.status === "syncing"
		) {
			cancellations.push({
				label: "Custom node synchronization",
				request: this.cancelCustomNodes(state.customNodes, signal, generation),
			});
		}
		if (
			state.models.status === "loading" ||
			state.models.status === "checking" ||
			state.models.status === "syncing"
		) {
			cancellations.push({
				label: "Model synchronization",
				request: this.cancelModels(state.models, signal, generation),
			});
		}

		const results = await Promise.allSettled(
			cancellations.map(({ request }) => request),
		);
		if (signal.aborted || !this.dependencies.isCurrent(generation)) {
			return { ok: false, error: "A newer Worker setup replaced this cancellation." };
		}
		const errors = results.flatMap((result, index) => {
			const label = cancellations[index]?.label ?? "Worker synchronization";
			if (result.status === "rejected") {
				return [`${label}: ${errorMessage(result.reason)}`];
			}
			return result.value.ok ? [] : [`${label}: ${result.value.error}`];
		});
		if (errors.length > 0) {
			return {
				ok: false,
				error: `Worker setup stopped, but synchronization cancellation failed. ${errors.join(" ")}`,
			};
		}
		return { ok: true };
	}

	async prepare(
		signal: AbortSignal,
		initialRefresh: Promise<void>,
	): Promise<SetupPreparationOutcome> {
		const generation = this.dependencies.requests.currentGeneration;
		try {
			await initialRefresh;
			if (!this.dependencies.isSetupCurrent(signal, generation)) {
				return { status: "canceled" };
			}
			const customNodeCancellation =
				this.dependencies.customNodes.cancelStaleOperation();
			await this.dependencies.runtime.ensureBackend(signal, generation);
			if (!this.dependencies.isSetupCurrent(signal, generation)) {
				return { status: "canceled" };
			}
			if (customNodeCancellation !== null) {
				const cancellation = await customNodeCancellation;
				if (!this.dependencies.isSetupCurrent(signal, generation)) {
					return { status: "canceled" };
				}
				if (!cancellation.ok) {
					return {
						status: "failed",
						error: `Custom node synchronization could not be reset. ${cancellation.error}`,
					};
				}
			}

			let initialCustomNodes: WorkerCustomNodeSyncState | null = null;
			let customNodeFailure: string | null = null;
			try {
				initialCustomNodes = await this.runCustomNodeTarget(signal, generation);
			} catch (error) {
				customNodeFailure = `Custom node synchronization failed. ${errorMessage(error)}`;
				this.dependencies.customNodes.markUnavailable(errorMessage(error));
			}
			if (
				(customNodeFailure === null && initialCustomNodes === null) ||
				!this.dependencies.isSetupCurrent(signal, generation)
			) {
				return { status: "canceled" };
			}
			const settled = await this.waitForPreparationTargets(
				customNodeFailure === null,
				false,
				false,
				signal,
				generation,
			);
			if (settled === null) return { status: "canceled" };
			const customNodes = customNodeFailure === null ? settled.customNodes : null;
			if (customNodes?.status === "canceled") return { status: "canceled" };
			const error =
				customNodeFailure ??
				(customNodes === null
					? null
					: syncError("Custom node synchronization", customNodes));
			return error === null ? { status: "ready" } : { status: "ready", error };
		} catch (error) {
			return this.dependencies.isSetupCurrent(signal, generation)
				? { status: "failed", error: errorMessage(error) }
				: { status: "canceled" };
		}
	}

	async synchronizeModels(
		signal: AbortSignal,
		initialRefresh: Promise<void>,
		syncModels: boolean,
	): Promise<SetupPreparationOutcome> {
		const generation = this.dependencies.requests.currentGeneration;
		try {
			await initialRefresh;
			if (!this.dependencies.isSetupCurrent(signal, generation)) {
				return { status: "canceled" };
			}
			let initialModels: WorkerModelSyncState | null = null;
			let modelFailure: string | null = null;
			try {
				initialModels = await (syncModels
					? this.runModelTarget(signal, generation)
					: this.observeModelTarget(signal, generation));
			} catch (error) {
				modelFailure = `Model synchronization failed. ${errorMessage(error)}`;
				this.dependencies.models.markUnavailable(errorMessage(error));
			}
			if (
				(modelFailure === null && initialModels === null) ||
				!this.dependencies.isSetupCurrent(signal, generation)
			) {
				return { status: "canceled" };
			}
			const settled = await this.waitForPreparationTargets(
				false,
				modelFailure === null,
				syncModels,
				signal,
				generation,
			);
			if (settled === null) return { status: "canceled" };
			const models = modelFailure === null ? settled.models : null;
			if (syncModels && models?.status === "canceled") {
				return { status: "canceled" };
			}
			const error =
				modelFailure ??
				(syncModels && models !== null
					? syncError("Model synchronization", models)
					: null);
			return error === null ? { status: "ready" } : { status: "ready", error };
		} catch (error) {
			return this.dependencies.isSetupCurrent(signal, generation)
				? {
						status: "ready",
						error: `Model synchronization failed. ${errorMessage(error)}`,
					}
				: { status: "canceled" };
		}
	}

	async settleSynchronization(
		signal: AbortSignal,
		syncModels: boolean,
	): Promise<SetupPreparationOutcome> {
		const generation = this.dependencies.requests.currentGeneration;
		const settled = await this.waitForPreparationTargets(
			true,
			true,
			syncModels,
			signal,
			generation,
		);
		if (settled === null) return { status: "canceled" };
		if (
			settled.customNodes.status === "canceled" ||
			(syncModels && settled.models.status === "canceled")
		) {
			return { status: "canceled" };
		}
		return { status: "ready" };
	}

	async verify(signal: AbortSignal): Promise<SetupVerificationOutcome> {
		const generation = this.dependencies.requests.currentGeneration;
		try {
			const verification = await this.dependencies.verify();
			if (!this.dependencies.isSetupCurrent(signal, generation)) {
				return { status: "failed", error: "A newer Worker setup replaced this one." };
			}
			if (!verification.ok) return { status: "failed", error: verification.error };
			if (verification.verification.status !== "synced") {
				return {
					status: "failed",
					error: verificationFailure(verification.verification.status),
					verification: verification.verification,
				};
			}
			return { status: "ready", verification: verification.verification };
		} catch (error) {
			return { status: "failed", error: errorMessage(error) };
		}
	}

	async startComfy(signal: AbortSignal): Promise<ConnectionResult> {
		const generation = this.dependencies.requests.currentGeneration;
		try {
			const compatible = await this.dependencies.waitForLifecycle(
				(state) => !modelRedownloadRunning(state.models),
				signal,
				generation,
			);
			if (compatible === null) return replacedConnectionResult();
			const comfy = await this.dependencies.runtime.startComfy(signal, generation);
			if (comfy === null || !this.dependencies.isSetupCurrent(signal, generation)) {
				return { ok: false, error: "A newer Worker setup replaced this one." };
			}
			return comfy.ok
				? { ok: true }
				: {
						ok: false,
						error: `Worker ComfyUI could not start. ${comfy.error}`,
					};
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	private async cancelCustomNodes(
		state: WorkerCustomNodeSyncState,
		signal: AbortSignal,
		generation: number,
	): Promise<ConnectionResult> {
		if (state.status === "loading") {
			const settled = await this.dependencies.waitForLifecycle(
				(current) => current.customNodes.status !== "loading",
				signal,
				generation,
			);
			if (settled === null) return replacedConnectionResult();
			state = settled.customNodes;
		}
		return state.status === "syncing"
			? this.dependencies.customNodes.cancel()
			: { ok: true };
	}

	private async cancelModels(
		state: WorkerModelSyncState,
		signal: AbortSignal,
		generation: number,
	): Promise<ConnectionResult> {
		if (state.status === "loading") {
			const settled = await this.dependencies.waitForLifecycle(
				(current) => current.models.status !== "loading",
				signal,
				generation,
			);
			if (settled === null) return replacedConnectionResult();
			state = settled.models;
		}
		return state.status === "checking" || state.status === "syncing"
			? this.dependencies.models.cancel()
			: { ok: true };
	}

	private waitForPreparationTargets(
		waitForCustomNodes: boolean,
		waitForModels: boolean,
		syncModels: boolean,
		signal: AbortSignal,
		generation: number,
	): Promise<WorkerSessionState | null> {
		return this.dependencies.waitForLifecycle(
			(state) =>
				(!waitForCustomNodes || customNodeTerminal(state.customNodes)) &&
				(!waitForModels ||
					modelTerminal(state.models) ||
					(!syncModels && state.models.status === "idle")),
			signal,
			generation,
		);
	}

	private async runCustomNodeTarget(
		signal: AbortSignal,
		generation: number,
	): Promise<WorkerCustomNodeSyncState | null> {
		return this.runTarget(
			(state) => state.customNodes,
			customNodeRunning,
			customNodeTerminal,
			() => this.dependencies.customNodes.sync(),
			signal,
			generation,
		);
	}

	private async runModelTarget(
		signal: AbortSignal,
		generation: number,
	): Promise<WorkerModelSyncState | null> {
		return this.runTarget(
			(state) => state.models,
			modelRunning,
			modelTerminal,
			() => this.dependencies.models.sync(),
			signal,
			generation,
		);
	}

	private async observeModelTarget(
		signal: AbortSignal,
		generation: number,
	): Promise<WorkerModelSyncState | null> {
		const state = this.dependencies.state.getState().models;
		return state.status === "loading" || modelRunning(state)
			? this.waitForLifecycleTarget(
					(current) => current.models,
					modelTerminal,
					signal,
					generation,
				)
			: state;
	}

	private async runTarget<State extends { status: string; retryable?: boolean }>(
		select: (state: WorkerSessionState) => State,
		running: (state: State) => boolean,
		terminal: (state: State) => boolean,
		start: () => Promise<{ ok: true } | { ok: false; error: string }>,
		signal: AbortSignal,
		generation: number,
	): Promise<State | null> {
		let state = select(this.dependencies.state.getState());
		if (state.status === "loading" || running(state)) {
			const settled = await this.waitForLifecycleTarget(
				select,
				terminal,
				signal,
				generation,
			);
			if (settled === null) return null;
			state = settled;
		}
		for (let retries = 0; retries <= MAX_TARGET_START_RETRIES; retries += 1) {
			const result = await start();
			if (!this.dependencies.isSetupCurrent(signal, generation)) return null;
			const retryableState = select(this.dependencies.state.getState());
			if (
				!result.ok &&
				retryableState.status === "unavailable" &&
				retryableState.retryable === true
			) {
				const observed = await this.dependencies.waitForLifecycle(
					(current) => {
						const selected = select(current);
						return selected.status !== "unavailable" || selected.retryable !== true;
					},
					signal,
					generation,
				);
				if (observed === null) return null;
				const observedState = select(observed);
				if (observedState.status === "unavailable") return observedState;
				let settledState = observedState;
				if (running(observedState)) {
					const settled = await this.waitForLifecycleTarget(
						select,
						terminal,
						signal,
						generation,
					);
					if (settled === null) return null;
					settledState = settled;
				}
				if (retries < MAX_TARGET_START_RETRIES) continue;
				return terminal(settledState) ? settledState : retryableState;
			}
			return this.waitForLifecycleTarget(select, terminal, signal, generation);
		}
		return state;
	}

	private async waitForLifecycleTarget<State>(
		select: (state: WorkerSessionState) => State,
		terminal: (state: State) => boolean,
		signal: AbortSignal,
		generation: number,
	): Promise<State | null> {
		const current = select(this.dependencies.state.getState());
		if (terminal(current)) return current;
		const settled = await this.dependencies.waitForLifecycle(
			(state) => terminal(select(state)),
			signal,
			generation,
		);
		return settled === null ? null : select(settled);
	}
}

function syncError(
	label: string,
	state: WorkerCustomNodeSyncState | WorkerModelSyncState,
): string | null {
	if (state.status === "failed" || state.status === "unavailable") {
		return `${label} failed. ${state.error}`;
	}
	if (state.status === "disconnected") return `${label} was interrupted.`;
	return null;
}

function verificationFailure(
	status: "out-of-sync" | "syncing" | "unavailable",
): string {
	return {
		"out-of-sync":
			"Worker setup completed synchronization, but the Worker is still out of sync.",
		syncing:
			"Worker setup could not finish verification while synchronization was still in progress.",
		unavailable:
			"Worker setup completed synchronization, but the Worker state could not be verified.",
	}[status];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
