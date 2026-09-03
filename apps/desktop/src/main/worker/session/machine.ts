import { assign, createActor, fromPromise, setup } from "xstate";
import type {
	ConnectionRequest,
	ConnectionResult,
	ConnectionState,
	ReleaseIdentity,
	SyncVerification,
	WorkerComfyState,
	WorkerSessionState,
	WorkerSetupState,
} from "../../../shared/api";

export type SetupPreparationOutcome =
	| { status: "ready"; error?: string }
	| { status: "canceled" }
	| { status: "failed"; error: string };

export type SetupVerificationOutcome =
	| { status: "ready"; verification: SyncVerification }
	| { status: "failed"; error: string; verification?: SyncVerification };

export type ConnectionMachineOutcome = {
	result: ConnectionResult;
	update:
		| { type: "reset"; state: WorkerSessionState }
		| {
				type: "lifecycle";
				connection: ConnectionState;
				setup: WorkerSetupState;
		  }
		| { type: "connection"; connection: ConnectionState };
	initialRefresh?: () => Promise<void>;
	automaticSetup?: true;
};

export type WorkerSessionMachineServices = {
	beginInitialize: () => void;
	initialize: (signal: AbortSignal) => Promise<ConnectionMachineOutcome>;
	beginConnect: (request: ConnectionRequest) => void;
	connect: (
		signal: AbortSignal,
		request: ConnectionRequest,
	) => Promise<ConnectionMachineOutcome>;
	beginRetry: () => void;
	retry: (signal: AbortSignal) => Promise<ConnectionMachineOutcome>;
	applyConnectionOutcome: (outcome: ConnectionMachineOutcome) => void;
	disconnect: () => void;
	goOffline: (message: string, reconnectRequired?: boolean) => void;
	recoverConnection: (
		workerAddress: string,
		connectedAt: number,
		worker?: ReleaseIdentity,
	) => void;
	setSetupState: (state: WorkerSetupState) => void;
	getComfyState: () => WorkerComfyState;
	prepareSetup: (
		signal: AbortSignal,
		initialRefresh: Promise<void>,
	) => Promise<SetupPreparationOutcome>;
	selectSetupModels: () => boolean;
	synchronizeSetupModels: (
		signal: AbortSignal,
		initialRefresh: Promise<void>,
		synchronizeModels: boolean,
	) => Promise<SetupPreparationOutcome>;
	settleSetupSynchronization: (
		signal: AbortSignal,
		synchronizeModels: boolean,
	) => Promise<SetupPreparationOutcome>;
	verifySetup: (signal: AbortSignal) => Promise<SetupVerificationOutcome>;
	startSetupComfy: (signal: AbortSignal) => Promise<ConnectionResult>;
	cancelSetup: (signal: AbortSignal) => Promise<ConnectionResult>;
};

type SetupFailure = {
	phase: "preparation" | "verification" | "comfy";
	error: string;
};

type WorkerSessionMachineContext = {
	services: WorkerSessionMachineServices;
	setupPreparationError: string | null;
	setupModelError: string | null;
	setupComfyError: string | null;
	setupInitialRefresh: Promise<void>;
	startComfyForSetup: boolean;
	synchronizeModelsForSetup: boolean;
	connectionRequest: ConnectionRequest | null;
	connectionReply: ((result: ConnectionResult) => void) | null;
};

