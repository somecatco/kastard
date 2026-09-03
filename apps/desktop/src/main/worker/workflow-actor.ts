import { randomUUID } from "node:crypto";
import { type AnyActorRef, assign, createActor, enqueueActions, setup } from "xstate";
import {
	cancelWorkerWorkflowJob,
	discardWorkerWorkflowInputs,
	fetchWorkerWorkflowJob,
	startWorkerWorkflowJob,
	type WorkerSessionCredential,
	type WorkflowJobFailure,
	type WorkflowJobState,
} from "./client";
import type {
	openWorkerWorkflowEvents,
	WorkerWorkflowEventConnection,
	WorkerWorkflowLiveMessage,
} from "./workflow-events";
import {
	type WorkflowInputFailure,
	type WorkflowInputSnapshot,
	WorkflowInputSnapshotError,
} from "./workflow-input-snapshot";
import type { WorkflowResultContext } from "./workflow-result-store";

const MAX_PENDING_PROMPT_BYTES = 32 * 1024 * 1024;
const STATUS_FAILURE_LIMIT = 3;
const CONNECTION_LOST_MESSAGE =
	"The Worker connection was lost, so the workflow failed.";
const workflowCaptures = new WeakMap<object, Set<Promise<void>>>();
const workflowCancellations = new WeakMap<object, Set<Promise<void>>>();
const workflowCollections = new WeakMap<object, Set<ActiveRequest>>();
const workflowRequests = new WeakMap<object, Set<ActiveRequest>>();
const workflowFailureRecords = new WeakMap<object, Set<Promise<void>>>();
const workflowRemoteCleanups = new WeakMap<object, Map<string, RemoteCleanup>>();
const workflowEventConnections = new WeakMap<object, WorkerWorkflowEventConnection>();

export type WorkerWorkflowQueueItem = {
	id: string;
	number: number;
	createdAt: number;
	prompt: Record<string, unknown>;
	clientId: string | null;
};

export type WorkerWorkflowQueue = {
	running: WorkerWorkflowQueueItem[];
	pending: WorkerWorkflowQueueItem[];
};

export type WorkerWorkflowCurrent = {
	id: string;
	phase: CurrentWorkflow["phase"];
	cancellation: CurrentWorkflow["cancellation"];
	workerAddress: string;
	lastConfirmedStatus: WorkflowJobState["status"] | null;
	lastConfirmedAt: number | null;
};

export type WorkerWorkflowEvent =
	| { id: string; clientId: string | null; status: "completed" }
	| { id: string; clientId: string | null; status: "canceled" }
	| {
			id: string;
			clientId: string | null;
			status: "failed";
			error: WorkflowJobFailure;
	  };

export type WorkerWorkflowLiveEvent = {
	id: string;
	clientId: string | null;
	message?: WorkerWorkflowLiveMessage;
	preview?: Uint8Array;
};

type StartWorkerWorkflow = (
	credential: WorkerSessionCredential,
	jobId: string,
	snapshot: WorkflowInputSnapshot,
	extraData: Record<string, unknown>,
	signal?: AbortSignal,
) => ReturnType<typeof startWorkerWorkflowJob>;

export type WorkerWorkflowActorOptions = {
	start?: StartWorkerWorkflow;
	read?: typeof fetchWorkerWorkflowJob;
	cancel?: typeof cancelWorkerWorkflowJob;
	openEvents?: typeof openWorkerWorkflowEvents;
	collect?: (
		credential: WorkerSessionCredential,
		context: WorkflowResultContext,
		signal: AbortSignal,
	) => Promise<void>;
	recordFailure?: (
		context: WorkflowResultContext,
		error: WorkflowJobFailure,
	) => Promise<void>;
	recordCanceled?: (context: WorkflowResultContext) => Promise<void>;
	captureInputs?: (
		jobId: string,
		prompt: Record<string, unknown>,
	) => Promise<WorkflowInputSnapshot>;
	cleanupInputs?: (jobId: string) => Promise<void>;
	discardInputs?: typeof discardWorkerWorkflowInputs;
	pollMs?: number;
	maxPendingPromptBytes?: number;
	onQueueChanged?: (queue: WorkerWorkflowQueue) => void;
	onStarted?: (jobId: string, clientId: string | null) => void;
	onLive?: (event: WorkerWorkflowLiveEvent) => void;
	onTerminal?: (event: WorkerWorkflowEvent) => void;
};

type QueuedWorkflow = WorkerWorkflowQueueItem & {
	extraData: Record<string, unknown>;
	promptBytes: number;
	dispatchAfterVersion: number;
	snapshot: WorkflowInputSnapshot | null;
	assignedCredential: WorkerSessionCredential | null;
};

type CurrentWorkflow = WorkerWorkflowQueueItem & {
	extraData: Record<string, unknown>;
	promptBytes: number;
	snapshot: WorkflowInputSnapshot;
	credential: WorkerSessionCredential;
	operation: number;
	stateVersion: number;
	startedNotified: boolean;
	statusFailures: number;
	phase: "dispatching" | "running" | "reconciling" | "collecting";
	cancellation: "none" | "requested" | "unconfirmed";
	lastConfirmedStatus: WorkflowJobState["status"] | null;
	lastConfirmedAt: number | null;
};

type TerminalWorkflow =
	| { status: "completed" }
	| { status: "canceled" }
	| { status: "failed"; error: WorkflowJobFailure };

type WorkflowStartResult = Awaited<ReturnType<typeof startWorkerWorkflowJob>>;
type WorkflowReadResult = Awaited<ReturnType<typeof fetchWorkerWorkflowJob>>;
type ActiveRequest = {
	controller: AbortController;
	done: Promise<void>;
};
type RemoteCleanup = {
	credential: WorkerSessionCredential;
	jobId: string;
	active: Promise<void> | null;
	retryCredential: WorkerSessionCredential | null;
};

type WorkerWorkflowMachineInput = {
	start: StartWorkerWorkflow;
	read: typeof fetchWorkerWorkflowJob;
	cancel: typeof cancelWorkerWorkflowJob;
	openEvents: typeof openWorkerWorkflowEvents;
	collect: NonNullable<WorkerWorkflowActorOptions["collect"]>;
	recordFailure: NonNullable<WorkerWorkflowActorOptions["recordFailure"]>;
	recordCanceled: NonNullable<WorkerWorkflowActorOptions["recordCanceled"]>;
	captureInputs: NonNullable<WorkerWorkflowActorOptions["captureInputs"]>;
	cleanupInputs: NonNullable<WorkerWorkflowActorOptions["cleanupInputs"]>;
	discardInputs: NonNullable<WorkerWorkflowActorOptions["discardInputs"]>;
	pollMs: number;
	maxPendingPromptBytes: number;
	onQueueChanged?: (queue: WorkerWorkflowQueue) => void;
	onStarted?: (jobId: string, clientId: string | null) => void;
	onLive?: (event: WorkerWorkflowLiveEvent) => void;
	onTerminal?: (event: WorkerWorkflowEvent) => void;
};

type WorkerWorkflowMachineContext = WorkerWorkflowMachineInput & {
	pending: QueuedWorkflow[];
	current: CurrentWorkflow | null;
	terminal: TerminalWorkflow | null;
	readyCredential: WorkerSessionCredential | null;
	pendingPromptBytes: number;
	pendingFailureRecords: number;
	nextNumber: number;
	nextOperation: number;
	stateVersion: number;
};

