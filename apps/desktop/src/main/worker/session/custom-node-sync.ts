import {
	type CustomNodeInventoryEntry,
	type CustomNodeSyncNodeSnapshot,
	type CustomNodeSyncRequest,
	type CustomNodeSyncTarget,
	customNodeInventoryId,
	customNodeSyncNodeSnapshot,
	parseCustomNodeSyncServerState,
	sameCustomNodeInventoryEntry,
	sameCustomNodeSyncRequest,
} from "@kastard/common";
import type {
	CustomNodeSyncServerState,
	UnsupportedCustomNode,
	WorkerCustomNodeSyncResult,
	WorkerCustomNodeSyncState,
	WorkerCustomNodeTargetState,
} from "../../../shared/api";
import {
	cancelWorkerCustomNodeSync,
	fetchWorkerCustomNodeSync,
	type ServerCredential,
	type SyncRequestResult,
	startWorkerCustomNodeReinstall,
	startWorkerCustomNodeRemoval,
	startWorkerCustomNodeSync,
} from "../client";
import type { CustomNodeSyncPlan } from "../sync-plan";
import type {
	WorkerSessionRequestFetch,
	WorkerSessionRequestScope,
	WorkerSessionResource,
} from "./request-scope";
import type { WorkerSessionStateStore } from "./state";

const RECONCILIATION_READ_LIMIT = 5;
const SYNC_IN_PROGRESS_ERROR = "Custom nodes are already synchronizing.";

