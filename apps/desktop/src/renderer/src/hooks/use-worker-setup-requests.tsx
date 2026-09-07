import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { useWorkerRequestScope } from "@/hooks/use-worker-request-scope";
import { useWorkerSessionChanges } from "@/hooks/use-worker-session";

type ActionFeedback = { type: "success" | "error"; message: string };
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function useSetupOwner() {
	const [setupStartAction, setSetupStartAction] = useState(false);
	const [verificationAction, setVerificationAction] = useState(false);
	const [verificationError, setVerificationError] = useState<string | null>(null);
	const [setupCancelAction, setSetupCancelAction] = useState(false);
	const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
	const beginRequest = useWorkerRequestScope(() => {
		setSetupStartAction(false);
		setVerificationAction(false);
		setVerificationError(null);
		setSetupCancelAction(false);
		setActionFeedback(null);
	});
	useWorkerSessionChanges((change) => {
		switch (change.type) {
			case "backend.changed":
				setVerificationError(null);
				break;
			case "custom-nodes.changed":
				setVerificationError(null);
				break;
			case "models.changed":
				setVerificationError(null);
				break;
			case "verification.changed":
				setVerificationError(null);
				break;
		}
	});
	const startWorkerSetup = useCallback(async (): Promise<void> => {
		const isCurrent = beginRequest("startWorkerSetup");
		setSetupStartAction(true);
		setActionFeedback(null);
		try {
			const result = await window.kastard.workerSession.startSetup();
			if (!isCurrent()) return;
			if (!result.ok) {
				setActionFeedback({ type: "error", message: result.error });
			}
		} catch (error) {
			if (!isCurrent()) return;
			setActionFeedback({ type: "error", message: errorMessage(error) });
		} finally {
			if (isCurrent()) setSetupStartAction(false);
		}
	}, [beginRequest]);
	const cancelWorkerSetup = useCallback(async (): Promise<void> => {
		const isCurrent = beginRequest("cancelWorkerSetup");
		setSetupCancelAction(true);
		setActionFeedback(null);
		try {
			const result = await window.kastard.workerSession.cancelSetup();
			if (!isCurrent()) return;
			if (!result.ok) setActionFeedback({ type: "error", message: result.error });
		} catch (error) {
			if (!isCurrent()) return;
			setActionFeedback({ type: "error", message: errorMessage(error) });
		} finally {
			if (isCurrent()) {
				setSetupCancelAction(false);
			}
		}
	}, [beginRequest]);
	const verifySynchronization = useCallback(async (): Promise<void> => {
		const isCurrent = beginRequest("verifySynchronization");
		setVerificationAction(true);
		setVerificationError(null);
		try {
			const result = await window.kastard.workerSession.verify();
			if (!isCurrent()) return;
			if (!result.ok) setVerificationError(result.error);
		} catch (error) {
			if (!isCurrent()) return;
			setVerificationError(errorMessage(error));
		} finally {
			if (isCurrent()) {
				setVerificationAction(false);
			}
		}
	}, [beginRequest]);
	return useMemo(
		() => ({
			setupStartAction,
			verificationAction,
			verificationError,
			setupCancelAction,
			actionFeedback,
			startWorkerSetup,
			cancelWorkerSetup,
			verifySynchronization,
		}),
		[
			setupStartAction,
			verificationAction,
			verificationError,
			setupCancelAction,
			actionFeedback,
			startWorkerSetup,
			cancelWorkerSetup,
			verifySynchronization,
		],
	);
}
const Context = createContext<ReturnType<typeof useSetupOwner> | null>(null);
export function SetupRequestsProvider({
	children,
}: {
	children: ReactNode;
}): React.JSX.Element {
	const value = useSetupOwner();
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSetupRequests() {
	const value = useContext(Context);
	if (value === null) throw new Error("Worker requests require SetupRequestsProvider.");
	return value;
}