type WorkerWorkflowMachineEvent =
	| {
			type: "workflow.submit";
			item: WorkerWorkflowQueueItem & {
				extraData: Record<string, unknown>;
				promptBytes: number;
				snapshot: null;
				assignedCredential: null;
			};
	  }
	| { type: "snapshot.resolved"; jobId: string; snapshot: WorkflowInputSnapshot }
	| { type: "snapshot.failed"; jobId: string; error: WorkflowInputFailure }
	| {
			type: "pending.failureRecorded";
			item: QueuedWorkflow;
			failure: WorkflowJobFailure;
			recordError?: string;
	  }
	| { type: "workflow.delete"; ids: string[] }
	| { type: "workflow.clear" }
	| { type: "workflow.cancel" }
	| { type: "worker.changed"; credential: WorkerSessionCredential | null }
	| { type: "worker.offline" }
	| {
			type: "dispatch.resolved";
			jobId: string;
			operation: number;
			result: WorkflowStartResult;
	  }
	| {
			type: "status.resolved";
			jobId: string;
			operation: number;
			result: WorkflowReadResult;
	  }
	| {
			type: "cancellation.resolved";
			jobId: string;
			operation: number;
			result: WorkflowReadResult;
	  }
	| { type: "cancellation.recorded"; jobId: string; operation: number }
	| { type: "collect.resolved"; jobId: string; operation: number }
	| { type: "collect.failed"; jobId: string; operation: number; error: string }
	| { type: "failure.recorded"; jobId: string; operation: number; error?: string };