export type WorkerCustomNodeSyncOptions = {
	read?: (
		credential: ServerCredential,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<SyncRequestResult>;
	start?: (
		credential: ServerCredential,
		managerVersion: string,
		nodes: CustomNodeSyncPlan["nodes"],
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<SyncRequestResult>;
	reinstall?: (
		credential: ServerCredential,
		managerVersion: string,
		node: CustomNodeSyncTarget,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<SyncRequestResult>;
	remove?: (
		credential: ServerCredential,
		target: CustomNodeSyncRequest,
		node: CustomNodeInventoryEntry,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<SyncRequestResult>;
	cancel?: (
		credential: ServerCredential,
		operationId: string | null,
		requestFetch?: WorkerSessionRequestFetch,
	) => Promise<SyncRequestResult>;
	pollMs?: number;
};

type WorkerCustomNodeSyncDependencies = {
	state: WorkerSessionStateStore;
	requests: WorkerSessionRequestScope<WorkerSessionResource>;
	getCredential: () => ServerCredential | null;
	buildPlan: () => Promise<CustomNodeSyncPlan>;
	setupStartError: () => string | null;
	invalidateSetup: () => void;
	invalidateVerification: () => void;
};

export class WorkerCustomNodeSync {
	private readonly read;
	private readonly start;
	private readonly reinstallRequest;
	private readonly removeRequest;
	private readonly cancelRequest;
	private readonly pollMs;
	private unsupportedNodes: UnsupportedCustomNode[] = [];
	private target: CustomNodeSyncRequest | null = null;
	private targetOperation = 0;
	private intentOperation = 0;
	private mutation: symbol | null = null;
	private reconciliation: {
		operationId: string | null;
		remainingReads: number;
	} | null = null;
	private serverState: CustomNodeSyncServerState | null = null;
	private cancellation: {
		operationId: string | null;
		request: Promise<WorkerCustomNodeSyncResult>;
	} | null = null;
	private readonly waitCancels = new Set<() => void>();

	constructor(
		private readonly dependencies: WorkerCustomNodeSyncDependencies,
		options?: WorkerCustomNodeSyncOptions,
	) {
		this.read = options?.read ?? fetchWorkerCustomNodeSync;
		this.start = options?.start ?? startWorkerCustomNodeSync;
		this.reinstallRequest = options?.reinstall ?? startWorkerCustomNodeReinstall;
		this.removeRequest = options?.remove ?? startWorkerCustomNodeRemoval;
		this.cancelRequest = options?.cancel ?? cancelWorkerCustomNodeSync;
		this.pollMs = options?.pollMs ?? 1_000;
	}

	refreshEditorTarget(): void {
		const session = this.dependencies.state.getState();
		this.target = null;
		this.targetOperation += 1;
		const intent = ++this.intentOperation;
		if (session.connection.status !== "connected") return;
		this.dependencies.invalidateSetup();
		if (
			this.cancellation === null &&
			this.mutation !== null &&
			this.dependencies.requests.has("customNodes")
		) {
			this.reconciliation = {
				operationId: this.serverState?.operationId ?? null,
				remainingReads: RECONCILIATION_READ_LIMIT,
			};
		}
		if (this.cancellation === null) {
			this.dependencies.requests.invalidate("customNodes");
		}
		this.unsupportedNodes = [];
		this.dependencies.invalidateVerification();
		this.dependencies.state.setVerification(null);
		this.reprojectServerState();
		const generation = this.dependencies.requests.currentGeneration;
		void this.refreshTarget(generation).then(() => {
			if (this.reconciliation !== null) {
				void this.reconcileTargetRefresh(generation, intent);
			} else {
				void this.cancelStaleOperation();
			}
		});
	}

	async sync(): Promise<WorkerCustomNodeSyncResult> {
		const setupError = this.dependencies.setupStartError();
		if (setupError !== null) return { ok: false, error: setupError };
		const intent = ++this.intentOperation;
		const cancellation = this.cancellation;
		if (cancellation !== null) {
			const result = await cancellation.request;
			if (!result.ok) return result;
			if (intent !== this.intentOperation) return replacedResult();
		}
		const generation = this.dependencies.requests.currentGeneration;
		this.dependencies.requests.clearPoll("customNodes");
		this.setState({ status: "loading" });
		let plan: CustomNodeSyncPlan;
		try {
			plan = await this.dependencies.buildPlan();
		} catch (error) {
			const message = errorMessage(error);
			if (!this.isCurrent(generation, intent)) return replacedResult();
			this.setState({ status: "unavailable", error: message, retryable: false });
			return { ok: false, error: message };
		}
		if (!this.isCurrent(generation, intent)) return replacedResult();
		this.unsupportedNodes = plan.unsupportedNodes;
		this.target = targetFromPlan(plan);
		const credential = this.dependencies.getCredential();
		if (credential === null) return this.noConnection();
		const result = await this.runMutation(generation, (requestFetch) =>
			this.start(credential, plan.managerVersion, plan.nodes, requestFetch),
		);
		if (result === null) return replacedResult();
		if (!result.ok) return this.failRequest(result, generation);
		const state = this.setServerState(result.state);
		if (customNodeRunning(state)) this.schedulePoll(generation);
		return { ok: true, state };
	}

	async reinstall(id: string): Promise<WorkerCustomNodeSyncResult> {
		const setupError = this.dependencies.setupStartError();
		if (setupError !== null) return { ok: false, error: setupError };
		if (this.serverState?.capabilities?.forceReinstall !== true) {
			return {
				ok: false,
				error: "This Worker does not support individual custom node reinstall.",
			};
		}
		const intent = ++this.intentOperation;
		const cancellation = this.cancellation;
		if (cancellation !== null) {
			const result = await cancellation.request;
			if (!result.ok) return result;
			if (intent !== this.intentOperation) return replacedResult();
		}
		const generation = this.dependencies.requests.currentGeneration;
		this.dependencies.requests.clearPoll("customNodes");
		let plan: CustomNodeSyncPlan;
		try {
			plan = await this.dependencies.buildPlan();
		} catch (error) {
			const message = errorMessage(error);
			if (!this.isCurrent(generation, intent)) return replacedResult();
			this.setState({ status: "unavailable", error: message, retryable: false });
			return { ok: false, error: message };
		}
		if (!this.isCurrent(generation, intent)) return replacedResult();
		const node = plan.nodes.find((candidate) => candidate.id === id);
		if (node === undefined) {
			return {
				ok: false,
				error: "The selected custom node is no longer part of the Editor sync target.",
			};
		}
		this.unsupportedNodes = plan.unsupportedNodes;
		this.target = targetFromPlan(plan);
		const credential = this.dependencies.getCredential();
		if (credential === null) return this.noConnection();
		const result = await this.runMutation(generation, (requestFetch) =>
			this.reinstallRequest(credential, plan.managerVersion, node, requestFetch),
		);
		if (result === null) return replacedResult();
		if (!result.ok) return this.failRequest(result, generation);
		if (result.state.operationKind !== "reinstall") {
			const error = "The Worker returned an invalid custom node reinstall status.";
			this.setState({ status: "unavailable", error, retryable: false });
			return { ok: false, error };
		}
		const state = this.setServerState(result.state);
		if (customNodeRunning(state)) this.schedulePoll(generation);
		return { ok: true, state };
	}

	async remove(node: CustomNodeInventoryEntry): Promise<WorkerCustomNodeSyncResult> {
		const setupError = this.dependencies.setupStartError();
		if (setupError !== null) return { ok: false, error: setupError };
		if (this.serverState?.capabilities?.remove !== true) {
			return {
				ok: false,
				error: "This Worker does not support individual custom node removal.",
			};
		}
		const visibleState = this.dependencies.state.getState().customNodes;
		if (
			!("targetStatus" in visibleState) ||
			visibleState.targetStatus !== "current" ||
			!("unselectedNodes" in visibleState) ||
			visibleState.unselectedNodes === null ||
			visibleState.unselectedNodes === undefined ||
			!visibleState.unselectedNodes.some((entry) =>
				sameCustomNodeInventoryEntry(entry, node),
			)
		) {
			return {
				ok: false,
				error: "The selected custom node is no longer installed only on the Worker.",
			};
		}

		const intent = ++this.intentOperation;
		const cancellation = this.cancellation;
		if (cancellation !== null) {
			const result = await cancellation.request;
			if (!result.ok) return result;
			if (intent !== this.intentOperation) return replacedResult();
		}
		const generation = this.dependencies.requests.currentGeneration;
		this.dependencies.requests.clearPoll("customNodes");
		let plan: CustomNodeSyncPlan;
		try {
			plan = await this.dependencies.buildPlan();
		} catch (error) {
			const message = errorMessage(error);
			if (!this.isCurrent(generation, intent)) return replacedResult();
			this.setState({ status: "unavailable", error: message, retryable: false });
			return { ok: false, error: message };
		}
		if (!this.isCurrent(generation, intent)) return replacedResult();
		if (plan.nodes.some((target) => target.id === customNodeInventoryId(node))) {
			return {
				ok: false,
				error: "Selected custom nodes cannot be removed from the Worker.",
			};
		}
		this.unsupportedNodes = plan.unsupportedNodes;
		this.target = targetFromPlan(plan);
		const credential = this.dependencies.getCredential();
		if (credential === null) return this.noConnection();
		const result = await this.runMutation(generation, (requestFetch) =>
			this.removeRequest(credential, targetFromPlan(plan), node, requestFetch),
		);
		if (result === null) return replacedResult();
		if (!result.ok) return this.failRequest(result, generation);
		if (
			result.state.operationKind !== "remove" ||
			result.state.removalNode === undefined ||
			!sameCustomNodeInventoryEntry(result.state.removalNode, node)
		) {
			const error = "The Worker returned an invalid custom node removal status.";
			this.setState({ status: "unavailable", error, retryable: false });
			return { ok: false, error };
		}
		const state = this.setServerState(result.state);
		if (customNodeRunning(state)) this.schedulePoll(generation);
		return { ok: true, state };
	}

	cancel(): Promise<WorkerCustomNodeSyncResult> {
		return this.cancelOperation(this.serverState?.operationId ?? null);
	}

	markUnavailable(error: string): void {
		this.setState({ status: "unavailable", error, retryable: false });
	}

	cancelStaleOperation(): Promise<WorkerCustomNodeSyncResult> | null {
		const state = this.serverState;
		const target = this.target;
		if (
			state === null ||
			target === null ||
			state.operationId === null ||
			state.target === null ||
			(state.status !== "syncing" && state.status !== "canceling") ||
			operationMatchesTarget(state, target)
		) {
			return null;
		}
		return this.cancelOperation(state.operationId);
	}

	async refreshTarget(generation: number): Promise<CustomNodeSyncRequest | null> {
		const operation = ++this.targetOperation;
		let plan: CustomNodeSyncPlan;
		try {
			plan = await this.dependencies.buildPlan();
		} catch {
			if (this.isTargetCurrent(generation, operation)) {
				this.target = null;
				this.unsupportedNodes = [];
				this.reprojectServerState();
			}
			return null;
		}
		if (!this.isTargetCurrent(generation, operation)) return null;
		this.target = targetFromPlan(plan);
		this.unsupportedNodes = plan.unsupportedNodes;
		this.reprojectServerState();
		return this.target;
	}

	async load(generation: number, showLoading: boolean): Promise<void> {
		const credential = this.dependencies.getCredential();
		if (credential === null) return;
		if (showLoading) this.setState({ status: "loading" });
		const result = await this.dependencies.requests.run(
			"customNodes",
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
			this.continueReconciliation(generation);
			return;
		}
		const state = this.setServerState(result.state);
		if (customNodeRunning(state)) this.schedulePoll(generation);
		if (this.reconciliationObserved()) {
			this.reconciliation = null;
			await this.cancelStaleOperation();
		} else {
			this.continueReconciliation(generation);
		}
	}

	reset(): void {
		for (const cancel of [...this.waitCancels]) cancel();
		this.unsupportedNodes = [];
		this.target = null;
		this.targetOperation += 1;
		this.intentOperation += 1;
		this.mutation = null;
		this.reconciliation = null;
		this.serverState = null;
		this.cancellation = null;
	}

	private cancelOperation(
		operationId: string | null,
	): Promise<WorkerCustomNodeSyncResult> {
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
	): Promise<WorkerCustomNodeSyncResult> {
		const generation = this.dependencies.requests.currentGeneration;
		this.dependencies.requests.clearPoll("customNodes");
		const credential = this.dependencies.getCredential();
		if (credential === null) return this.noConnection();
		const result = await this.dependencies.requests.run(
			"customNodes",
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
		let state = this.setServerState(result.state);
		if (customNodeRunning(state)) {
			this.schedulePoll(generation);
			const settled = await this.waitForState(
				(current) =>
					!customNodeRunning(current.customNodes) ||
					("operationId" in current.customNodes &&
						current.customNodes.operationId !== operationId),
				generation,
			);
			if (settled === null) return replacedResult();
			state = settled.customNodes;
		}
		return { ok: true, state };
	}

	private async reconcileTargetRefresh(
		generation: number,
		intent: number,
	): Promise<void> {
		if (!this.isCurrent(generation, intent)) return;
		const credential = this.dependencies.getCredential();
		if (credential === null) return;
		const result = await this.dependencies.requests.run(
			Symbol("custom-node-reconciliation"),
			generation,
			(requestFetch) => this.read(credential, requestFetch),
		);
		if (
			result === null ||
			!this.isCurrent(generation, intent) ||
			this.reconciliation === null
		)
			return;
		if (!result.ok) {
			this.failRequest(result, generation);
			this.continueReconciliation(generation);
			return;
		}
		const state = this.setServerState(result.state);
		if (customNodeRunning(state)) this.schedulePoll(generation);
		if (this.reconciliationObserved()) {
			this.reconciliation = null;
			await this.cancelStaleOperation();
		} else {
			this.continueReconciliation(generation);
		}
	}

	private continueReconciliation(generation: number): void {
		const reconciliation = this.reconciliation;
		if (reconciliation === null) return;
		reconciliation.remainingReads -= 1;
		if (reconciliation.remainingReads === 0) {
			this.reconciliation = null;
			return;
		}
		this.schedulePoll(generation);
	}

	private reconciliationObserved(): boolean {
		return (
			this.reconciliation !== null &&
			this.serverState !== null &&
			this.serverState.operationId !== null &&
			this.serverState.operationId !== this.reconciliation.operationId
		);
	}

	private async runMutation(
		generation: number,
		request: (requestFetch: WorkerSessionRequestFetch) => Promise<SyncRequestResult>,
	): Promise<SyncRequestResult | null> {
		const mutation = Symbol("custom-node-mutation");
		this.mutation = mutation;
		try {
			return await this.dependencies.requests.run("customNodes", generation, request);
		} finally {
			if (this.mutation === mutation) this.mutation = null;
		}
	}

	private failRequest(
		result: Extract<SyncRequestResult, { ok: false }>,
		generation: number,
	): WorkerCustomNodeSyncResult {
		const retryable =
			result.error === SYNC_IN_PROGRESS_ERROR || result.retryable === true;
		this.setState({ status: "unavailable", error: result.error, retryable });
		if (retryable) this.schedulePoll(generation);
		return result;
	}

	private setServerState(state: CustomNodeSyncServerState): WorkerCustomNodeSyncState {
		const normalized = parseCustomNodeSyncServerState(state);
		if (normalized === null) {
			this.serverState = null;
			return this.setState({
				status: "unavailable",
				error: "The Worker returned an invalid custom node sync status.",
				retryable: false,
			});
		}
		this.serverState = normalized;
		return this.setState(this.projectServerState(normalized));
	}

	private projectServerState(
		state: CustomNodeSyncServerState,
	): WorkerCustomNodeSyncState {
		const reinstalling = state.operationKind === "reinstall";
		const projectedIdle =
			state.status === "idle" &&
			state.target === null &&
			this.target !== null &&
			state.nodes !== null
				? {
						target: this.target,
						snapshot: customNodeSyncNodeSnapshot(this.target.nodes, state.nodes),
					}
				: null;
		const targetStatus =
			projectedIdle !== null
				? "current"
				: this.target === null || state.target === null
					? "unknown"
					: operationMatchesTarget(state, this.target)
						? "current"
						: "stale";
		const nodeProjection = reinstalling
			? state.target !== null &&
				state.nodeSnapshot !== undefined &&
				this.target !== null
				? projectReinstallSnapshot(
						this.target,
						state.target.nodes[0],
						state.nodeSnapshot,
					)
				: null
			: state.target !== null && state.nodeSnapshot !== undefined
				? projectSnapshot(state.target, state.nodeSnapshot)
				: projectedIdle !== null
					? projectSnapshot(projectedIdle.target, projectedIdle.snapshot)
					: null;
		return {
			...state,
			unsupportedNodes: this.unsupportedNodes,
			targetStatus,
			...(reinstalling && state.target !== null && state.target.nodes[0] !== undefined
				? { reinstallNodeId: state.target.nodes[0].id }
				: {}),
			...(nodeProjection === null ? {} : nodeProjection),
		};
	}

	private reprojectServerState(): void {
		if (this.serverState !== null)
			this.setState(this.projectServerState(this.serverState));
	}

	private setState(state: WorkerCustomNodeSyncState): WorkerCustomNodeSyncState {
		const changed = this.dependencies.state.setCustomNodes(state);
		if (changed) this.dependencies.invalidateVerification();
		return state;
	}

	private noConnection(): WorkerCustomNodeSyncResult {
		const error = "No active Worker connection is available.";
		this.setState({ status: "unavailable", error, retryable: false });
		return { ok: false, error };
	}

	private schedulePoll(generation: number): void {
		this.dependencies.requests.schedule(
			"customNodes",
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

	private waitForState(
		predicate: (state: ReturnType<WorkerSessionStateStore["getState"]>) => boolean,
		generation: number,
	): Promise<ReturnType<WorkerSessionStateStore["getState"]> | null> {
		if (!this.dependencies.requests.isCurrent(generation)) return Promise.resolve(null);
		const current = this.dependencies.state.getState();
		if (predicate(current)) return Promise.resolve(current);
		return new Promise((resolve) => {
			let settled = false;
			let unsubscribe = (): void => undefined;
			const finish = (
				state: ReturnType<WorkerSessionStateStore["getState"]> | null,
			): void => {
				if (settled) return;
				settled = true;
				unsubscribe();
				this.waitCancels.delete(cancel);
				resolve(state);
			};
			const cancel = (): void => finish(null);
			this.waitCancels.add(cancel);
			unsubscribe = this.dependencies.state.subscribe((state) => {
				if (!this.dependencies.requests.isCurrent(generation)) finish(null);
				else if (predicate(state)) finish(state);
			});
		});
	}
}

export function customNodeRunning(state: WorkerCustomNodeSyncState): boolean {
	return state.status === "syncing" || state.status === "canceling";
}

export function customNodeTerminal(state: WorkerCustomNodeSyncState): boolean {
	return (
		state.status === "ready" ||
		state.status === "canceled" ||
		state.status === "failed" ||
		(state.status === "unavailable" && !state.retryable) ||
		state.status === "disconnected"
	);
}

function targetFromPlan(plan: CustomNodeSyncPlan): CustomNodeSyncRequest {
	return { managerVersion: plan.managerVersion, nodes: plan.nodes };
}

function operationMatchesTarget(
	state: CustomNodeSyncServerState,
	target: CustomNodeSyncRequest,
): boolean {
	if (state.target === null) return false;
	if (state.operationKind !== "reinstall") {
		return sameCustomNodeSyncRequest(state.target, target);
	}
	const reinstallTarget = state.target.nodes[0];
	const selectedTarget = target.nodes.find((node) => node.id === reinstallTarget?.id);
	return (
		reinstallTarget !== undefined &&
		selectedTarget !== undefined &&
		sameCustomNodeSyncRequest(state.target, {
			managerVersion: target.managerVersion,
			nodes: [selectedTarget],
		})
	);
}

function projectSnapshot(
	target: CustomNodeSyncRequest,
	snapshot: CustomNodeSyncNodeSnapshot,
): {
	targetNodes: WorkerCustomNodeTargetState[];
	unselectedNodes: CustomNodeInventoryEntry[] | null;
} {
	const targetIds = new Set(target.nodes.map((node) => node.id));
	return {
		targetNodes: target.nodes.map((node, index) => {
			const nodeState = snapshot.targetNodes[index];
			if (nodeState === undefined) {
				throw new Error("The Worker custom node snapshot is incomplete.");
			}
			return {
				id: node.id,
				editorVersion: node.version,
				workerVersion: nodeState.workerVersion,
				status: nodeState.status,
			};
		}),
		unselectedNodes:
			snapshot.activeNodes === null
				? null
				: snapshot.activeNodes.filter(
						(node) => !targetIds.has(customNodeInventoryId(node)),
					),
	};
}

function projectReinstallSnapshot(
	target: CustomNodeSyncRequest,
	reinstallTarget: CustomNodeSyncTarget | undefined,
	snapshot: CustomNodeSyncNodeSnapshot,
): ReturnType<typeof projectSnapshot> | null {
	if (reinstallTarget === undefined || snapshot.activeNodes === null) return null;
	const merged = customNodeSyncNodeSnapshot(target.nodes, snapshot.activeNodes);
	const targetIndex = target.nodes.findIndex(
		(node) =>
			node.id === reinstallTarget.id &&
			node.version === reinstallTarget.version &&
			node.repository === reinstallTarget.repository,
	);
	const reinstallState = snapshot.targetNodes[0];
	if (targetIndex >= 0 && reinstallState?.id === reinstallTarget.id) {
		merged.targetNodes[targetIndex] = reinstallState;
	}
	return projectSnapshot(target, merged);
}

function replacedResult(): WorkerCustomNodeSyncResult {
	return { ok: false, error: "A newer Worker custom node request replaced this one." };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
