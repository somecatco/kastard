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
import { ConnectWorkerDialog } from "@/components/ConnectWorkerDialog";
import { CustomNodeReinstallDialog } from "@/components/CustomNodeReinstallDialog";
import { CustomNodeRemovalDialog } from "@/components/CustomNodeRemovalDialog";
import { ModelRedownloadDialog } from "@/components/ModelRedownloadDialog";
import { WorkerLogsDialog } from "@/components/WorkerLogsDialog";
import { useConnectionSettings } from "@/hooks/use-connection-settings";
import { useModelsRequests } from "@/hooks/use-worker-models-requests";
import { useNodesRequests } from "@/hooks/use-worker-nodes-requests";
import {
	getWorkerSessionEpoch,
	getWorkerSessionState,
	useWorkerSessionSelector,
	useWorkerSessionSubscription,
} from "@/hooks/use-worker-session";
import type { CustomNodeInventoryEntry } from "../../../../shared/api";

type Confirmation<Value> = { epoch: number; value: Value };
function useDialogs() {
	const settings = useConnectionSettings();
	const [open, setOpen] = useState(false);
	const [logsOpen, setLogsOpen] = useState(false);
	const [syncDraft, setSyncDraft] = useState<boolean | null>(null);
	const [reinstall, setReinstall] = useState<Confirmation<string> | null>(null);
	const [removal, setRemoval] = useState<Confirmation<CustomNodeInventoryEntry> | null>(
		null,
	);
	const [redownload, setRedownload] = useState<Confirmation<string> | null>(null);
	const showDialog = useCallback(() => {
		setSyncDraft(settings.settingsReady ? settings.syncAfterConnect : null);
		setOpen(true);
	}, [settings.settingsReady, settings.syncAfterConnect]);
	const viewLogs = useCallback(() => setLogsOpen(true), []);
	const requestCustomNodeReinstall = useCallback(
		(value: string) => setReinstall({ value, epoch: getWorkerSessionEpoch() }),
		[],
	);
	const requestCustomNodeRemoval = useCallback(
		(value: CustomNodeInventoryEntry) =>
			setRemoval({ value, epoch: getWorkerSessionEpoch() }),
		[],
	);
	const requestModelRedownload = useCallback(
		(value: string) => setRedownload({ value, epoch: getWorkerSessionEpoch() }),
		[],
	);
	const actions = useMemo(
		() => ({
			showDialog,
			viewLogs,
			requestCustomNodeReinstall,
			requestCustomNodeRemoval,
			requestModelRedownload,
		}),
		[
			showDialog,
			viewLogs,
			requestCustomNodeReinstall,
			requestCustomNodeRemoval,
			requestModelRedownload,
		],
	);
	const closeConfirmations = useCallback(() => {
		setReinstall(null);
		setRemoval(null);
		setRedownload(null);
	}, []);
	const observedEpoch = useRef(getWorkerSessionEpoch());
	useWorkerSessionSubscription(() => {
		const epoch = getWorkerSessionEpoch();
		if (observedEpoch.current === epoch) return;
		observedEpoch.current = epoch;
		closeConfirmations();
		setLogsOpen(false);
	});

	useEffect(() => {
		if (open && syncDraft === null && settings.settingsReady)
			setSyncDraft(settings.syncAfterConnect);
	}, [open, syncDraft, settings.settingsReady, settings.syncAfterConnect]);
	return {
		actions,
		open,
		setOpen,
		logsOpen,
		setLogsOpen,
		syncDraft,
		reinstall,
		setReinstall,
		removal,
		setRemoval,
		redownload,
		setRedownload,
		closeConfirmations,
	};
}
const Context = createContext<ReturnType<typeof useDialogs>["actions"] | null>(null);
export function useConnectionDialogs() {
	const value = useContext(Context);
	if (value === null)
		throw new Error("Connection dialogs require ConnectionDialogsProvider.");
	return value;
}
export function ConnectionDialogsProvider({
	children,
	closeRequest,
}: {
	children: ReactNode;
	closeRequest: number;
}): React.JSX.Element {
	const dialogs = useDialogs();
	const { setOpen, setLogsOpen, closeConfirmations } = dialogs;
	useEffect(() => {
		if (closeRequest === 0) return;
		setOpen(false);
		setLogsOpen(false);
		closeConfirmations();
	}, [closeRequest, setOpen, setLogsOpen, closeConfirmations]);
	return (
		<Context.Provider value={dialogs.actions}>
			{children}
			<ConnectionDialogs dialogs={dialogs} />
		</Context.Provider>
	);
}
function validConfirmation<Value>(
	confirmation: Confirmation<Value> | null,
): confirmation is Confirmation<Value> {
	return (
		confirmation !== null &&
		confirmation.epoch === getWorkerSessionEpoch() &&
		getWorkerSessionState().connection.status === "connected"
	);
}
function ConnectionDialogs({
	dialogs,
}: {
	dialogs: ReturnType<typeof useDialogs>;
}): React.JSX.Element {
	const state = useWorkerSessionSelector((session) => session.connection);
	const models = useWorkerSessionSelector((session) => session.models);
	const settings = useConnectionSettings();
	const nodesRequests = useNodesRequests();
	const modelsRequests = useModelsRequests();
	const { setOpen, setLogsOpen } = dialogs;
	useEffect(() => {
		if (state.status === "connected") setOpen(false);
		else setLogsOpen(false);
	}, [state.status, setOpen, setLogsOpen]);
	const redownloadTarget =
		validConfirmation(dialogs.redownload) &&
		"targetModels" in models &&
		models.targetStatus === "current"
			? (models.targetModels?.find(
					(model) => model.target.path === dialogs.redownload?.value,
				)?.target ?? null)
			: null;
	return (
		<>
			<CustomNodeReinstallDialog
				nodeId={validConfirmation(dialogs.reinstall) ? dialogs.reinstall.value : null}
				onOpenChange={(open) => {
					if (!open) dialogs.setReinstall(null);
				}}
				onConfirm={(id) => {
					const nodes = getWorkerSessionState().customNodes;
					if (
						validConfirmation(dialogs.reinstall) &&
						dialogs.reinstall.value === id &&
						"targetNodes" in nodes &&
						nodes.targetStatus === "current" &&
						nodes.targetNodes?.some((node) => node.id === id)
					)
						void nodesRequests.reinstallCustomNode(id);
					dialogs.setReinstall(null);
				}}
			/>
			<CustomNodeRemovalDialog
				node={validConfirmation(dialogs.removal) ? dialogs.removal.value : null}
				onOpenChange={(open) => {
					if (!open) dialogs.setRemoval(null);
				}}
				onConfirm={(node) => {
					const current = getWorkerSessionState().customNodes;
					if (
						validConfirmation(dialogs.removal) &&
						dialogs.removal.value === node &&
						"unselectedNodes" in current &&
						current.targetStatus === "current" &&
						current.unselectedNodes?.some(
							(candidate) =>
								candidate.name === node.name &&
								candidate.managerId === node.managerId &&
								candidate.version === node.version,
						)
					)
						void nodesRequests.removeCustomNode(node);
					dialogs.setRemoval(null);
				}}
			/>
			<ModelRedownloadDialog
				target={redownloadTarget}
				onOpenChange={(open) => {
					if (!open) dialogs.setRedownload(null);
				}}
				onConfirm={(path) => {
					const current = getWorkerSessionState().models;
					if (
						validConfirmation(dialogs.redownload) &&
						dialogs.redownload.value === path &&
						"targetModels" in current &&
						current.targetStatus === "current" &&
						current.targetModels?.some((model) => model.target.path === path)
					)
						void modelsRequests.redownloadModel(path);
					dialogs.setRedownload(null);
				}}
			/>
			<WorkerLogsDialog open={dialogs.logsOpen} onOpenChange={setLogsOpen} />
			{dialogs.open ? (
				<ConnectWorkerDialog
					initialProvider={
						state.status === "disconnected"
							? state.recentProvider
							: state.status === "error"
								? null
								: state.provider
					}
					initialWorkerAddress={
						state.status === "disconnected"
							? state.recentWorkerAddress
							: state.status === "error"
								? null
								: state.workerAddress
					}
					initialSyncAfterConnect={dialogs.syncDraft}
					defaultWorkerAddress={import.meta.env.DEV ? "127.0.0.1:5279" : ""}
					settingsLoading={settings.settingsLoading}
					settingsError={settings.settingsLoadError}
					onRetrySettings={settings.reloadSettings}
					onConnect={settings.connect}
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	);
}