const workerWorkflowMachine = setup({
	types: {
		context: {} as WorkerWorkflowMachineContext,
		events: {} as WorkerWorkflowMachineEvent,
		input: {} as WorkerWorkflowMachineInput,
	},
	delays: {
		poll: ({ context }) => context.pollMs,
	},
	guards: {
		hasPending: ({ context }) => context.pending.length > 0,
		hasTrackableCurrent: ({ context }) =>
			context.current !== null && context.terminal === null,
		hasTerminal: ({ context }) => context.terminal !== null,
		canCancel: ({ context }) =>
			context.current !== null && context.current.cancellation !== "requested",
		canDispatch: ({ context }) => {
			const first = context.pending[0];
			return (
				context.current === null &&
				context.pendingFailureRecords === 0 &&
				first !== undefined &&
				first.snapshot !== null &&
				dispatchCredential(first, context.readyCredential) !== null &&
				first.dispatchAfterVersion <= context.stateVersion
			);
		},
		isCurrentDispatch: ({ context, event }) =>
			event.type === "dispatch.resolved" && currentEventMatches(context, event),
		dispatchAcceptedRunning: ({ context, event }) =>
			event.type === "dispatch.resolved" &&
			currentEventMatches(context, event) &&
			event.result.outcome === "accepted" &&
			event.result.state.id === event.jobId &&
			(event.result.state.status === "running" ||
				event.result.state.status === "canceling") &&
			context.current?.cancellation === "none",
		dispatchAcceptedDuringCancellation: ({ context, event }) =>
			event.type === "dispatch.resolved" &&
			currentEventMatches(context, event) &&
			event.result.outcome === "accepted" &&
			event.result.state.id === event.jobId &&
			(event.result.state.status === "running" ||
				event.result.state.status === "canceling") &&
			context.current?.cancellation !== "none",
		dispatchAcceptedCanceled: ({ context, event }) =>
			event.type === "dispatch.resolved" &&
			currentEventMatches(context, event) &&
			event.result.outcome === "accepted" &&
			event.result.state.id === event.jobId &&
			event.result.state.status === "canceled",
		dispatchAcceptedCompleted: ({ context, event }) =>
			event.type === "dispatch.resolved" &&
			currentEventMatches(context, event) &&
			event.result.outcome === "accepted" &&
			event.result.state.id === event.jobId &&
			event.result.state.status === "completed",
		dispatchAcceptedFailed: ({ context, event }) =>
			event.type === "dispatch.resolved" &&
			currentEventMatches(context, event) &&
			event.result.outcome === "accepted" &&
			event.result.state.id === event.jobId &&
			event.result.state.status === "failed",
		dispatchNeedsReconciliation: ({ context, event }) =>
			event.type === "dispatch.resolved" &&
			currentEventMatches(context, event) &&
			(event.result.outcome === "unknown" ||
				(event.result.outcome === "accepted" && event.result.state.id !== event.jobId)),
		dispatchRetriesAfterStateChange: ({ context, event }) =>
			event.type === "dispatch.resolved" &&
			currentEventMatches(context, event) &&
			event.result.outcome === "rejected" &&
			event.result.retry === "state-change",
		dispatchFailed: ({ context, event }) =>
			event.type === "dispatch.resolved" &&
			currentEventMatches(context, event) &&
			event.result.outcome === "failed",
		statusIsRunning: ({ context, event }) =>
			event.type === "status.resolved" &&
			currentEventMatches(context, event) &&
			event.result.ok &&
			event.result.state.id === event.jobId &&
			(event.result.state.status === "running" ||
				event.result.state.status === "canceling") &&
			context.current?.cancellation === "none",
		statusIsActiveAfterCancellation: ({ context, event }) =>
			event.type === "status.resolved" &&
			currentEventMatches(context, event) &&
			event.result.ok &&
			event.result.state.id === event.jobId &&
			(event.result.state.status === "running" ||
				event.result.state.status === "canceling") &&
			context.current?.cancellation !== "none",
		statusIsCanceled: ({ context, event }) =>
			event.type === "status.resolved" &&
			currentEventMatches(context, event) &&
			event.result.ok &&
			event.result.state.id === event.jobId &&
			event.result.state.status === "canceled",
		statusIsCompleted: ({ context, event }) =>
			event.type === "status.resolved" &&
			currentEventMatches(context, event) &&
			event.result.ok &&
			event.result.state.id === event.jobId &&
			event.result.state.status === "completed",
		statusIsFailed: ({ context, event }) =>
			event.type === "status.resolved" &&
			currentEventMatches(context, event) &&
			event.result.ok &&
			event.result.state.id === event.jobId &&
			event.result.state.status === "failed",
		isCurrentCollection: ({ context, event }) =>
			(event.type === "collect.resolved" || event.type === "collect.failed") &&
			currentEventMatches(context, event),
		isCurrentFailureRecord: ({ context, event }) =>
			event.type === "failure.recorded" && currentEventMatches(context, event),
		isCurrentStatus: ({ context, event }) =>
			event.type === "status.resolved" && currentEventMatches(context, event),
		reconciliationPauses: ({ context, event }) =>
			event.type === "status.resolved" &&
			currentEventMatches(context, event) &&
			(context.current?.statusFailures ?? 0) + 1 >= STATUS_FAILURE_LIMIT,
		isCurrentCancellation: ({ context, event }) =>
			event.type === "cancellation.resolved" && currentEventMatches(context, event),
		cancellationIsCanceled: ({ context, event }) =>
			event.type === "cancellation.resolved" &&
			currentEventMatches(context, event) &&
			event.result.ok &&
			event.result.state.id === event.jobId &&
			event.result.state.status === "canceled",
		cancellationIsCompleted: ({ context, event }) =>
			event.type === "cancellation.resolved" &&
			currentEventMatches(context, event) &&
			event.result.ok &&
			event.result.state.id === event.jobId &&
			event.result.state.status === "completed",
		cancellationIsFailed: ({ context, event }) =>
			event.type === "cancellation.resolved" &&
			currentEventMatches(context, event) &&
			event.result.ok &&
			event.result.state.id === event.jobId &&
			event.result.state.status === "failed",
		cancellationIsActive: ({ context, event }) =>
			event.type === "cancellation.resolved" &&
			currentEventMatches(context, event) &&
			event.result.ok &&
			event.result.state.id === event.jobId &&
			(event.result.state.status === "running" ||
				event.result.state.status === "canceling"),
		cancellationIsUnconfirmed: ({ context, event }) =>
			event.type === "cancellation.resolved" &&
			currentEventMatches(context, event) &&
			!event.result.ok,
		cancellationUnconfirmedWhileCollecting: ({ context, event }) =>
			event.type === "cancellation.resolved" &&
			currentEventMatches(context, event) &&
			(!event.result.ok || event.result.state.id !== event.jobId) &&
			context.current?.phase === "collecting",
		cancellationWhileCollecting: ({ context, event }) =>
			event.type === "cancellation.resolved" &&
			currentEventMatches(context, event) &&
			context.current?.phase === "collecting",
		isCurrentCancellationRecord: ({ context, event }) =>
			event.type === "cancellation.recorded" && currentEventMatches(context, event),
		collectionFailedAfterCancellation: ({ context, event }) =>
			event.type === "collect.failed" &&
			currentEventMatches(context, event) &&
			context.current?.cancellation !== "none",
	},
	actions: {
		enqueueWorkflow: enqueueActions(({ context, event, enqueue }) => {
			if (event.type !== "workflow.submit") return;
			enqueue.assign({
				pending: [...context.pending, { ...event.item, dispatchAfterVersion: 0 }],
				pendingPromptBytes: context.pendingPromptBytes + event.item.promptBytes,
				nextNumber: context.nextNumber + 1,
			});
			enqueue(({ context }) =>
				safeNotify(context.onQueueChanged, projectQueue(context)),
			);
		}),
		resolveSnapshot: enqueueActions(({ context, event, enqueue }) => {
			if (event.type !== "snapshot.resolved") return;
			const index = context.pending.findIndex((item) => item.id === event.jobId);
			if (index < 0) {
				enqueue(() => safeCleanup(context.cleanupInputs, event.jobId));
				return;
			}
			const pending = [...context.pending];
			const item = pending[index];
			if (item === undefined) return;
			pending[index] = {
				...item,
				prompt: event.snapshot.prompt,
				snapshot: event.snapshot,
			};
			enqueue.assign({ pending });
			enqueue(({ context }) =>
				safeNotify(context.onQueueChanged, projectQueue(context)),
			);
		}),
		failSnapshot: enqueueActions(({ context, event, enqueue }) => {
			if (event.type !== "snapshot.failed") return;
			const failed = context.pending.find((item) => item.id === event.jobId);
			if (failed === undefined) return;
			const pending = context.pending.filter((item) => item.id !== event.jobId);
			enqueue.assign({
				pending,
				pendingPromptBytes: pending.reduce(
					(total, item) => total + item.promptBytes,
					0,
				),
				pendingFailureRecords: context.pendingFailureRecords + 1,
			});
			enqueue(({ self }) => recordPendingFailure(self, context, failed, event.error));
			enqueue(() => safeCleanup(context.cleanupInputs, failed.id));
			enqueue(({ context }) =>
				safeNotify(context.onQueueChanged, projectQueue(context)),
			);
		}),
		finishPendingFailure: enqueueActions(({ context, event, enqueue }) => {
			if (event.type !== "pending.failureRecorded") return;
			const error: WorkflowJobFailure =
				event.recordError === undefined
					? event.failure
					: {
							code: "result_failed",
							message: `${event.failure.message} Kastard could not record the workflow failure: ${event.recordError}`,
						};
			enqueue.assign({
				pendingFailureRecords: Math.max(0, context.pendingFailureRecords - 1),
			});
			enqueue(() =>
				safeNotify(context.onTerminal, {
					id: event.item.id,
					clientId: event.item.clientId,
					status: "failed",
					error,
				}),
			);
		}),
		failPendingForConnectionLoss: enqueueActions(({ context, enqueue }) => {
			if (context.pending.length === 0) return;
			const pending = [...context.pending];
			enqueue.assign({
				pending: [],
				pendingPromptBytes: 0,
				pendingFailureRecords: context.pendingFailureRecords + pending.length,
			});
			for (const item of pending) {
				enqueue(({ self }) =>
					recordPendingFailure(self, context, item, connectionLostFailure()),
				);
				enqueue(({ self }) => {
					void cleanupQueuedInputs(self, context, item);
				});
			}
			enqueue(({ context }) =>
				safeNotify(context.onQueueChanged, projectQueue(context)),
			);
		}),
		deletePending: enqueueActions(({ context, event, enqueue }) => {
			if (event.type !== "workflow.delete") return;
			const selected = new Set(event.ids);
			const pending = context.pending.filter((item) => !selected.has(item.id));
			if (pending.length === context.pending.length) return;
			for (const item of context.pending) {
				if (selected.has(item.id)) {
					enqueue(({ self }) => {
						void cleanupQueuedInputs(self, context, item);
					});
				}
			}
			enqueue.assign({
				pending,
				pendingPromptBytes: pending.reduce(
					(total, item) => total + item.promptBytes,
					0,
				),
			});
			enqueue(({ context }) =>
				safeNotify(context.onQueueChanged, projectQueue(context)),
			);
		}),
		clearPending: enqueueActions(({ context, enqueue }) => {
			if (context.pending.length === 0) return;
			for (const item of context.pending) {
				enqueue(({ self }) => {
					void cleanupQueuedInputs(self, context, item);
				});
			}
			enqueue.assign({ pending: [], pendingPromptBytes: 0 });
			enqueue(({ context }) =>
				safeNotify(context.onQueueChanged, projectQueue(context)),
			);
		}),
		updateWorker: assign(({ context, event }) =>
			event.type === "worker.changed"
				? {
						readyCredential: event.credential,
						stateVersion: context.stateVersion + 1,
					}
				: {},
		),
		retryRemoteCleanups: ({ context, event, self }) => {
			if (event.type !== "worker.changed" || event.credential === null) return;
			for (const cleanup of workflowRemoteCleanups.get(self)?.values() ?? []) {
				if (cleanup.credential.workerApiUrl === event.credential.workerApiUrl) {
					void attemptRemoteCleanup(self, context, cleanup, event.credential);
				}
			}
		},
		stopRemoteTracking: ({ self }) => {
			for (const request of workflowRequests.get(self) ?? []) {
				request.controller.abort();
			}
			for (const collection of workflowCollections.get(self) ?? []) {
				collection.controller.abort();
			}
			closeWorkflowEvents(self);
		},
		startCancellation: enqueueActions(({ context, enqueue }) => {
			const current = context.current;
			if (current === null) return;
			enqueue.assign({
				current: { ...current, cancellation: "requested" as const },
			});
			enqueue(({ self }) => {
				const cancellations = workflowCancellations.get(self);
				const cancellation = context
					.cancel(current.credential, current.id)
					.catch(
						(): WorkflowReadResult => ({
							ok: false,
							error: "Could not cancel the Worker workflow.",
							retryable: true,
						}),
					)
					.then((result) => {
						if (self.getSnapshot().status !== "active") return;
						self.send({
							type: "cancellation.resolved",
							jobId: current.id,
							operation: current.operation,
							result,
						});
					})
					.finally(() => cancellations?.delete(cancellation));
				cancellations?.add(cancellation);
			});
		}),
		markCancellationUnconfirmed: assign(({ context }) => ({
			current:
				context.current === null
					? null
					: { ...context.current, cancellation: "unconfirmed" as const },
		})),
		setPhaseRunning: assign(({ context }) => ({
			current:
				context.current === null
					? null
					: { ...context.current, phase: "running" as const },
		})),
		setPhaseReconciling: assign(({ context }) => ({
			current:
				context.current === null
					? null
					: { ...context.current, phase: "reconciling" as const },
		})),
		setPhaseCollecting: assign(({ context }) => ({
			current:
				context.current === null
					? null
					: { ...context.current, phase: "collecting" as const },
		})),
		confirmWorkerState: assign(({ context, event }) => {
			if (context.current === null) return {};
			const state =
				event.type === "dispatch.resolved" && event.result.outcome === "accepted"
					? event.result.state
					: (event.type === "status.resolved" ||
								event.type === "cancellation.resolved") &&
							event.result.ok
						? event.result.state
						: null;
			if (state === null || state.id !== context.current.id) return {};
			return {
				current: {
					...context.current,
					lastConfirmedStatus: state.status,
					lastConfirmedAt: Date.now(),
				},
			};
		}),
		refreshReconciliation: assign(({ context, event }) =>
			event.type === "worker.changed"
				? {
						readyCredential: event.credential,
						stateVersion: context.stateVersion + 1,
						current:
							context.current === null
								? null
								: { ...context.current, statusFailures: 0 },
					}
				: {},
		),
		startNextWorkflow: enqueueActions(({ context, enqueue }) => {
			const item = context.pending[0];
			const credential =
				item === undefined ? null : dispatchCredential(item, context.readyCredential);
			if (
				item === undefined ||
				item.snapshot === null ||
				credential === null ||
				context.current !== null
			) {
				return;
			}
			const operation = context.nextOperation;
			enqueue.assign({
				pending: context.pending.slice(1),
				pendingPromptBytes: context.pendingPromptBytes - item.promptBytes,
				current: {
					...item,
					snapshot: item.snapshot,
					credential,
					operation,
					stateVersion: context.stateVersion,
					startedNotified: false,
					statusFailures: 0,
					phase: "dispatching",
					cancellation: "none",
					lastConfirmedStatus: null,
					lastConfirmedAt: null,
				},
				nextOperation: operation + 1,
			});
			enqueue(({ context }) =>
				safeNotify(context.onQueueChanged, projectQueue(context)),
			);
		}),
		startDispatch: ({ context, self }) => {
			const current = context.current;
			if (current === null) return;
			const controller = new AbortController();
			const request: ActiveRequest = {
				controller,
				done: Promise.resolve(),
			};
			request.done = context
				.openEvents(current.credential, current.id, {
					onMessage: (message) => {
						if (
							!currentEventMatches(self.getSnapshot().context, {
								jobId: current.id,
								operation: current.operation,
							})
						) {
							return;
						}
						safeNotify(context.onLive, {
							id: current.id,
							clientId: current.clientId,
							message,
						});
					},
					onPreview: (preview) => {
						if (
							!currentEventMatches(self.getSnapshot().context, {
								jobId: current.id,
								operation: current.operation,
							})
						) {
							return;
						}
						safeNotify(context.onLive, {
							id: current.id,
							clientId: current.clientId,
							preview,
						});
					},
				})
				.then((connection) => {
					const snapshot = self.getSnapshot();
					if (
						snapshot.status !== "active" ||
						!currentEventMatches(snapshot.context, {
							jobId: current.id,
							operation: current.operation,
						}) ||
						snapshot.context.current?.cancellation !== "none"
					) {
						connection.close();
						throw new Error("Worker workflow execution stopped.");
					}
					workflowEventConnections.get(self)?.close();
					workflowEventConnections.set(self, connection);
					return context
						.start(
							current.credential,
							current.id,
							current.snapshot,
							current.extraData,
							controller.signal,
						)
						.catch(
							(): WorkflowStartResult => ({
								outcome: "unknown",
								error: "Worker workflow submission failed.",
							}),
						);
				})
				.catch(
					(error: unknown): WorkflowStartResult => ({
						outcome: "rejected",
						error:
							error instanceof Error &&
							error.message === "Worker workflow execution stopped."
								? error.message
								: "Could not open the Worker workflow event stream.",
						retry: "never",
					}),
				)
				.then((result) => {
					if (self.getSnapshot().status !== "active") return;
					self.send({
						type: "dispatch.resolved",
						jobId: current.id,
						operation: current.operation,
						result,
					});
				})
				.finally(() => workflowRequests.get(self)?.delete(request));
			workflowRequests.get(self)?.add(request);
		},
		readStatus: ({ context, self }) => {
			const current = context.current;
			if (current === null) return;
			const requests = workflowRequests.get(self);
			const controller = new AbortController();
			const request: ActiveRequest = {
				controller,
				done: Promise.resolve(),
			};
			request.done = context
				.read(current.credential, current.id, undefined, controller.signal)
				.catch(
					(): WorkflowReadResult => ({
						ok: false,
						error: "Worker workflow status could not be loaded.",
						retryable: true,
					}),
				)
				.then((result) => {
					if (self.getSnapshot().status !== "active") return;
					self.send({
						type: "status.resolved",
						jobId: current.id,
						operation: current.operation,
						result,
					});
				})
				.finally(() => requests?.delete(request));
			requests?.add(request);
		},
		requeueCurrent: enqueueActions(({ context, enqueue }) => {
			const current = context.current;
			if (current === null) return;
			enqueue(({ self }) => closeWorkflowEvents(self));
			const dispatchAfterVersion =
				current.stateVersion === context.stateVersion
					? context.stateVersion + 1
					: context.stateVersion;
			enqueue.assign({
				current: null,
				pending: [
					{
						id: current.id,
						number: current.number,
						createdAt: current.createdAt,
						prompt: current.prompt,
						extraData: current.extraData,
						clientId: current.clientId,
						promptBytes: current.promptBytes,
						dispatchAfterVersion,
						snapshot: current.snapshot,
						assignedCredential: current.credential,
					},
					...context.pending,
				],
				pendingPromptBytes: context.pendingPromptBytes + current.promptBytes,
			});
			enqueue(({ context }) =>
				safeNotify(context.onQueueChanged, projectQueue(context)),
			);
		}),
		resetStatusFailures: assign(({ context }) => ({
			current:
				context.current === null ? null : { ...context.current, statusFailures: 0 },
		})),
		startReconciliationAfterRunningFailure: assign(({ context }) => ({
			current:
				context.current === null ? null : { ...context.current, statusFailures: 1 },
		})),
		incrementStatusFailures: assign(({ context }) => ({
			current:
				context.current === null
					? null
					: {
							...context.current,
							statusFailures: context.current.statusFailures + 1,
						},
		})),
		notifyStarted: enqueueActions(({ context, enqueue }) => {
			const current = context.current;
			if (current === null || current.startedNotified) return;
			enqueue(() => safeNotify(context.onStarted, current.id, current.clientId));
			enqueue.assign({ current: { ...current, startedNotified: true } });
		}),
		setTerminalFromDispatch: assign(({ event }) => {
			if (
				event.type !== "dispatch.resolved" ||
				event.result.outcome !== "accepted" ||
				event.result.state.status === "running" ||
				event.result.state.status === "canceling"
			) {
				return {};
			}
			return { terminal: terminalFromState(event.result.state) };
		}),
		setTerminalFromStatus: assign(({ event }) => {
			if (
				event.type !== "status.resolved" ||
				!event.result.ok ||
				event.result.state.status === "running" ||
				event.result.state.status === "canceling"
			) {
				return {};
			}
			return { terminal: terminalFromState(event.result.state) };
		}),
		setTerminalFromCancellation: assign(({ event }) => {
			if (
				event.type !== "cancellation.resolved" ||
				!event.result.ok ||
				event.result.state.status !== "failed"
			) {
				return {};
			}
			return { terminal: terminalFromState(event.result.state) };
		}),
		startCollect: ({ context, self }) => {
			const current = context.current;
			if (current === null) return;
			const collections = workflowCollections.get(self);
			const controller = new AbortController();
			const collection: ActiveRequest = {
				controller,
				done: Promise.resolve(),
			};
			collection.done = context
				.collect(current.credential, resultContext(current), controller.signal)
				.then(
					() => {
						if (self.getSnapshot().status !== "active") return;
						self.send({
							type: "collect.resolved",
							jobId: current.id,
							operation: current.operation,
						});
					},
					async (error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						const snapshot = self.getSnapshot();
						if (snapshot.status === "active") {
							self.send({
								type: "collect.failed",
								jobId: current.id,
								operation: current.operation,
								error: message,
							});
							return;
						}
						if (
							snapshot.context.current?.id === current.id &&
							snapshot.context.terminal?.status === "failed"
						) {
							return;
						}
						await context
							.recordFailure(resultContext(current), collectionFailure(message))
							.catch(() => undefined);
					},
				)
				.finally(() => collections?.delete(collection));
			collections?.add(collection);
		},
		setCompleted: assign(() => ({ terminal: { status: "completed" as const } })),
		setCanceled: assign(() => ({ terminal: { status: "canceled" as const } })),
		setCollectFailure: assign(({ event }) =>
			event.type === "collect.failed"
				? {
						terminal: {
							status: "failed" as const,
							error: collectionFailure(event.error),
						},
					}
				: {},
		),
		setConnectionLost: assign(() => ({
			terminal: {
				status: "failed" as const,
				error: connectionLostFailure(),
			},
		})),
		startCanceledRecord: ({ context, self }) => {
			const current = context.current;
			if (current === null) return;
			const records = workflowFailureRecords.get(self);
			const record = context
				.recordCanceled(resultContext(current))
				.then(
					() => {
						if (self.getSnapshot().status !== "active") return;
						self.send({
							type: "cancellation.recorded",
							jobId: current.id,
							operation: current.operation,
						});
					},
					() => undefined,
				)
				.finally(() => records?.delete(record));
			records?.add(record);
		},
		startFailureRecord: ({ context, self }) => {
			const current = context.current;
			const terminal = context.terminal;
			if (current === null || terminal?.status !== "failed") return;
			const records = workflowFailureRecords.get(self);
			const collections = [...(workflowCollections.get(self) ?? [])];
			const failureRecord = (): Promise<void> =>
				context.recordFailure(resultContext(current), terminal.error);
			const record = (
				collections.length === 0
					? failureRecord()
					: Promise.all(collections.map((collection) => collection.done)).then(
							failureRecord,
						)
			)
				.then(
					() => {
						if (self.getSnapshot().status !== "active") return;
						self.send({
							type: "failure.recorded",
							jobId: current.id,
							operation: current.operation,
						});
					},
					(error: unknown) => {
						if (self.getSnapshot().status !== "active") return;
						self.send({
							type: "failure.recorded",
							jobId: current.id,
							operation: current.operation,
							error: error instanceof Error ? error.message : String(error),
						});
					},
				)
				.finally(() => records?.delete(record));
			records?.add(record);
		},
		setFailureRecordError: assign(({ context, event }) => {
			if (
				event.type !== "failure.recorded" ||
				event.error === undefined ||
				context.terminal?.status !== "failed"
			) {
				return {};
			}
			return {
				terminal: {
					status: "failed" as const,
					error: {
						code: "result_failed" as const,
						message: `${context.terminal.error.message} Kastard could not record the workflow failure: ${event.error}`,
					},
				},
			};
		}),
		setTerminalFromRejection: assign(({ event }) =>
			event.type === "dispatch.resolved" && event.result.outcome === "rejected"
				? {
						terminal: {
							status: "failed" as const,
							error: {
								code: "execution_failed" as const,
								message: event.result.error,
							},
						},
					}
				: {},
		),
		setTerminalFromInputFailure: assign(({ event }) =>
			event.type === "dispatch.resolved" && event.result.outcome === "failed"
				? { terminal: { status: "failed" as const, error: event.result.error } }
				: {},
		),
		finishTerminal: enqueueActions(({ context, enqueue }) => {
			const current = context.current;
			const terminal = context.terminal;
			if (current === null || terminal === null) return;
			enqueue(({ self }) => closeWorkflowEvents(self));
			enqueue(() =>
				safeNotify(context.onTerminal, {
					id: current.id,
					clientId: current.clientId,
					...terminal,
				}),
			);
			enqueue(({ self }) => {
				void cleanupWorkflowInputs(
					self,
					context,
					current.id,
					current.snapshot.inputs.length === 0 ? null : current.credential,
				);
			});
			enqueue.assign({ current: null, terminal: null });
			enqueue(({ context }) =>
				safeNotify(context.onQueueChanged, projectQueue(context)),
			);
		}),
	},
}).createMachine({
	id: "workerWorkflow",
	context: ({ input }) => ({
		...input,
		pending: [],
		current: null,
		terminal: null,
		readyCredential: null,
		pendingPromptBytes: 0,
		pendingFailureRecords: 0,
		nextNumber: 0,
		nextOperation: 0,
		stateVersion: 0,
	}),
	initial: "idle",
	on: {
		"workflow.submit": { actions: "enqueueWorkflow" },
		"snapshot.resolved": { actions: "resolveSnapshot" },
		"snapshot.failed": { actions: "failSnapshot" },
		"pending.failureRecorded": { actions: "finishPendingFailure" },
		"workflow.delete": { actions: "deletePending" },
		"workflow.clear": { actions: "clearPending" },
		"workflow.cancel": { guard: "canCancel", actions: "startCancellation" },
		"worker.offline": [
			{
				guard: "hasTrackableCurrent",
				target: ".recordingFailure",
				actions: [
					"stopRemoteTracking",
					"failPendingForConnectionLoss",
					"setConnectionLost",
				],
			},
			{ actions: "failPendingForConnectionLoss" },
		],
		"cancellation.resolved": [
			{ guard: "hasTerminal" },
			{
				guard: "cancellationUnconfirmedWhileCollecting",
				actions: "markCancellationUnconfirmed",
			},
			{
				guard: "cancellationWhileCollecting",
				actions: "confirmWorkerState",
			},
			{
				guard: "cancellationIsCanceled",
				target: ".recordingCanceled",
				actions: ["confirmWorkerState", "setCanceled"],
			},
			{
				guard: "cancellationIsCompleted",
				target: ".collecting",
				actions: "confirmWorkerState",
			},
			{
				guard: "cancellationIsFailed",
				target: ".recordingFailure",
				actions: ["confirmWorkerState", "setTerminalFromCancellation"],
			},
			{
				guard: "cancellationIsActive",
				target: ".reconciling",
				actions: "confirmWorkerState",
			},
			{
				guard: "cancellationIsUnconfirmed",
				target: ".reconciling",
				actions: "markCancellationUnconfirmed",
			},
			{
				guard: "isCurrentCancellation",
				target: ".reconciling",
				actions: "markCancellationUnconfirmed",
			},
		],
		"worker.changed": { actions: ["updateWorker", "retryRemoteCleanups"] },
	},
	states: {
		idle: {
			always: { guard: "hasPending", target: "queued" },
		},
		queued: {
			always: [
				{
					guard: "canDispatch",
					target: "dispatching",
					actions: "startNextWorkflow",
				},
				{ guard: ({ context }) => context.pending.length === 0, target: "idle" },
			],
		},
		dispatching: {
			entry: "startDispatch",
			on: {
				"dispatch.resolved": [
					{
						guard: "dispatchAcceptedCanceled",
						target: "recordingCanceled",
						actions: ["confirmWorkerState", "setCanceled"],
					},
					{
						guard: "dispatchAcceptedDuringCancellation",
						target: "reconciling",
						actions: ["confirmWorkerState", "startCancellation"],
					},
					{
						guard: "dispatchAcceptedRunning",
						target: "running",
						actions: ["confirmWorkerState", "notifyStarted"],
					},
					{
						guard: "dispatchAcceptedCompleted",
						target: "collecting",
						actions: ["confirmWorkerState", "notifyStarted"],
					},
					{
						guard: "dispatchAcceptedFailed",
						target: "recordingFailure",
						actions: ["confirmWorkerState", "notifyStarted", "setTerminalFromDispatch"],
					},
					{
						guard: "dispatchNeedsReconciliation",
						target: "reconciling",
						actions: "resetStatusFailures",
					},
					{
						guard: "dispatchRetriesAfterStateChange",
						target: "queued",
						actions: "requeueCurrent",
					},
					{
						guard: "dispatchFailed",
						target: "recordingFailure",
						actions: "setTerminalFromInputFailure",
					},
					{
						guard: "isCurrentDispatch",
						target: "recordingFailure",
						actions: "setTerminalFromRejection",
					},
				],
			},
		},
		running: {
			entry: "setPhaseRunning",
			initial: "waiting",
			states: {
				waiting: {
					after: { poll: "checking" },
				},
				checking: {
					entry: "readStatus",
					on: {
						"status.resolved": [
							{
								guard: "statusIsCanceled",
								target: "#workerWorkflow.recordingCanceled",
								actions: ["confirmWorkerState", "setCanceled"],
							},
							{
								guard: "statusIsActiveAfterCancellation",
								target: "#workerWorkflow.reconciling",
								actions: ["confirmWorkerState", "startCancellation"],
							},
							{
								guard: "statusIsRunning",
								target: "waiting",
								actions: ["confirmWorkerState", "notifyStarted"],
							},
							{
								guard: "statusIsCompleted",
								target: "#workerWorkflow.collecting",
								actions: ["confirmWorkerState", "notifyStarted"],
							},
							{
								guard: "statusIsFailed",
								target: "#workerWorkflow.recordingFailure",
								actions: [
									"confirmWorkerState",
									"notifyStarted",
									"setTerminalFromStatus",
								],
							},
							{
								guard: "isCurrentStatus",
								target: "#workerWorkflow.reconciling",
								actions: "startReconciliationAfterRunningFailure",
							},
						],
					},
				},
			},
		},
		reconciling: {
			entry: "setPhaseReconciling",
			initial: "checking",
			states: {
				checking: {
					entry: "readStatus",
					on: {
						"worker.changed": {
							actions: ["refreshReconciliation", "retryRemoteCleanups"],
						},
						"status.resolved": [
							{
								guard: "statusIsCanceled",
								target: "#workerWorkflow.recordingCanceled",
								actions: ["confirmWorkerState", "setCanceled"],
							},
							{
								guard: "statusIsActiveAfterCancellation",
								target: "waiting",
								actions: ["confirmWorkerState", "startCancellation"],
							},
							{
								guard: "statusIsRunning",
								target: "#workerWorkflow.running",
								actions: ["confirmWorkerState", "notifyStarted"],
							},
							{
								guard: "statusIsCompleted",
								target: "#workerWorkflow.collecting",
								actions: ["confirmWorkerState", "notifyStarted"],
							},
							{
								guard: "statusIsFailed",
								target: "#workerWorkflow.recordingFailure",
								actions: [
									"confirmWorkerState",
									"notifyStarted",
									"setTerminalFromStatus",
								],
							},
							{
								guard: "reconciliationPauses",
								target: "paused",
								actions: "incrementStatusFailures",
							},
							{
								guard: "isCurrentStatus",
								target: "waiting",
								actions: "incrementStatusFailures",
							},
						],
					},
				},
				waiting: {
					after: { poll: "checking" },
					on: {
						"worker.changed": {
							target: "checking",
							actions: ["refreshReconciliation", "retryRemoteCleanups"],
						},
					},
				},
				paused: {
					on: {
						"worker.changed": {
							target: "checking",
							actions: ["refreshReconciliation", "retryRemoteCleanups"],
						},
					},
				},
			},
		},
		collecting: {
			entry: ["setPhaseCollecting", "startCollect"],
			on: {
				"collect.resolved": {
					guard: "isCurrentCollection",
					target: "terminal",
					actions: "setCompleted",
				},
				"collect.failed": [
					{
						guard: "collectionFailedAfterCancellation",
						target: "reconciling",
						actions: "markCancellationUnconfirmed",
					},
					{
						guard: "isCurrentCollection",
						target: "recordingFailure",
						actions: "setCollectFailure",
					},
				],
			},
		},
		recordingCanceled: {
			entry: "startCanceledRecord",
			on: {
				"cancellation.recorded": {
					guard: "isCurrentCancellationRecord",
					target: "terminal",
				},
			},
		},
		recordingFailure: {
			entry: "startFailureRecord",
			on: {
				"failure.recorded": {
					guard: "isCurrentFailureRecord",
					target: "terminal",
					actions: "setFailureRecordError",
				},
			},
		},
		terminal: {
			entry: "finishTerminal",
			always: [{ guard: "hasPending", target: "queued" }, { target: "idle" }],
		},
	},
});

