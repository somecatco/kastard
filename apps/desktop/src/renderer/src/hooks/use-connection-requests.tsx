import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	getWorkerSessionEpoch,
	getWorkerSessionState,
	useWorkerSessionSubscription,
} from "@/hooks/use-worker-session";
import type { ConnectionResult, ConnectionState } from "../../../shared/api";

type Action = "initialize" | "retry" | "disconnect";
type Feedback = { type: "success" | "error"; message: string };
function useConnectionOwner() {
	const [connectionAction, setConnectionAction] = useState<Action | null>(null);
	const [actionFeedback, setActionFeedback] = useState<Feedback | null>(null);
	const active = useRef<{
		token: symbol;
		action: Action;
		from: ConnectionState;
		epoch: number;
		awaitingTransition: boolean;
	} | null>(null);
	const observedEpoch = useRef(getWorkerSessionEpoch());
	useWorkerSessionSubscription(() => {
		const epoch = getWorkerSessionEpoch();
		if (observedEpoch.current === epoch) return;
		observedEpoch.current = epoch;
		const request = active.current;
		const next = getWorkerSessionState().connection;
		const expected =
			request?.awaitingTransition &&
			(((request.action === "disconnect" || request.action === "initialize") &&
				next.status === "disconnected") ||
				(request.action === "retry" &&
					request.from.status === "offline" &&
					(next.status === "connected" || next.status === "offline") &&
					next.workerAddress === request.from.workerAddress &&
					next.provider === request.from.provider));
		// Connection commands own their expected lifecycle transition until the IPC reply.
		if (request && expected) {
			request.epoch = epoch;
			request.awaitingTransition = false;
			return;
		}
		active.current = null;
		setConnectionAction(null);
		setActionFeedback(null);
	});
	useEffect(
		() => () => {
			active.current = null;
		},
		[],
	);
	const run = useCallback(
		async (
			action: Action,
			operation: () => Promise<ConnectionResult>,
			successMessage?: string,
		) => {
			const token = Symbol();
			active.current = {
				token,
				action,
				from: getWorkerSessionState().connection,
				epoch: getWorkerSessionEpoch(),
				awaitingTransition: true,
			};
			const isCurrent = () =>
				active.current?.token === token &&
				active.current.epoch === getWorkerSessionEpoch();
			setConnectionAction(action);
			setActionFeedback(null);
			try {
				const result = await operation();
				if (!isCurrent()) return;
				if (!result.ok) setActionFeedback({ type: "error", message: result.error });
				else if (successMessage !== undefined)
					setActionFeedback({ type: "success", message: successMessage });
			} catch (error) {
				if (isCurrent())
					setActionFeedback({
						type: "error",
						message: error instanceof Error ? error.message : String(error),
					});
			} finally {
				if (isCurrent()) {
					active.current = null;
					setConnectionAction(null);
				}
			}
		},
		[],
	);
	const retry = useCallback(
		() => run("retry", window.kastard.workerSession.retry, "Connection restored."),
		[run],
	);
	const retryInitialization = useCallback(
		() => run("initialize", window.kastard.workerSession.retryInitialization),
		[run],
	);
	const disconnect = useCallback(
		() => run("disconnect", window.kastard.workerSession.disconnect),
		[run],
	);
	const clearSuccessFeedback = useCallback(() => {
		setActionFeedback((feedback) => (feedback?.type === "success" ? null : feedback));
	}, []);
	return useMemo(
		() => ({
			connectionAction,
			actionFeedback,
			retry,
			retryInitialization,
			disconnect,
			clearSuccessFeedback,
		}),
		[
			connectionAction,
			actionFeedback,
			retry,
			retryInitialization,
			disconnect,
			clearSuccessFeedback,
		],
	);
}
const Context = createContext<ReturnType<typeof useConnectionOwner> | null>(null);
export function ConnectionRequestsProvider({
	children,
}: {
	children: ReactNode;
}): React.JSX.Element {
	const value = useConnectionOwner();
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useConnectionRequests() {
	const value = useContext(Context);
	if (value === null)
		throw new Error("Connection requests require ConnectionRequestsProvider.");
	return value;
}
