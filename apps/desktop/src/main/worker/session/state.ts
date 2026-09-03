import type {
	ConnectionState,
	SyncVerification,
	WorkerBackendState,
	WorkerComfyState,
	WorkerCustomNodeSyncState,
	WorkerModelSyncState,
	WorkerSessionSnapshot,
	WorkerSessionState,
	WorkerSessionStateChange,
	WorkerSetupState,
	WorkerSystemMetricsState,
	WorkerWorkflowCurrentState,
} from "../../../shared/api";
import { applyWorkerSessionStateChange } from "../../../shared/api";

type ChangeWithoutRevision<Change> = Change extends WorkerSessionStateChange
	? Omit<Change, "revision">
	: never;

type WorkerSessionStateChangeInput = ChangeWithoutRevision<WorkerSessionStateChange>;
type WorkerSessionStateListener = (
	state: WorkerSessionState,
	change: WorkerSessionStateChange,
) => void;

export class WorkerSessionStateStore {
	private state: WorkerSessionState;
	private revision = 0;
	private readonly listeners = new Set<WorkerSessionStateListener>();

	constructor(initialState: WorkerSessionState) {
		this.state = initialState;
	}

	getState(): WorkerSessionState {
		return this.state;
	}

	getSnapshot(): WorkerSessionSnapshot {
		return { revision: this.revision, state: this.state };
	}

	subscribe(listener: WorkerSessionStateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	reset(state: WorkerSessionState): void {
		if (statesEqual(this.state, state)) return;
		this.commit({ type: "session.reset", state });
	}

	setLifecycle(connection: ConnectionState, setup: WorkerSetupState): void {
		if (
			statesEqual(this.state.connection, connection) &&
			statesEqual(this.state.setup, setup)
		) {
			return;
		}
		this.commit({ type: "lifecycle.changed", connection, setup });
	}

	setConnection(connection: ConnectionState): void {
		if (statesEqual(this.state.connection, connection)) return;
		this.commit({ type: "connection.changed", connection });
	}

	setSystemMetrics(systemMetrics: WorkerSystemMetricsState): void {
		if (statesEqual(this.state.systemMetrics, systemMetrics)) return;
		this.commit({ type: "system-metrics.changed", systemMetrics });
	}

	setBackend(backend: WorkerBackendState): boolean {
		if (statesEqual(this.state.backend, backend)) return false;
		this.commit({ type: "backend.changed", backend });
		return true;
	}

	setComfy(comfy: WorkerComfyState): void {
		if (statesEqual(this.state.comfy, comfy)) return;
		this.commit({ type: "comfy.changed", comfy });
	}

	setCustomNodes(customNodes: WorkerCustomNodeSyncState): boolean {
		if (statesEqual(this.state.customNodes, customNodes)) return false;
		this.commit({ type: "custom-nodes.changed", customNodes });
		return true;
	}

	setModels(models: WorkerModelSyncState): boolean {
		if (statesEqual(this.state.models, models)) return false;
		this.commit({ type: "models.changed", models });
		return true;
	}

	setVerification(verification: SyncVerification | null): void {
		if (statesEqual(this.state.verification, verification)) return;
		this.commit({ type: "verification.changed", verification });
	}

	setSetup(setup: WorkerSetupState): void {
		if (statesEqual(this.state.setup, setup)) return;
		this.commit({ type: "setup.changed", setup });
	}

	setWorkflow(workflow: WorkerWorkflowCurrentState | null): void {
		if (statesEqual(this.state.workflow ?? null, workflow)) return;
		this.commit({ type: "workflow.changed", workflow });
	}

	private commit(input: WorkerSessionStateChangeInput): void {
		const change = { ...input, revision: ++this.revision } as WorkerSessionStateChange;
		this.state = applyWorkerSessionStateChange(this.state, change);
		for (const listener of this.listeners) listener(this.state, change);
	}
}

function statesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