export function createWorkerWorkflowActor(options: WorkerWorkflowActorOptions = {}) {
	const actor = createActor(workerWorkflowMachine, {
		input: {
			start:
				options.start ??
				((credential, jobId, snapshot, extraData, signal) =>
					startWorkerWorkflowJob(
						credential,
						jobId,
						snapshot,
						extraData,
						fetch,
						signal,
					)),
			read: options.read ?? fetchWorkerWorkflowJob,
			cancel: options.cancel ?? cancelWorkerWorkflowJob,
			openEvents:
				options.openEvents ??
				(async () => ({
					close: () => undefined,
				})),
			collect: options.collect ?? (async () => undefined),
			recordFailure: options.recordFailure ?? (async () => undefined),
			recordCanceled: options.recordCanceled ?? (async () => undefined),
			captureInputs: options.captureInputs ?? captureInputlessWorkflow,
			cleanupInputs: options.cleanupInputs ?? cleanupInputlessWorkflow,
			discardInputs: options.discardInputs ?? discardWorkerWorkflowInputs,
			pollMs: options.pollMs ?? 250,
			maxPendingPromptBytes: options.maxPendingPromptBytes ?? MAX_PENDING_PROMPT_BYTES,
			...(options.onQueueChanged === undefined
				? {}
				: { onQueueChanged: options.onQueueChanged }),
			...(options.onStarted === undefined ? {} : { onStarted: options.onStarted }),
			...(options.onLive === undefined ? {} : { onLive: options.onLive }),
			...(options.onTerminal === undefined ? {} : { onTerminal: options.onTerminal }),
		},
	});
	workflowCaptures.set(actor, new Set());
	workflowCancellations.set(actor, new Set());
	workflowCollections.set(actor, new Set());
	workflowRequests.set(actor, new Set());
	workflowFailureRecords.set(actor, new Set());
	workflowRemoteCleanups.set(actor, new Map());
	return actor;
}

