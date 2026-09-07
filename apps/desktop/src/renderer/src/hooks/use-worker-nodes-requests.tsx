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
import type { CustomNodeInventoryEntry } from "../../../shared/api";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function useNodesOwner() {
	const [syncAction, setSyncAction] = useState(false);
	const [preparingReinstallNodeId, setPreparingReinstallNodeId] = useState<
		string | null
	>(null);
	const [preparingRemovalNodeName, setPreparingRemovalNodeName] = useState<
		string | null
	>(null);
	const [syncCancelAction, setSyncCancelAction] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	const beginRequest = useWorkerRequestScope(() => {
		setSyncAction(false);
		setPreparingReinstallNodeId(null);
		setPreparingRemovalNodeName(null);
		setSyncCancelAction(false);
		setSyncError(null);
	});
	useWorkerSessionChanges((change) => {
		switch (change.type) {
			case "custom-nodes.changed":
				setSyncError(null);
				break;
		}
	});
	const syncCustomNodes = useCallback(async (): Promise<void> => {
		const isCurrent = beginRequest("syncCustomNodes");
		setSyncAction(true);
		setSyncError(null);
		try {
			const result = await window.kastard.workerSession.syncCustomNodes();
			if (!isCurrent()) return;
			if (!result.ok) setSyncError(result.error);
		} catch (error) {
			if (!isCurrent()) return;
			setSyncError(errorMessage(error));
		} finally {
			if (isCurrent()) {
				setSyncAction(false);
			}
		}
	}, [beginRequest]);
	const reinstallCustomNode = useCallback(
		async (id: string): Promise<void> => {
			const isCurrent = beginRequest("reinstallCustomNode");
			setPreparingReinstallNodeId(id);
			setSyncError(null);
			try {
				const result = await window.kastard.workerSession.reinstallCustomNode({ id });
				if (!isCurrent()) return;
				if (!result.ok) setSyncError(result.error);
			} catch (error) {
				if (!isCurrent()) return;
				setSyncError(errorMessage(error));
			} finally {
				if (isCurrent()) {
					setPreparingReinstallNodeId(null);
				}
			}
		},
		[beginRequest],
	);
	const removeCustomNode = useCallback(
		async (node: CustomNodeInventoryEntry): Promise<void> => {
			const isCurrent = beginRequest("removeCustomNode");
			setPreparingRemovalNodeName(node.name);
			setSyncError(null);
			try {
				const result = await window.kastard.workerSession.removeCustomNode({ node });
				if (!isCurrent()) return;
				if (!result.ok) setSyncError(result.error);
			} catch (error) {
				if (!isCurrent()) return;
				setSyncError(errorMessage(error));
			} finally {
				if (isCurrent()) {
					setPreparingRemovalNodeName(null);
				}
			}
		},
		[beginRequest],
	);
	const cancelCustomNodes = useCallback(async (): Promise<void> => {
		const isCurrent = beginRequest("cancelCustomNodes");
		setSyncCancelAction(true);
		setSyncError(null);
		try {
			const result = await window.kastard.workerSession.cancelCustomNodes();
			if (!isCurrent()) return;
			if (!result.ok) setSyncError(result.error);
		} catch (error) {
			if (!isCurrent()) return;
			setSyncError(errorMessage(error));
		} finally {
			if (isCurrent()) {
				setSyncCancelAction(false);
			}
		}
	}, [beginRequest]);
	return useMemo(
		() => ({
			syncAction,
			preparingReinstallNodeId,
			preparingRemovalNodeName,
			syncCancelAction,
			syncError,
			syncCustomNodes,
			reinstallCustomNode,
			removeCustomNode,
			cancelCustomNodes,
		}),
		[
			syncAction,
			preparingReinstallNodeId,
			preparingRemovalNodeName,
			syncCancelAction,
			syncError,
			syncCustomNodes,
			reinstallCustomNode,
			removeCustomNode,
			cancelCustomNodes,
		],
	);
}
const Context = createContext<ReturnType<typeof useNodesOwner> | null>(null);
export function NodesRequestsProvider({
	children,
}: {
	children: ReactNode;
}): React.JSX.Element {
	const value = useNodesOwner();
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useNodesRequests() {
	const value = useContext(Context);
	if (value === null) throw new Error("Worker requests require NodesRequestsProvider.");
	return value;
}