type WorkerSessionMachineEvent =
	| { type: "connection.initialize"; reply: (result: ConnectionResult) => void }
	| {
			type: "connection.connect";
			request: ConnectionRequest;
			reply: (result: ConnectionResult) => void;
	  }
	| { type: "connection.retry"; reply: (result: ConnectionResult) => void }
	| { type: "connection.disconnect" }
	| { type: "connection.offline"; message: string; reconnectRequired?: boolean }
	| {
			type: "connection.recovered";
			workerAddress: string;
			connectedAt: number;
			worker?: ReleaseIdentity;
	  }
	| {
			type: "connection.resolved";
			reply: (result: ConnectionResult) => void;
	  }
	| {
			type: "setup.start";
			initialRefresh: Promise<void>;
			startComfyForSetup: boolean;
	  }
	| { type: "setup.cancel" }
	| { type: "setup.invalidate"; runningStatus: "canceled" | "idle" }
	| { type: "xstate.done.actor.prepareSetup"; output: SetupPreparationOutcome }
	| {
			type: "xstate.done.actor.synchronizeSetupModels";
			output: SetupPreparationOutcome;
	  }
	| {
			type: "xstate.done.actor.settleSetupSynchronization";
			output: SetupPreparationOutcome;
	  }
	| { type: "xstate.done.actor.verifySetup"; output: SetupVerificationOutcome }
	| { type: "xstate.done.actor.startSetupComfy"; output: ConnectionResult }
	| { type: "xstate.done.actor.cancelSetup"; output: ConnectionResult }
	| { type: "xstate.done.actor.initialize"; output: ConnectionMachineOutcome }
	| { type: "xstate.done.actor.connect"; output: ConnectionMachineOutcome }
	| { type: "xstate.done.actor.retry"; output: ConnectionMachineOutcome };

type WorkerSessionMachineInput = { services: WorkerSessionMachineServices };

type WorkerSessionMachineArgs = {
	context: WorkerSessionMachineContext;
	event: WorkerSessionMachineEvent;
};

type ConnectActorInput = {
	run: WorkerSessionMachineServices["connect"];
	request: ConnectionRequest;
};

type SetupPreparationActorInput = {
	run: WorkerSessionMachineServices["prepareSetup"];
	initialRefresh: Promise<void>;
};

type SetupModelActorInput = {
	run: WorkerSessionMachineServices["synchronizeSetupModels"];
	initialRefresh: Promise<void>;
	synchronizeModels: boolean;
};

type SetupSettlementActorInput = {
	run: WorkerSessionMachineServices["settleSetupSynchronization"];
	synchronizeModels: boolean;
};

function setupStateFromDoneEvent(
	event: WorkerSessionMachineEvent,
): WorkerSetupState | null {
	if (
		event.type === "xstate.done.actor.prepareSetup" ||
		event.type === "xstate.done.actor.synchronizeSetupModels" ||
		event.type === "xstate.done.actor.settleSetupSynchronization"
	) {
		switch (event.output.status) {
			case "ready":
				return null;
			case "canceled":
				return { status: "canceled" };
			case "failed":
				return {
					status: "failed",
					phase: "preparation",
					error: event.output.error,
				};
		}
	}
	if (event.type === "xstate.done.actor.cancelSetup") {
		return event.output.ok
			? { status: "canceled" }
			: {
					status: "failed",
					phase: "preparation",
					error: event.output.error,
				};
	}
	return null;
}

function joinSetupErrors(previous: string | undefined, next: string): string {
	return previous === undefined ? next : `${previous} ${next}`;
}

function capturedSetupFailure(
	context: WorkerSessionMachineContext,
): SetupFailure | null {
	const errors = [context.setupPreparationError, context.setupModelError].filter(
		(error): error is string => error !== null,
	);
	const comfy = context.services.getComfyState();
	const comfyError =
		context.setupComfyError ??
		(context.startComfyForSetup && comfy.status !== "ready"
			? "Worker ComfyUI is no longer ready."
			: null);
	if (comfyError !== null) errors.push(comfyError);
	const uniqueErrors = [...new Set(errors)];
	if (uniqueErrors.length === 0) return null;
	return {
		phase: comfyError === null ? "preparation" : "comfy",
		error: uniqueErrors.join(" "),
	};
}