export type WorkerWorkflowActor = ReturnType<typeof createWorkerWorkflowActor>;

export async function stopWorkerWorkflowActor(
	actor: WorkerWorkflowActor,
): Promise<void> {
	const snapshot = actor.getSnapshot();
	const pending = snapshot.status === "active" ? [...snapshot.context.pending] : [];
	const current = snapshot.status === "active" ? snapshot.context.current : null;
	const captures = [...(workflowCaptures.get(actor) ?? [])];
	const cancellations = [...(workflowCancellations.get(actor) ?? [])];
	const collections = [...(workflowCollections.get(actor) ?? [])];
	const requests = [...(workflowRequests.get(actor) ?? [])];
	const failureRecords = [...(workflowFailureRecords.get(actor) ?? [])];
	for (const request of requests) request.controller.abort();
	closeWorkflowEvents(actor);
	actor.stop();
	await Promise.all([
		...captures,
		...cancellations,
		...collections.map((collection) => collection.done),
		...requests.map((request) => request.done),
		...failureRecords,
	]);
	await Promise.all([
		...pending
			.filter((item) => item.snapshot !== null)
			.map((item) => cleanupQueuedInputs(actor, snapshot.context, item)),
		...(current === null
			? []
			: [
					cleanupWorkflowInputs(
						actor,
						snapshot.context,
						current.id,
						current.credential,
					),
				]),
	]);
	await settleRemoteCleanups(actor);
	await Promise.all(
		[...(workflowRemoteCleanups.get(actor)?.values() ?? [])].map((cleanup) =>
			attemptRemoteCleanup(actor, snapshot.context, cleanup, cleanup.credential),
		),
	);
	workflowCaptures.delete(actor);
	workflowCancellations.delete(actor);
	workflowCollections.delete(actor);
	workflowRequests.delete(actor);
	workflowFailureRecords.delete(actor);
	workflowRemoteCleanups.delete(actor);
	workflowEventConnections.delete(actor);
}

