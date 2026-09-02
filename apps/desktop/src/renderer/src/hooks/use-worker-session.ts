import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import {
	applyWorkerSessionStateChange,
	type WorkerSessionSnapshot,
	type WorkerSessionState,
	type WorkerSessionStateChange,
} from "../../../shared/api";

export const DISCONNECTED_WORKER_SESSION: WorkerSessionState = {
	connection: { status: "disconnected", recentProvider: null, recentServerUrl: null },
	systemMetrics: { status: "disconnected" },
	backend: { status: "disconnected", editorComfyVersion: "" },
	comfy: { status: "disconnected" },
	customNodes: { status: "disconnected" },
	models: { status: "disconnected" },
	verification: null,
	setup: { status: "idle" },
};

type StateListener = () => void;
type ChangeListener = (change: WorkerSessionStateChange) => void;

class WorkerSessionClientStore {
	private state = DISCONNECTED_WORKER_SESSION;
	private revision = -1;
	private started = false;
	private initialized = false;
	private loadVersion = 0;
	private pending: WorkerSessionStateChange[] = [];
	private unsubscribeStateChange: (() => void) | null = null;
	private readonly stateListeners = new Set<StateListener>();
	private readonly changeListeners = new Set<ChangeListener>();

	getState = (): WorkerSessionState => this.state;

	subscribe = (listener: StateListener): (() => void) => {
		this.stateListeners.add(listener);
		this.start();
		return () => {
			this.stateListeners.delete(listener);
			this.stopIfIdle();
		};
	};

	subscribeChanges(listener: ChangeListener): () => void {
		this.changeListeners.add(listener);
		this.start();
		return () => {
			this.changeListeners.delete(listener);
			this.stopIfIdle();
		};
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.unsubscribeStateChange = window.kastard.workerSession.onStateChange((change) =>
			this.receive(change),
		);
		this.loadSnapshot();
	}

	private loadSnapshot(): void {
		const loadVersion = ++this.loadVersion;
		void window.kastard.workerSession.getSnapshot().then(
			(snapshot) => {
				if (this.started && loadVersion === this.loadVersion) this.initialize(snapshot);
			},
			(error: unknown) => {
				if (this.started && loadVersion === this.loadVersion) this.fail(error);
			},
		);
	}

	private stopIfIdle(): void {
		if (this.stateListeners.size > 0 || this.changeListeners.size > 0) return;
		this.unsubscribeStateChange?.();
		this.unsubscribeStateChange = null;
		this.started = false;
		this.loadVersion += 1;
		this.initialized = false;
		this.pending = [];
		this.revision = -1;
		this.state = DISCONNECTED_WORKER_SESSION;
	}

	private receive(change: WorkerSessionStateChange): void {
		if (!this.initialized) {
			this.pending.push(change);
			this.apply(change);
			return;
		}
		if (change.revision > this.revision + 1) {
			this.initialized = false;
			this.pending = [change];
			this.apply(change);
			this.loadSnapshot();
			return;
		}
		this.apply(change);
	}

	private initialize(snapshot: WorkerSessionSnapshot): void {
		this.state = snapshot.state;
		this.revision = snapshot.revision;
		this.initialized = true;
		const pending = [...this.pending].sort(
			(left, right) => left.revision - right.revision,
		);
		this.pending = [];
		for (const change of pending) this.apply(change, false);
		this.notifyState();
	}

	private apply(change: WorkerSessionStateChange, notifyChange = true): void {
		if (change.revision <= this.revision) return;
		this.state = applyWorkerSessionStateChange(this.state, change);
		this.revision = change.revision;
		this.notifyState();
		if (notifyChange) {
			for (const listener of this.changeListeners) listener(change);
		}
	}

	private fail(error: unknown): void {
		this.pending = [];
		this.initialized = true;
		this.state = {
			...DISCONNECTED_WORKER_SESSION,
			connection: {
				status: "error",
				message: error instanceof Error ? error.message : String(error),
			},
		};
		this.notifyState();
	}

	private notifyState(): void {
		for (const listener of this.stateListeners) listener();
	}
}

const workerSessionStore = new WorkerSessionClientStore();

export function useWorkerSession(): WorkerSessionState {
	return useSyncExternalStore(
		workerSessionStore.subscribe,
		workerSessionStore.getState,
		workerSessionStore.getState,
	);
}

export function useWorkerSessionChanges(
	onChange: (change: WorkerSessionStateChange) => void,
): void {
	const handleChange = useEffectEvent(onChange);
	useEffect(() => workerSessionStore.subscribeChanges(handleChange), []);
}