function verificationFailure(
	context: WorkerSessionMachineContext,
	outcome: SetupVerificationOutcome,
): SetupFailure | null {
	const captured = capturedSetupFailure(context);
	if (outcome.status === "ready") return captured;
	if (captured !== null && outcome.verification?.status === "out-of-sync") {
		return captured;
	}
	return {
		phase: captured?.phase === "comfy" ? "comfy" : "verification",
		error: joinSetupErrors(captured?.error, outcome.error),
	};
}

function setupStateFromVerification(
	context: WorkerSessionMachineContext,
	outcome: SetupVerificationOutcome,
): WorkerSetupState {
	const failure = verificationFailure(context, outcome);
	if (failure !== null) {
		const comfyStarted =
			context.startComfyForSetup &&
			context.setupComfyError === null &&
			context.services.getComfyState().status === "ready";
		return {
			status: "failed",
			phase: failure.phase,
			error: comfyStarted
				? `Worker ComfyUI started, but Worker setup is incomplete. ${failure.error}`
				: failure.error,
			...(outcome.verification === undefined
				? {}
				: { verification: outcome.verification }),
		};
	}
	return outcome.verification === undefined
		? {
				status: "failed",
				phase: "verification",
				error: "Worker setup verification is unavailable.",
			}
		: { status: "succeeded", verification: outcome.verification };
}

function connectionStateFromOutcome(
	outcome: ConnectionMachineOutcome,
): ConnectionState {
	return outcome.update.type === "reset"
		? outcome.update.state.connection
		: outcome.update.connection;
}