export async function submitWorkerWorkflow(
	actor: WorkerWorkflowActor,
	prompt: Record<string, unknown>,
	clientId: string | null,
	extraData: Record<string, unknown> = {},
): Promise<{ id: string; number: number }> {
	const snapshot = activeSnapshot(actor);
	if (snapshot.context.readyCredential === null) {
		throw new WorkerWorkflowSubmissionError("Worker is not ready.", 503);
	}
	const promptBytes =
		Buffer.byteLength(JSON.stringify(prompt)) +
		(Object.keys(extraData).length === 0
			? 0
			: Buffer.byteLength(JSON.stringify(extraData)));
	if (
		snapshot.context.pendingPromptBytes + promptBytes >
		snapshot.context.maxPendingPromptBytes
	) {
		throw new WorkerWorkflowSubmissionError("Worker workflow queue is full.", 409);
	}
	const item = {
		id: randomUUID(),
		number: snapshot.context.nextNumber,
		createdAt: Date.now(),
		prompt,
		extraData,
		clientId,
		promptBytes,
		snapshot: null as null,
		assignedCredential: null,
	};
	actor.send({ type: "workflow.submit", item });
	const capture = snapshot.context
		.captureInputs(item.id, prompt)
		.then((captured) => {
			if (actor.getSnapshot().status !== "active") {
				return snapshot.context.cleanupInputs(item.id).catch(() => undefined);
			}
			actor.send({ type: "snapshot.resolved", jobId: item.id, snapshot: captured });
		})
		.catch((error: unknown) => {
			if (actor.getSnapshot().status !== "active") return;
			actor.send({
				type: "snapshot.failed",
				jobId: item.id,
				error: inputFailure(error),
			});
		})
		.finally(() => workflowCaptures.get(actor)?.delete(capture));
	workflowCaptures.get(actor)?.add(capture);
	return { id: item.id, number: item.number };
}

