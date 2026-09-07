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
function useModelsOwner() {
	const [modelSyncAction, setModelSyncAction] = useState(false);
	const [preparingRedownloadPath, setPreparingRedownloadPath] = useState<string | null>(
		null,
	);
	const [modelSyncCancelAction, setModelSyncCancelAction] = useState(false);
	const [modelSyncError, setModelSyncError] = useState<string | null>(null);
	const beginRequest = useWorkerRequestScope(() => {
		setModelSyncAction(false);
		setPreparingRedownloadPath(null);
		setModelSyncCancelAction(false);
		setModelSyncError(null);
	});
	useWorkerSessionChanges((change) => {
		switch (change.type) {
			case "models.changed":
				setModelSyncError(null);
				break;
		}
	});
	const syncModels = useCallback(async (): Promise<void> => {
		const isCurrent = beginRequest("syncModels");
		setModelSyncAction(true);
		setModelSyncError(null);
		try {
			const result = await window.kastard.workerSession.syncModels();
			if (!isCurrent()) return;
			if (!result.ok) setModelSyncError(result.error);
		} catch (error) {
			if (!isCurrent()) return;
			setModelSyncError(errorMessage(error));
		} finally {
			if (isCurrent()) {
				setModelSyncAction(false);
			}
		}
	}, [beginRequest]);
	const redownloadModel = useCallback(
		async (path: string): Promise<void> => {
			const isCurrent = beginRequest("redownloadModel");
			setPreparingRedownloadPath(path);
			setModelSyncError(null);
			try {
				const result = await window.kastard.workerSession.redownloadModel({ path });
				if (!isCurrent()) return;
				if (!result.ok) setModelSyncError(result.error);
			} catch (error) {
				if (!isCurrent()) return;
				setModelSyncError(errorMessage(error));
			} finally {
				if (isCurrent()) {
					setPreparingRedownloadPath(null);
				}
			}
		},
		[beginRequest],
	);
	const cancelModels = useCallback(async (): Promise<void> => {
		const isCurrent = beginRequest("cancelModels");
		setModelSyncCancelAction(true);
		setModelSyncError(null);
		try {
			const result = await window.kastard.workerSession.cancelModels();
			if (!isCurrent()) return;
			if (!result.ok) setModelSyncError(result.error);
		} catch (error) {
			if (!isCurrent()) return;
			setModelSyncError(errorMessage(error));
		} finally {
			if (isCurrent()) {
				setModelSyncCancelAction(false);
			}
		}
	}, [beginRequest]);
	return useMemo(
		() => ({
			modelSyncAction,
			preparingRedownloadPath,
			modelSyncCancelAction,
			modelSyncError,
			syncModels,
			redownloadModel,
			cancelModels,
		}),
		[
			modelSyncAction,
			preparingRedownloadPath,
			modelSyncCancelAction,
			modelSyncError,
			syncModels,
			redownloadModel,
			cancelModels,
		],
	);
}
const Context = createContext<ReturnType<typeof useModelsOwner> | null>(null);
export function ModelsRequestsProvider({
	children,
}: {
	children: ReactNode;
}): React.JSX.Element {
	const value = useModelsOwner();
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useModelsRequests() {
	const value = useContext(Context);
	if (value === null)
		throw new Error("Worker requests require ModelsRequestsProvider.");
	return value;
}
