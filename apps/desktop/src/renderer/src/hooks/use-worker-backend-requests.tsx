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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function useBackendOwner() {
	const [backendAction, setBackendAction] = useState(false);
	const [backendError, setBackendError] = useState<string | null>(null);
	const [comfyRestartAction, setComfyRestartAction] = useState(false);
	const [comfyRestartError, setComfyRestartError] = useState<string | null>(null);
	const beginRequest = useWorkerRequestScope(() => {
		setBackendAction(false);
		setBackendError(null);
		setComfyRestartAction(false);
		setComfyRestartError(null);
	});
	useWorkerSessionChanges((change) => {
		switch (change.type) {
			case "backend.changed":
				setBackendError(null);
				break;
			case "comfy.changed":
				setComfyRestartError(null);
				break;
		}
	});
	const prepareBackend = useCallback(async (): Promise<void> => {
		const isCurrent = beginRequest("prepareBackend");
		setBackendAction(true);
		setBackendError(null);
		try {
			const result = await window.kastard.workerSession.prepareBackend();
			if (!isCurrent()) return;
			if (!result.ok) setBackendError(result.error);
		} catch (error) {
			if (!isCurrent()) return;
			setBackendError(errorMessage(error));
		} finally {
			if (isCurrent()) {
				setBackendAction(false);
			}
		}
	}, [beginRequest]);
	const restartWorkerComfy = useCallback(async (): Promise<void> => {
		const isCurrent = beginRequest("restartWorkerComfy");
		setComfyRestartAction(true);
		setComfyRestartError(null);
		try {
			const result = await window.kastard.workerSession.restartComfy();
			if (!isCurrent()) return;
			if (!result.ok) setComfyRestartError(result.error);
		} catch (error) {
			if (!isCurrent()) return;
			setComfyRestartError(errorMessage(error));
		} finally {
			if (isCurrent()) {
				setComfyRestartAction(false);
			}
		}
	}, [beginRequest]);
	return useMemo(
		() => ({
			backendAction,
			backendError,
			comfyRestartAction,
			comfyRestartError,
			prepareBackend,
			restartWorkerComfy,
		}),
		[
			backendAction,
			backendError,
			comfyRestartAction,
			comfyRestartError,
			prepareBackend,
			restartWorkerComfy,
		],
	);
}
const Context = createContext<ReturnType<typeof useBackendOwner> | null>(null);
export function BackendRequestsProvider({
	children,
}: {
	children: ReactNode;
}): React.JSX.Element {
	const value = useBackendOwner();
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useBackendRequests() {
	const value = useContext(Context);
	if (value === null)
		throw new Error("Worker requests require BackendRequestsProvider.");
	return value;
}