const workerSessionMachine = setup({
	types: {
		context: {} as WorkerSessionMachineContext,
		events: {} as WorkerSessionMachineEvent,
		input: {} as WorkerSessionMachineInput,
	},
	actors: {
		initialize: fromPromise<
			ConnectionMachineOutcome,
			WorkerSessionMachineServices["initialize"]
		>(({ input, signal }) => input(signal)),
		connect: fromPromise<ConnectionMachineOutcome, ConnectActorInput>(
			({ input, signal }) => input.run(signal, input.request),
		),
		retry: fromPromise<ConnectionMachineOutcome, WorkerSessionMachineServices["retry"]>(
			({ input, signal }) => input(signal),
		),
		prepareSetup: fromPromise<SetupPreparationOutcome, SetupPreparationActorInput>(
			({ input, signal }: { input: SetupPreparationActorInput; signal: AbortSignal }) =>
				input.run(signal, input.initialRefresh),
		),
		synchronizeSetupModels: fromPromise<SetupPreparationOutcome, SetupModelActorInput>(
			({ input, signal }: { input: SetupModelActorInput; signal: AbortSignal }) =>
				input.run(signal, input.initialRefresh, input.synchronizeModels),
		),
		settleSetupSynchronization: fromPromise<
			SetupPreparationOutcome,
			SetupSettlementActorInput
		>(({ input, signal }) => input.run(signal, input.synchronizeModels)),
		verifySetup: fromPromise<
			SetupVerificationOutcome,
			WorkerSessionMachineServices["verifySetup"]
		>(({ input, signal }) => input(signal)),
		startSetupComfy: fromPromise<
			ConnectionResult,
			WorkerSessionMachineServices["startSetupComfy"]
		>(({ input, signal }) => input(signal)),
		cancelSetup: fromPromise<
			ConnectionResult,
			WorkerSessionMachineServices["cancelSetup"]
		>(({ input, signal }) => input(signal)),
	},
	guards: {
		connectionSucceeded: ({ event }) =>
			(event.type === "xstate.done.actor.initialize" ||
				event.type === "xstate.done.actor.connect" ||
				event.type === "xstate.done.actor.retry") &&
			event.output.result.ok,
		automaticSetupRequested: ({ event }) =>
			event.type === "xstate.done.actor.connect" &&
			event.output.result.ok &&
			event.output.automaticSetup === true,
		connectionEndedInError: ({ event }) =>
			(event.type === "xstate.done.actor.initialize" ||
				event.type === "xstate.done.actor.connect" ||
				event.type === "xstate.done.actor.retry") &&
			connectionStateFromOutcome(event.output).status === "error",
		preparationReady: ({ event }) =>
			event.type === "xstate.done.actor.prepareSetup" &&
			event.output.status === "ready",
		preparationReadyWithoutComfyStart: ({ context, event }) =>
			event.type === "xstate.done.actor.prepareSetup" &&
			event.output.status === "ready" &&
			!context.startComfyForSetup,
		preparationCanceled: ({ event }) =>
			event.type === "xstate.done.actor.prepareSetup" &&
			event.output.status === "canceled",
		modelSynchronizationReady: ({ event }) =>
			event.type === "xstate.done.actor.synchronizeSetupModels" &&
			event.output.status === "ready",
		modelSynchronizationCanceled: ({ event }) =>
			event.type === "xstate.done.actor.synchronizeSetupModels" &&
			event.output.status === "canceled",
		setupSynchronizationSettled: ({ event }) =>
			event.type === "xstate.done.actor.settleSetupSynchronization" &&
			event.output.status === "ready",
		setupSynchronizationCanceled: ({ event }) =>
			event.type === "xstate.done.actor.settleSetupSynchronization" &&
			event.output.status === "canceled",
		setupSucceededAfterVerification: ({ context, event }) =>
			event.type === "xstate.done.actor.verifySetup" &&
			verificationFailure(context, event.output) === null &&
			event.output.verification !== undefined,
		cancellationSucceeded: ({ event }) =>
			event.type === "xstate.done.actor.cancelSetup" && event.output.ok,
	},
	actions: {
		beginInitialize: assign({
			connectionReply: ({ context, event }: WorkerSessionMachineArgs) => {
				context.connectionReply?.(replacedConnectionResult());
				context.services.beginInitialize();
				return event.type === "connection.initialize"
					? event.reply
					: context.connectionReply;
			},
			connectionRequest: null,
			setupPreparationError: null,
			setupModelError: null,
			setupComfyError: null,
			startComfyForSetup: true,
		}),
		beginConnect: assign({
			connectionReply: ({ context, event }: WorkerSessionMachineArgs) => {
				context.connectionReply?.(replacedConnectionResult());
				if (event.type === "connection.connect") {
					context.services.beginConnect(event.request);
					return event.reply;
				}
				return context.connectionReply;
			},
			connectionRequest: ({ context, event }) =>
				event.type === "connection.connect" ? event.request : context.connectionRequest,
			setupPreparationError: null,
			setupModelError: null,
			setupComfyError: null,
			startComfyForSetup: true,
		}),
		beginRetry: assign({
			connectionReply: ({ context, event }: WorkerSessionMachineArgs) => {
				context.connectionReply?.(replacedConnectionResult());
				context.services.beginRetry();
				return event.type === "connection.retry"
					? event.reply
					: context.connectionReply;
			},
		}),
		applyConnectionOutcome: assign({
			setupInitialRefresh: ({ context, event }) => {
				if (
					event.type !== "xstate.done.actor.initialize" &&
					event.type !== "xstate.done.actor.connect" &&
					event.type !== "xstate.done.actor.retry"
				) {
					return context.setupInitialRefresh;
				}
				context.services.applyConnectionOutcome(event.output);
				return (event.type === "xstate.done.actor.connect" ||
					event.type === "xstate.done.actor.retry") &&
					event.output.initialRefresh !== undefined
					? Promise.resolve().then(event.output.initialRefresh)
					: Promise.resolve();
			},
			connectionRequest: null,
		}),
		resolveConnection: ({ context, event, self }) => {
			if (
				event.type !== "xstate.done.actor.initialize" &&
				event.type !== "xstate.done.actor.connect" &&
				event.type !== "xstate.done.actor.retry"
			) {
				return;
			}
			const reply = context.connectionReply;
			if (reply === null) return;
			const result = event.output.result;
			// The actor publishes the next snapshot after transition actions finish.
			// Reply on the next turn so refresh work observes that published state.
			setTimeout(() => {
				reply(result);
				self.send({ type: "connection.resolved", reply });
			}, 0);
		},
		clearConnectionReply: assign({
			connectionReply: ({ context, event }: WorkerSessionMachineArgs) =>
				event.type === "connection.resolved" && context.connectionReply === event.reply
					? null
					: context.connectionReply,
		}),
		disconnectConnection: assign({
			connectionReply: ({ context }: WorkerSessionMachineArgs) => {
				context.connectionReply?.(replacedConnectionResult());
				context.services.disconnect();
				return null;
			},
			connectionRequest: null,
			setupPreparationError: null,
			setupModelError: null,
			setupComfyError: null,
		}),
		setOffline: assign({
			connectionReply: ({ context, event }: WorkerSessionMachineArgs) => {
				context.connectionReply?.(replacedConnectionResult());
				if (event.type === "connection.offline") {
					context.services.goOffline(event.message, event.reconnectRequired);
				}
				return null;
			},
			connectionRequest: null,
			setupPreparationError: null,
			setupModelError: null,
			setupComfyError: null,
		}),
		setRecovered: ({ context, event }) => {
			if (event.type === "connection.recovered") {
				context.services.recoverConnection(
					event.workerAddress,
					event.connectedAt,
					event.worker,
				);
			}
		},
		setSetupPreparation: assign({
			setupPreparationError: ({ context }) => {
				context.services.setSetupState({
					status: "running",
					phase: "preparation",
				});
				return null;
			},
			setupModelError: null,
			setupComfyError: null,
			setupInitialRefresh: ({ context, event }) =>
				event.type === "setup.start"
					? event.initialRefresh
					: context.setupInitialRefresh,
			startComfyForSetup: ({ context, event }) =>
				event.type === "setup.start"
					? event.startComfyForSetup
					: context.startComfyForSetup,
			synchronizeModelsForSetup: ({ context }) => context.services.selectSetupModels(),
		}),
		setSetupVerification: ({ context }) => {
			context.services.setSetupState({
				status: "running",
				phase: "verification",
			});
		},
		setSetupComfy: ({ context }) => {
			context.services.setSetupState({ status: "running", phase: "comfy" });
		},
		setSetupSynchronization: ({ context }) => {
			context.services.setSetupState({ status: "running", phase: "preparation" });
		},
		captureSetupPreparation: assign({
			setupPreparationError: ({ context, event }) =>
				event.type === "xstate.done.actor.prepareSetup" &&
				event.output.status === "ready" &&
				event.output.error !== undefined
					? event.output.error
					: context.setupPreparationError,
		}),
		captureSetupModels: assign({
			setupModelError: ({ context, event }) =>
				event.type === "xstate.done.actor.synchronizeSetupModels" &&
				event.output.status === "ready" &&
				event.output.error !== undefined
					? event.output.error
					: context.setupModelError,
		}),
		captureSetupComfy: assign({
			setupComfyError: ({ context, event }) =>
				event.type === "xstate.done.actor.startSetupComfy" && !event.output.ok
					? event.output.error
					: context.setupComfyError,
		}),
		applyVerificationSetupOutcome: ({ context, event }) => {
			if (event.type === "xstate.done.actor.verifySetup") {
				context.services.setSetupState(
					setupStateFromVerification(context, event.output),
				);
			}
		},
		applySetupOutcome: ({ context, event }) => {
			const setupState = setupStateFromDoneEvent(event);
			if (setupState !== null) context.services.setSetupState(setupState);
		},
		setInvalidatedSetup: assign({
			setupPreparationError: ({ context, event }) => {
				context.services.setSetupState(
					event.type === "setup.invalidate" && event.runningStatus === "canceled"
						? { status: "canceled" }
						: { status: "idle" },
				);
				return null;
			},
			setupModelError: null,
			setupComfyError: null,
		}),
	},
}).createMachine({
	id: "workerSession",
	context: ({ input }) => ({
		services: input.services,
		setupPreparationError: null,
		setupModelError: null,
		setupComfyError: null,
		setupInitialRefresh: Promise.resolve(),
		startComfyForSetup: true,
		synchronizeModelsForSetup: true,
		connectionRequest: null,
		connectionReply: null,
	}),
	initial: "disconnected",
	states: {
		disconnected: {},
		initializing: {
			invoke: {
				id: "initialize",
				src: "initialize",
				input: ({ context }: { context: WorkerSessionMachineContext }) =>
					context.services.initialize,
				onDone: [
					{
						guard: "connectionEndedInError",
						target: "error",
						actions: ["applyConnectionOutcome", "resolveConnection"],
					},
					{
						target: "disconnected",
						actions: ["applyConnectionOutcome", "resolveConnection"],
					},
				],
			},
		},
		connecting: {
			invoke: {
				id: "connect",
				src: "connect",
				input: ({ context }): ConnectActorInput => {
					if (context.connectionRequest === null) {
						throw new Error("Worker connection request is unavailable.");
					}
					return { run: context.services.connect, request: context.connectionRequest };
				},
				onDone: [
					{
						guard: "automaticSetupRequested",
						target: "#workerSession.connected.setup",
						actions: ["applyConnectionOutcome", "resolveConnection"],
					},
					{
						guard: "connectionSucceeded",
						target: "#workerSession.connected.idle",
						actions: ["applyConnectionOutcome", "resolveConnection"],
					},
					{
						guard: "connectionEndedInError",
						target: "error",
						actions: ["applyConnectionOutcome", "resolveConnection"],
					},
					{
						target: "disconnected",
						actions: ["applyConnectionOutcome", "resolveConnection"],
					},
				],
			},
		},
		retrying: {
			invoke: {
				id: "retry",
				src: "retry",
				input: ({ context }: { context: WorkerSessionMachineContext }) =>
					context.services.retry,
				onDone: [
					{
						guard: "connectionSucceeded",
						target: "#workerSession.connected.idle",
						actions: ["applyConnectionOutcome", "resolveConnection"],
					},
					{
						guard: "connectionEndedInError",
						target: "error",
						actions: ["applyConnectionOutcome", "resolveConnection"],
					},
					{
						target: "offline",
						actions: ["applyConnectionOutcome", "resolveConnection"],
					},
				],
			},
		},
		offline: {
			on: {
				"connection.recovered": {
					target: "#workerSession.connected.idle",
					actions: "setRecovered",
				},
			},
		},
		error: {},
		connected: {
			initial: "idle",
			states: {
				idle: {},
				setup: {
					type: "parallel",
					entry: "setSetupPreparation",
					states: {
						startup: {
							initial: "preparation",
							states: {
								preparation: {
									invoke: {
										id: "prepareSetup",
										src: "prepareSetup",
										input: ({ context }): SetupPreparationActorInput => ({
											run: context.services.prepareSetup,
											initialRefresh: context.setupInitialRefresh,
										}),
										onDone: [
											{
												guard: "preparationReadyWithoutComfyStart",
												target: "ready",
												actions: "captureSetupPreparation",
											},
											{
												guard: "preparationReady",
												target: "comfy",
												actions: "captureSetupPreparation",
											},
											{
												guard: "preparationCanceled",
												target: "#workerSession.connected.canceled",
												actions: "applySetupOutcome",
											},
											{
												target: "#workerSession.connected.failed",
												actions: "applySetupOutcome",
											},
										],
									},
								},
								comfy: {
									entry: "setSetupComfy",
									invoke: {
										id: "startSetupComfy",
										src: "startSetupComfy",
										input: ({ context }: { context: WorkerSessionMachineContext }) =>
											context.services.startSetupComfy,
										onDone: {
											target: "ready",
											actions: "captureSetupComfy",
										},
									},
								},
								ready: { type: "final", entry: "setSetupSynchronization" },
							},
						},
						models: {
							initial: "synchronizing",
							states: {
								synchronizing: {
									invoke: {
										id: "synchronizeSetupModels",
										src: "synchronizeSetupModels",
										input: ({ context }): SetupModelActorInput => ({
											run: context.services.synchronizeSetupModels,
											initialRefresh: context.setupInitialRefresh,
											synchronizeModels: context.synchronizeModelsForSetup,
										}),
										onDone: [
											{
												guard: "modelSynchronizationReady",
												target: "ready",
												actions: "captureSetupModels",
											},
											{
												guard: "modelSynchronizationCanceled",
												target: "#workerSession.connected.canceled",
												actions: "applySetupOutcome",
											},
											{
												target: "#workerSession.connected.failed",
												actions: "applySetupOutcome",
											},
										],
									},
								},
								ready: { type: "final" },
							},
						},
					},
					onDone: "completion",
					on: { "setup.cancel": { target: "canceling" } },
				},
				completion: {
					entry: "setSetupSynchronization",
					invoke: {
						id: "settleSetupSynchronization",
						src: "settleSetupSynchronization",
						input: ({ context }): SetupSettlementActorInput => ({
							run: context.services.settleSetupSynchronization,
							synchronizeModels: context.synchronizeModelsForSetup,
						}),
						onDone: [
							{
								guard: "setupSynchronizationSettled",
								target: "verification",
							},
							{
								guard: "setupSynchronizationCanceled",
								target: "canceled",
								actions: "applySetupOutcome",
							},
							{ target: "failed", actions: "applySetupOutcome" },
						],
					},
					on: { "setup.cancel": { target: "canceling" } },
				},
				verification: {
					entry: "setSetupVerification",
					invoke: {
						id: "verifySetup",
						src: "verifySetup",
						input: ({ context }: { context: WorkerSessionMachineContext }) =>
							context.services.verifySetup,
						onDone: [
							{
								guard: "setupSucceededAfterVerification",
								target: "succeeded",
								actions: "applyVerificationSetupOutcome",
							},
							{ target: "failed", actions: "applyVerificationSetupOutcome" },
						],
					},
				},
				canceling: {
					invoke: {
						id: "cancelSetup",
						src: "cancelSetup",
						input: ({ context }: { context: WorkerSessionMachineContext }) =>
							context.services.cancelSetup,
						onDone: [
							{
								guard: "cancellationSucceeded",
								target: "canceled",
								actions: "applySetupOutcome",
							},
							{ target: "failed", actions: "applySetupOutcome" },
						],
					},
				},
				succeeded: {},
				canceled: {},
				failed: {},
			},
			on: {
				"setup.start": { target: ".setup", reenter: true },
				"setup.invalidate": { target: ".idle", actions: "setInvalidatedSetup" },
			},
		},
	},
	on: {
		"connection.initialize": {
			target: ".initializing",
			reenter: true,
			actions: "beginInitialize",
		},
		"connection.connect": {
			target: ".connecting",
			reenter: true,
			actions: "beginConnect",
		},
		"connection.retry": {
			target: ".retrying",
			reenter: true,
			actions: "beginRetry",
		},
		"connection.disconnect": {
			target: ".disconnected",
			actions: "disconnectConnection",
		},
		"connection.offline": {
			target: ".offline",
			actions: "setOffline",
		},
		"connection.resolved": { actions: "clearConnectionReply" },
	},
});

export function createWorkerSessionMachineActor(
	services: WorkerSessionMachineServices,
) {
	return createActor(workerSessionMachine, { input: { services } });
}

export function replacedConnectionResult(): ConnectionResult {
	return { ok: false, error: "A newer Worker connection request replaced this one." };
}