export function getWorkerWorkflowQueue(
	actor: WorkerWorkflowActor,
): WorkerWorkflowQueue {
	return projectQueue(actor.getSnapshot().context);
}

export function getCurrentWorkerWorkflow(
	actor: WorkerWorkflowActor,
): WorkerWorkflowCurrent | null {
	const current = actor.getSnapshot().context.current;
	return current === null
		? null
		: {
				id: current.id,
				phase: current.phase,
				cancellation: current.cancellation,
				workerAddress:
					current.credential.workerAddress ?? current.credential.workerApiUrl,
				lastConfirmedStatus: current.lastConfirmedStatus,
				lastConfirmedAt: current.lastConfirmedAt,
			};
}

export function deletePendingWorkerWorkflows(
	actor: WorkerWorkflowActor,
	ids: string[],
): void {
	const snapshot = activeSnapshot(actor);
	const selected = new Set(ids);
	if (snapshot.context.current !== null && selected.has(snapshot.context.current.id)) {
		throw new WorkerWorkflowSubmissionError(
			"The current Worker workflow cannot be deleted.",
			409,
		);
	}
	actor.send({ type: "workflow.delete", ids });
}

export function clearPendingWorkerWorkflows(actor: WorkerWorkflowActor): void {
	activeSnapshot(actor);
	actor.send({ type: "workflow.clear" });
}

export function cancelCurrentWorkerWorkflow(actor: WorkerWorkflowActor): string | null {
	const snapshot = activeSnapshot(actor);
	const jobId = snapshot.context.current?.id ?? null;
	if (jobId !== null) actor.send({ type: "workflow.cancel" });
	return jobId;
}

export function updateWorkerWorkflowReadiness(
	actor: WorkerWorkflowActor,
	credential: WorkerSessionCredential | null,
): void {
	if (actor.getSnapshot().status !== "active") return;
	actor.send({ type: "worker.changed", credential });
}

