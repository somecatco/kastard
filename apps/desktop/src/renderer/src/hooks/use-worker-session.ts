import {
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import {
	applyWorkerSessionStateChange,
	type WorkerSessionSnapshot,
	type WorkerSessionState,
	type WorkerSessionStateChange,
} from "../../../shared/api";

export const DISCONNECTED_WORKER_SESSION: WorkerSessionState = {
	connection: {
		status: "disconnected",
		recentProvider: null,
		recentWorkerAddress: null,
	},
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
	private epoch = 0;
	private started = false;
	private initialized = false;
	private loadVersion = 0;
	private pending: WorkerSessionStateChange[] = [];
	private unsubscribeStateChange: (() => void) | null = null;
	private readonly stateListeners = new Set<StateListener>();
	private readonly changeListeners = new Set<ChangeListener>();

	getState = (): WorkerSessionState => this.state;
	getEpoch = (): number => this.epoch;

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
		this.epoch += 1;
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
		let state = snapshot.state;
		let revision = snapshot.revision;
		for (const change of [...this.pending].sort(
			(left, right) => left.revision - right.revision,
		)) {
			if (change.revision <= revision) continue;
			state = applyWorkerSessionStateChange(state, change);
			revision = change.revision;
		}
		if (connectionChanged(this.state.connection, state.connection)) this.epoch += 1;
		this.state = state;
		this.revision = revision;
		this.initialized = true;
		this.pending = [];
		this.notifyState();
	}

	private apply(change: WorkerSessionStateChange): void {
		if (change.revision <= this.revision) return;
		const next = applyWorkerSessionStateChange(this.state, change);
		if (
			change.type === "session.reset" ||
			connectionChanged(this.state.connection, next.connection)
		)
			this.epoch += 1;
		this.state = next;
		this.revision = change.revision;
		this.notifyState();
		for (const listener of this.changeListeners) listener(change);
	}

	private fail(error: unknown): void {
		this.epoch += 1;
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

function connectionChanged(
	previous: WorkerSessionState["connection"],
	next: WorkerSessionState["connection"],
): boolean {
	if (previous === next) return false;
	if (previous.status !== next.status) return true;
	if (
		"workerAddress" in previous &&
		"workerAddress" in next &&
		previous.workerAddress !== next.workerAddress
	)
		return true;
	return (
		previous.status === "connected" &&
		next.status === "connected" &&
		previous.connectedAt !== next.connectedAt
	);
}

const workerSessionStore = new WorkerSessionClientStore();

export function useWorkerSessionSelector<Value>(
	selector: (state: WorkerSessionState) => Value,
	isEqual: (left: Value, right: Value) => boolean = Object.is,
): Value {
	const committed = useRef<{ value: Value } | null>(null);
	const getSelection = useMemo(() => {
		let snapshot = workerSessionStore.getState();
		const initial = selector(snapshot);
		let selected =
			committed.current !== null && isEqual(committed.current.value, initial)
				? committed.current.value
				: initial;
		return () => {
			const next = workerSessionStore.getState();
			if (next !== snapshot) {
				const value = selector(next);
				if (!isEqual(selected, value)) selected = value;
				snapshot = next;
			}
			return selected;
		};
	}, [selector, isEqual]);
	const selected = useSyncExternalStore(
		workerSessionStore.subscribe,
		getSelection,
		getSelection,
	);
	useEffect(() => {
		committed.current = { value: selected };
	}, [selected]);
	return selected;
}

export function sameFields<Value extends object>(left: Value, right: Value): boolean {
	const keys = Object.keys(left) as Array<keyof Value>;
	return (
		keys.length === Object.keys(right).length &&
		keys.every((key) => Object.is(left[key], right[key]))
	);
}

export const getWorkerSessionEpoch = workerSessionStore.getEpoch;
export const getWorkerSessionState = workerSessionStore.getState;

export function useWorkerSessionSubscription(onState: () => void): void {
	const handleState = useEffectEvent(onState);
	useEffect(() => workerSessionStore.subscribe(handleState), []);
}

export function useWorkerSessionChanges(
	onChange: (change: WorkerSessionStateChange) => void,
): void {
	const handleChange = useEffectEvent(onChange);
	useEffect(() => workerSessionStore.subscribeChanges(handleChange), []);
}