export function failWorkerWorkflowsForConnectionLoss(actor: WorkerWorkflowActor): void {
	if (actor.getSnapshot().status !== "active") return;
	actor.send({ type: "worker.offline" });
}

export class WorkerWorkflowSubmissionError extends Error {
	constructor(
		message: string,
		readonly statusCode: 400 | 409 | 503,
	) {
		super(message);
	}
}

function activeSnapshot(actor: WorkerWorkflowActor) {
	const snapshot = actor.getSnapshot();
	if (snapshot.status !== "active") {
		throw new WorkerWorkflowSubmissionError(
			"Worker workflow execution is unavailable.",
			409,
		);
	}
	return snapshot;
}

function currentEventMatches(
	context: WorkerWorkflowMachineContext,
	event: { jobId: string; operation: number },
): boolean {
	return (
		context.current?.id === event.jobId && context.current.operation === event.operation
	);
}

function dispatchCredential(
	item: QueuedWorkflow,
	ready: WorkerSessionCredential | null,
): WorkerSessionCredential | null {
	if (ready === null) return null;
	return item.assignedCredential === null ||
		item.assignedCredential.workerApiUrl === ready.workerApiUrl
		? ready
		: null;
}

function connectionLostFailure(): WorkflowJobFailure {
	return {
		code: "connection_lost",
		message: CONNECTION_LOST_MESSAGE,
	};
}

function recordPendingFailure(
	actor: AnyActorRef,
	context: WorkerWorkflowMachineInput,
	item: QueuedWorkflow,
	failure: WorkflowJobFailure,
): void {
	const records = workflowFailureRecords.get(actor);
	const finish = (recordError?: string) => {
		if (actor.getSnapshot().status !== "active") return;
		actor.send(
			recordError === undefined
				? { type: "pending.failureRecorded", item, failure }
				: { type: "pending.failureRecorded", item, failure, recordError },
		);
	};
	const record = context
		.recordFailure(resultContext(item), failure)
		.then(
			() => finish(),
			(error: unknown) =>
				finish(error instanceof Error ? error.message : String(error)),
		)
		.finally(() => records?.delete(record));
	records?.add(record);
}

function terminalFromState(
	state: Exclude<WorkflowJobState, { status: "running" | "canceling" }>,
): TerminalWorkflow {
	if (state.status === "completed") return { status: "completed" };
	if (state.status === "canceled") return { status: "canceled" };
	return { status: "failed", error: state.error };
}

function projectQueue(context: WorkerWorkflowMachineContext): WorkerWorkflowQueue {
	return {
		running: context.current === null ? [] : [projectItem(context.current)],
		pending: context.pending.map(projectItem),
	};
}

function projectItem(item: WorkerWorkflowQueueItem): WorkerWorkflowQueueItem {
	return {
		id: item.id,
		number: item.number,
		createdAt: item.createdAt,
		prompt: item.prompt,
		clientId: item.clientId,
	};
}

function resultContext(
	current: WorkerWorkflowQueueItem & { extraData: Record<string, unknown> },
): WorkflowResultContext {
	return {
		id: current.id,
		number: current.number,
		createdAt: current.createdAt,
		prompt: current.prompt,
		extraData: current.extraData,
		clientId: current.clientId,
	};
}

function closeWorkflowEvents(owner: object): void {
	workflowEventConnections.get(owner)?.close();
	workflowEventConnections.delete(owner);
}

function safeNotify<Arguments extends unknown[]>(
	listener: ((...args: Arguments) => void) | undefined,
	...args: Arguments
): void {
	try {
		listener?.(...args);
	} catch {
		return;
	}
}

async function captureInputlessWorkflow(
	_jobId: string,
	prompt: Record<string, unknown>,
): Promise<WorkflowInputSnapshot> {
	return {
		prompt: JSON.parse(JSON.stringify(prompt)) as Record<string, unknown>,
		inputs: [],
	};
}

async function cleanupInputlessWorkflow(_jobId: string): Promise<void> {}

function safeCleanup(cleanup: (jobId: string) => Promise<void>, jobId: string): void {
	void cleanup(jobId).catch(() => undefined);
}

async function cleanupQueuedInputs(
	owner: object,
	context: WorkerWorkflowMachineInput,
	item: QueuedWorkflow,
): Promise<void> {
	await cleanupWorkflowInputs(owner, context, item.id, item.assignedCredential);
}

async function cleanupWorkflowInputs(
	owner: object,
	context: WorkerWorkflowMachineInput,
	jobId: string,
	credential: WorkerSessionCredential | null,
): Promise<void> {
	await Promise.allSettled([
		context.cleanupInputs(jobId),
		...(credential === null
			? []
			: [queueRemoteCleanup(owner, context, credential, jobId)]),
	]);
}

function queueRemoteCleanup(
	owner: object,
	context: WorkerWorkflowMachineInput,
	credential: WorkerSessionCredential,
	jobId: string,
): Promise<void> {
	const cleanups = workflowRemoteCleanups.get(owner);
	if (cleanups === undefined) {
		return context.discardInputs(credential, jobId).catch(() => undefined);
	}
	const key = `${credential.workerApiUrl}\n${jobId}`;
	const cleanup = cleanups.get(key) ?? {
		credential,
		jobId,
		active: null,
		retryCredential: null,
	};
	cleanups.set(key, cleanup);
	return attemptRemoteCleanup(owner, context, cleanup, credential);
}

function attemptRemoteCleanup(
	owner: object,
	context: WorkerWorkflowMachineInput,
	cleanup: RemoteCleanup,
	credential: WorkerSessionCredential,
): Promise<void> {
	if (cleanup.active !== null) {
		cleanup.retryCredential = credential;
		return cleanup.active;
	}
	cleanup.credential = credential;
	cleanup.retryCredential = null;
	const key = `${credential.workerApiUrl}\n${cleanup.jobId}`;
	const attempt = context
		.discardInputs(credential, cleanup.jobId)
		.then(() => {
			workflowRemoteCleanups.get(owner)?.delete(key);
		})
		.catch(() => undefined)
		.finally(() => {
			cleanup.active = null;
			const retryCredential = cleanup.retryCredential;
			cleanup.retryCredential = null;
			if (
				retryCredential !== null &&
				workflowRemoteCleanups.get(owner)?.get(key) === cleanup
			) {
				void attemptRemoteCleanup(owner, context, cleanup, retryCredential);
			}
		});
	cleanup.active = attempt;
	return attempt;
}

async function settleRemoteCleanups(owner: object): Promise<void> {
	await Promise.all(
		[...(workflowRemoteCleanups.get(owner)?.values() ?? [])].flatMap((cleanup) =>
			cleanup.active === null ? [] : [cleanup.active],
		),
	);
}

function inputFailure(error: unknown): WorkflowInputFailure {
	if (error instanceof WorkflowInputSnapshotError) return error.failure;
	return {
		code: "input_failed",
		message: "Could not create the workflow input snapshot.",
		problems: [{ reason: "snapshot-failed", name: "Workflow inputs" }],
	};
}

function collectionFailure(message: string): WorkflowJobFailure {
	return {
		code: "result_failed",
		message: `Kastard result collection failed: ${message}`,
	};
}
