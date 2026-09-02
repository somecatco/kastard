import {
	CheckIcon,
	CircleAlertIcon,
	CircleIcon,
	DownloadIcon,
	FileTextIcon,
	LoaderCircleIcon,
	PlayIcon,
	PlugIcon,
	RefreshCwIcon,
	UnplugIcon,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useEffectEvent,
	useId,
	useRef,
	useState,
} from "react";
import { ConnectWorkerDialog } from "@/components/ConnectWorkerDialog";
import { CustomNodeReinstallDialog } from "@/components/CustomNodeReinstallDialog";
import { CustomNodeRemovalDialog } from "@/components/CustomNodeRemovalDialog";
import { Popover, PopoverContent } from "@/components/common/popover";
import { ProgressBar } from "@/components/common/progress-bar";
import { Tooltip } from "@/components/common/tooltip";
import { ModelRedownloadDialog } from "@/components/ModelRedownloadDialog";
import { ServerLogsDialog } from "@/components/ServerLogsDialog";
import { ServerStatus } from "@/components/ServerStatus";
import { Button } from "@/components/ui/button";
import { PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	verifiedCustomNodeTargets,
	WorkerCustomNodeSyncStatus,
} from "@/components/WorkerCustomNodeSyncStatus";
import { WorkerModelSyncStatus } from "@/components/WorkerModelSyncStatus";
import { WorkerSyncCancelButton } from "@/components/WorkerSyncList";
import { useWorkerSession, useWorkerSessionChanges } from "@/hooks/use-worker-session";
import { useModelDownloadRate } from "@/hooks/useModelDownloadRate";
import { useOptimisticUpdateQueue } from "@/hooks/useOptimisticUpdateQueue";
import { cn } from "@/lib/utils";
import { workerComputeLabel } from "@/lib/worker-runtime";
import type {
	BackendVerification,
	CollectionVerification,
	ConnectionResult,
	ConnectionSettings as ConnectionSettingsValue,
	ConnectionState,
	CustomNodeInventoryEntry,
	SyncVerification,
	VerificationProblem,
	WorkerBackendState,
	WorkerComfyState,
	WorkerCustomNodeSyncState,
	WorkerModelSyncState,
	WorkerSetupState,
	WorkerSystemMetricsState,
	WorkerWorkflowCurrentState,
} from "../../../shared/api";

const DEFAULT_SERVER_URL = import.meta.env.DEV ? "127.0.0.1:5279" : "";
const CONNECTION_MINUTE_MS = 60_000;
type ActionFeedback = { type: "success" | "error"; message: string };
type SyncAreaStatus = "pending" | "syncing" | "synced" | "warning" | "error";
type SyncAreaId = "backend" | "nodes" | "models";
export type ConnectionPopoverId = "details" | SyncAreaId;
type SyncAreaSummary = {
	id: SyncAreaId;
	label: "Backend" | "Nodes" | "Models";
	fullLabel: "ComfyUI Backend" | "Custom Nodes" | "Models";
	shortLabel: "B" | "N" | "M";
	status: SyncAreaStatus;
	completed: number;
	total: number;
};
type ConnectionController = {
	state: ConnectionState;
	workflow: WorkerWorkflowCurrentState | null;
	systemMetrics: WorkerSystemMetricsState;
	syncAfterConnect: boolean;
	systemMetricsEnabled: boolean;
	settingsLoading: boolean;
	settingsError: string | null;
	systemMetricsError: string | null;
	setupState: WorkerSetupState;
	backendState: WorkerBackendState;
	backendAction: boolean;
	backendError: string | null;
	workerComfyState: WorkerComfyState;
	comfyRestartAction: boolean;
	comfyRestartError: string | null;
	syncState: WorkerCustomNodeSyncState;
	syncAction: boolean;
	preparingReinstallNodeId: string | null;
	preparingRemovalNodeName: string | null;
	syncCancelAction: boolean;
	syncError: string | null;
	modelSyncState: WorkerModelSyncState;
	modelSyncAction: boolean;
	preparingRedownloadPath: string | null;
	modelSyncCancelAction: boolean;
	modelSyncError: string | null;
	modelSyncRate: number | null;
	verification: SyncVerification | null;
	verificationAction: boolean;
	verificationError: string | null;
	connectionAction: "initialize" | "retry" | "disconnect" | null;
	setupCancelAction: boolean;
	actionFeedback: ActionFeedback | null;
	showDialog: () => void;
	retryInitialization: () => Promise<void>;
	retry: () => Promise<void>;
	disconnect: () => Promise<void>;
	prepareBackend: () => Promise<void>;
	startWorkerSetup: () => Promise<void>;
	cancelWorkerSetup: () => Promise<void>;
	restartWorkerComfy: () => Promise<void>;
	syncCustomNodes: () => Promise<void>;
	requestCustomNodeReinstall: (id: string) => void;
	requestCustomNodeRemoval: (node: CustomNodeInventoryEntry) => void;
	cancelCustomNodes: () => Promise<void>;
	syncModels: () => Promise<void>;
	requestModelRedownload: (path: string) => void;
	cancelModels: () => Promise<void>;
	verifySynchronization: () => Promise<void>;
	viewLogs: () => void;
	resetActionFeedback: () => void;
	updateSyncAfterConnect: (value: boolean) => Promise<boolean>;
	updateSystemMetricsEnabled: (value: boolean) => Promise<boolean>;
};

const ConnectionContext = createContext<ConnectionController | null>(null);

export function ConnectionProvider({
	children,
	closeRequest,
}: {
	children: ReactNode;
	closeRequest: number;
}): React.JSX.Element {
	const workerSession = useWorkerSession();
	const state = workerSession.connection;
	const workflow = workerSession.workflow ?? null;
	const systemMetrics = workerSession.systemMetrics;
	const setupState = workerSession.setup;
	const backendState = workerSession.backend;
	const workerComfyState = workerSession.comfy;
	const syncState = workerSession.customNodes;
	const modelSyncState = workerSession.models;
	const verification = workerSession.verification;
	const [syncAfterConnect, setSyncAfterConnect] = useState(true);
	const [systemMetricsEnabled, setSystemMetricsEnabled] = useState(true);
	const [connectSyncAfterConnect, setConnectSyncAfterConnect] = useState(true);
	const [settingsLoading, setSettingsLoading] = useState(true);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [systemMetricsError, setSystemMetricsError] = useState<string | null>(null);
	const { confirm: confirmSettings, enqueue: enqueueSettings } =
		useOptimisticUpdateQueue<"settings", ConnectionSettingsValue>({
			trackPending: false,
		});
	const confirmedSettingsRef = useRef<ConnectionSettingsValue>({
		syncAfterConnect: true,
		systemMetricsEnabled: true,
	});
	const settingsUpdateTailRef = useRef<Promise<boolean>>(Promise.resolve(true));
	const [backendAction, setBackendAction] = useState(false);
	const [backendError, setBackendError] = useState<string | null>(null);
	const [comfyRestartAction, setComfyRestartAction] = useState(false);
	const [comfyRestartError, setComfyRestartError] = useState<string | null>(null);
	const [syncAction, setSyncAction] = useState(false);
	const [preparingReinstallNodeId, setPreparingReinstallNodeId] = useState<
		string | null
	>(null);
	const [reinstallConfirmationId, setReinstallConfirmationId] = useState<string | null>(
		null,
	);
	const [preparingRemovalNodeName, setPreparingRemovalNodeName] = useState<
		string | null
	>(null);
	const [removalConfirmationNode, setRemovalConfirmationNode] =
		useState<CustomNodeInventoryEntry | null>(null);
	const [redownloadConfirmationPath, setRedownloadConfirmationPath] = useState<
		string | null
	>(null);
	const [syncCancelAction, setSyncCancelAction] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	const [modelSyncAction, setModelSyncAction] = useState(false);
	const [preparingRedownloadPath, setPreparingRedownloadPath] = useState<string | null>(
		null,
	);
	const [modelSyncCancelAction, setModelSyncCancelAction] = useState(false);
	const [modelSyncError, setModelSyncError] = useState<string | null>(null);
	const modelSyncRate = useModelDownloadRate(modelSyncState);
	const [verificationAction, setVerificationAction] = useState(false);
	const [verificationError, setVerificationError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [logsOpen, setLogsOpen] = useState(false);
	const [connectionAction, setConnectionAction] = useState<
		"initialize" | "retry" | "disconnect" | null
	>(null);
	const [setupCancelAction, setSetupCancelAction] = useState(false);
	const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
	useWorkerSessionChanges((change) => {
		switch (change.type) {
			case "session.reset":
				setBackendError(null);
				setComfyRestartError(null);
				setSyncError(null);
				setModelSyncError(null);
				setVerificationError(null);
				break;
			case "backend.changed":
				setBackendError(null);
				setVerificationError(null);
				break;
			case "comfy.changed":
				setComfyRestartError(null);
				break;
			case "custom-nodes.changed":
				setSyncError(null);
				setVerificationError(null);
				break;
			case "models.changed":
				setModelSyncError(null);
				setVerificationError(null);
				break;
			case "verification.changed":
				setVerificationError(null);
		}
	});

	useEffect(() => {
		let active = true;
		void window.kastard.connection
			.getSettings()
			.then((result) => {
				if (!active) return;
				if (result.ok) {
					confirmedSettingsRef.current = result.settings;
					confirmSettings("settings", result.settings);
					setSyncAfterConnect(result.settings.syncAfterConnect);
					setSystemMetricsEnabled(result.settings.systemMetricsEnabled);
					setConnectSyncAfterConnect(result.settings.syncAfterConnect);
				} else setSettingsError(result.error);
			})
			.catch((error: unknown) => {
				if (active) setSettingsError(errorMessage(error));
			})
			.finally(() => {
				if (active) setSettingsLoading(false);
			});
		return () => {
			active = false;
		};
	}, [confirmSettings]);

	useEffect(() => {
		if (state.status === "connected") {
			setOpen(false);
			return;
		}
		setLogsOpen(false);
		setReinstallConfirmationId(null);
		setRedownloadConfirmationPath(null);
	}, [state.status]);

	useEffect(() => {
		if (closeRequest === 0) return;
		setOpen(false);
		setLogsOpen(false);
		setReinstallConfirmationId(null);
		setRedownloadConfirmationPath(null);
		setSyncError(null);
		setModelSyncError(null);
		setVerificationError(null);
	}, [closeRequest]);

	const showDialog = (): void => {
		setConnectSyncAfterConnect(syncAfterConnect);
		setOpen(true);
	};

	const runConnectionAction = async (
		action: "initialize" | "retry" | "disconnect",
		operation: () => Promise<ConnectionResult>,
		successMessage?: string,
	): Promise<void> => {
		setConnectionAction(action);
		setActionFeedback(null);
		try {
			const result = await operation();
			if (!result.ok) {
				setActionFeedback({ type: "error", message: result.error });
			} else if (successMessage !== undefined) {
				setActionFeedback({ type: "success", message: successMessage });
			}
		} catch (error) {
			setActionFeedback({
				type: "error",
				message: errorMessage(error),
			});
		} finally {
			setConnectionAction(null);
		}
	};

	const retry = (): Promise<void> =>
		runConnectionAction(
			"retry",
			window.kastard.workerSession.retry,
			"Connection restored.",
		);

	const retryInitialization = (): Promise<void> =>
		runConnectionAction("initialize", window.kastard.workerSession.retryInitialization);

	const disconnect = (): Promise<void> =>
		runConnectionAction("disconnect", window.kastard.workerSession.disconnect);

	const prepareBackend = async (): Promise<void> => {
		setBackendAction(true);
		setBackendError(null);
		try {
			const result = await window.kastard.workerSession.prepareBackend();
			if (!result.ok) setBackendError(result.error);
		} catch (error) {
			setBackendError(errorMessage(error));
		} finally {
			setBackendAction(false);
		}
	};

	const startWorkerSetup = async (): Promise<void> => {
		try {
			const result = await window.kastard.workerSession.startSetup();
			if (!result.ok) {
				setActionFeedback({ type: "error", message: result.error });
			}
		} catch (error) {
			setActionFeedback({ type: "error", message: errorMessage(error) });
		}
	};

	const cancelWorkerSetup = async (): Promise<void> => {
		setSetupCancelAction(true);
		setActionFeedback(null);
		try {
			const result = await window.kastard.workerSession.cancelSetup();
			if (!result.ok) setActionFeedback({ type: "error", message: result.error });
		} catch (error) {
			setActionFeedback({ type: "error", message: errorMessage(error) });
		} finally {
			setSetupCancelAction(false);
		}
	};

	const restartWorkerComfy = async (): Promise<void> => {
		setComfyRestartAction(true);
		setComfyRestartError(null);
		try {
			const result = await window.kastard.workerSession.restartComfy();
			if (!result.ok) setComfyRestartError(result.error);
		} catch (error) {
			setComfyRestartError(errorMessage(error));
		} finally {
			setComfyRestartAction(false);
		}
	};

	const syncCustomNodes = async (): Promise<void> => {
		setSyncAction(true);
		setSyncError(null);
		try {
			const result = await window.kastard.workerSession.syncCustomNodes();
			if (!result.ok) setSyncError(result.error);
		} catch (error) {
			setSyncError(errorMessage(error));
		} finally {
			setSyncAction(false);
		}
	};

	const reinstallCustomNode = async (id: string): Promise<void> => {
		setPreparingReinstallNodeId(id);
		setSyncError(null);
		try {
			const result = await window.kastard.workerSession.reinstallCustomNode({ id });
			if (!result.ok) setSyncError(result.error);
		} catch (error) {
			setSyncError(errorMessage(error));
		} finally {
			setPreparingReinstallNodeId(null);
		}
	};

	const removeCustomNode = async (node: CustomNodeInventoryEntry): Promise<void> => {
		setPreparingRemovalNodeName(node.name);
		setSyncError(null);
		try {
			const result = await window.kastard.workerSession.removeCustomNode({ node });
			if (!result.ok) setSyncError(result.error);
		} catch (error) {
			setSyncError(errorMessage(error));
		} finally {
			setPreparingRemovalNodeName(null);
		}
	};

	const syncModels = async (): Promise<void> => {
		setModelSyncAction(true);
		setModelSyncError(null);
		try {
			const result = await window.kastard.workerSession.syncModels();
			if (!result.ok) setModelSyncError(result.error);
		} catch (error) {
			setModelSyncError(errorMessage(error));
		} finally {
			setModelSyncAction(false);
		}
	};

	const redownloadModel = async (path: string): Promise<void> => {
		setPreparingRedownloadPath(path);
		setModelSyncError(null);
		try {
			const result = await window.kastard.workerSession.redownloadModel({ path });
			if (!result.ok) setModelSyncError(result.error);
		} catch (error) {
			setModelSyncError(errorMessage(error));
		} finally {
			setPreparingRedownloadPath(null);
		}
	};

	const cancelCustomNodes = async (): Promise<void> => {
		setSyncCancelAction(true);
		setSyncError(null);
		try {
			const result = await window.kastard.workerSession.cancelCustomNodes();
			if (!result.ok) setSyncError(result.error);
		} catch (error) {
			setSyncError(errorMessage(error));
		} finally {
			setSyncCancelAction(false);
		}
	};

	const cancelModels = async (): Promise<void> => {
		setModelSyncCancelAction(true);
		setModelSyncError(null);
		try {
			const result = await window.kastard.workerSession.cancelModels();
			if (!result.ok) setModelSyncError(result.error);
		} catch (error) {
			setModelSyncError(errorMessage(error));
		} finally {
			setModelSyncCancelAction(false);
		}
	};

	const verifySynchronization = async (): Promise<void> => {
		setVerificationAction(true);
		setVerificationError(null);
		try {
			const result = await window.kastard.workerSession.verify();
			if (!result.ok) setVerificationError(result.error);
		} catch (error) {
			setVerificationError(errorMessage(error));
		} finally {
			setVerificationAction(false);
		}
	};

	const updateConnectionSettings = (
		nextSettings: ConnectionSettingsValue,
		errorTarget: "syncAfterConnect" | "systemMetrics",
	): Promise<boolean> => {
		const previousValue = { syncAfterConnect, systemMetricsEnabled };
		setSyncAfterConnect(nextSettings.syncAfterConnect);
		setSystemMetricsEnabled(nextSettings.systemMetricsEnabled);
		if (errorTarget === "syncAfterConnect") setSettingsError(null);
		else setSystemMetricsError(null);
		const update = enqueueSettings({
			key: "settings",
			previousValue,
			formatError: errorMessage,
			save: async () => {
				const result = await window.kastard.connection.updateSettings(nextSettings);
				return result.ok
					? {
							ok: true,
							value: result.settings,
							data: undefined,
						}
					: result;
			},
			onSuccess: (_data, { confirmed, latest }) => {
				confirmedSettingsRef.current = confirmed;
				if (latest) {
					setSyncAfterConnect(confirmed.syncAfterConnect);
					setSystemMetricsEnabled(confirmed.systemMetricsEnabled);
					setSettingsError(null);
					setSystemMetricsError(null);
				}
			},
			onError: (error, { confirmed, latest }) => {
				if (!latest) return;
				setSyncAfterConnect(confirmed.syncAfterConnect);
				setSystemMetricsEnabled(confirmed.systemMetricsEnabled);
				if (errorTarget === "syncAfterConnect") setSettingsError(error);
				else setSystemMetricsError(error);
			},
		});
		settingsUpdateTailRef.current = update;
		return update;
	};

	const updateSyncAfterConnect = (value: boolean): Promise<boolean> =>
		updateConnectionSettings(
			{ syncAfterConnect: value, systemMetricsEnabled },
			"syncAfterConnect",
		);

	const updateSystemMetricsEnabled = (value: boolean): Promise<boolean> =>
		updateConnectionSettings(
			{ syncAfterConnect, systemMetricsEnabled: value },
			"systemMetrics",
		);

	const controller: ConnectionController = {
		state,
		workflow,
		systemMetrics,
		syncAfterConnect,
		systemMetricsEnabled,
		settingsLoading,
		settingsError,
		systemMetricsError,
		setupState,
		backendState,
		backendAction,
		backendError,
		workerComfyState,
		comfyRestartAction,
		comfyRestartError,
		syncState,
		syncAction,
		preparingReinstallNodeId,
		preparingRemovalNodeName,
		syncCancelAction,
		syncError,
		modelSyncState,
		modelSyncAction,
		preparingRedownloadPath,
		modelSyncCancelAction,
		modelSyncError,
		modelSyncRate,
		verification,
		verificationAction,
		verificationError,
		connectionAction,
		setupCancelAction,
		actionFeedback,
		showDialog,
		retryInitialization,
		retry,
		disconnect,
		prepareBackend,
		startWorkerSetup,
		cancelWorkerSetup,
		restartWorkerComfy,
		syncCustomNodes,
		requestCustomNodeReinstall: setReinstallConfirmationId,
		requestCustomNodeRemoval: setRemovalConfirmationNode,
		cancelCustomNodes,
		syncModels,
		requestModelRedownload: setRedownloadConfirmationPath,
		cancelModels,
		verifySynchronization,
		viewLogs: () => setLogsOpen(true),
		resetActionFeedback: () => setActionFeedback(null),
		updateSyncAfterConnect,
		updateSystemMetricsEnabled,
	};

	const redownloadConfirmationTarget =
		("targetModels" in modelSyncState &&
		"targetStatus" in modelSyncState &&
		modelSyncState.targetStatus === "current"
			? modelSyncState.targetModels?.find(
					(model) => model.target.path === redownloadConfirmationPath,
				)?.target
			: undefined) ?? null;

	return (
		<ConnectionContext.Provider value={controller}>
			{children}
			<CustomNodeReinstallDialog
				nodeId={reinstallConfirmationId}
				onOpenChange={(open) => {
					if (!open) setReinstallConfirmationId(null);
				}}
				onConfirm={(nodeId) => {
					setReinstallConfirmationId(null);
					void reinstallCustomNode(nodeId);
				}}
			/>
			<CustomNodeRemovalDialog
				node={removalConfirmationNode}
				onOpenChange={(open) => {
					if (!open) setRemovalConfirmationNode(null);
				}}
				onConfirm={(node) => {
					setRemovalConfirmationNode(null);
					void removeCustomNode(node);
				}}
			/>
			<ModelRedownloadDialog
				target={redownloadConfirmationTarget}
				onOpenChange={(open) => {
					if (!open) setRedownloadConfirmationPath(null);
				}}
				onConfirm={(path) => {
					setRedownloadConfirmationPath(null);
					void redownloadModel(path);
				}}
			/>
			<ServerLogsDialog open={logsOpen} onOpenChange={setLogsOpen} />
			{open ? (
				<ConnectWorkerDialog
					initialProvider={
						state.status === "disconnected"
							? state.recentProvider
							: state.status === "error"
								? null
								: state.provider
					}
					initialServerUrl={
						state.status === "disconnected"
							? state.recentServerUrl
							: state.status === "error"
								? null
								: state.serverUrl
					}
					initialSyncAfterConnect={connectSyncAfterConnect}
					defaultServerUrl={DEFAULT_SERVER_URL}
					settingsLoading={settingsLoading}
					onConnect={async (request) => {
						await settingsUpdateTailRef.current;
						return window.kastard.workerSession.connect(request);
					}}
					onConnected={(nextSyncAfterConnect) => {
						const confirmed = {
							...confirmedSettingsRef.current,
							syncAfterConnect: nextSyncAfterConnect,
						};
						confirmedSettingsRef.current = confirmed;
						confirmSettings("settings", confirmed);
						setSyncAfterConnect(nextSyncAfterConnect);
					}}
					onOpenChange={setOpen}
				/>
			) : null}
		</ConnectionContext.Provider>
	);
}

function useConnectionController(): ConnectionController {
	const controller = useContext(ConnectionContext);
	if (controller === null) {
		throw new Error("Connection controls must be rendered inside ConnectionProvider.");
	}
	return controller;
}

export function useConnectionSettings(): Pick<
	ConnectionController,
	| "syncAfterConnect"
	| "systemMetricsEnabled"
	| "settingsLoading"
	| "settingsError"
	| "systemMetricsError"
	| "updateSyncAfterConnect"
	| "updateSystemMetricsEnabled"
> {
	const controller = useConnectionController();
	return {
		syncAfterConnect: controller.syncAfterConnect,
		systemMetricsEnabled: controller.systemMetricsEnabled,
		settingsLoading: controller.settingsLoading,
		settingsError: controller.settingsError,
		systemMetricsError: controller.systemMetricsError,
		updateSyncAfterConnect: controller.updateSyncAfterConnect,
		updateSystemMetricsEnabled: controller.updateSystemMetricsEnabled,
	};
}

export function useWorkerCustomNodeSyncState(): WorkerCustomNodeSyncState {
	return useConnectionController().syncState;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isSynchronizationProgressActive(controller: ConnectionController): boolean {
	return (
		controller.setupState.status === "running" ||
		controller.backendAction ||
		controller.backendState.status === "loading" ||
		controller.backendState.status === "preparing" ||
		controller.syncAction ||
		controller.syncCancelAction ||
		controller.syncState.status === "loading" ||
		controller.syncState.status === "syncing" ||
		controller.syncState.status === "canceling" ||
		controller.modelSyncAction ||
		controller.preparingRedownloadPath !== null ||
		controller.modelSyncCancelAction ||
		controller.modelSyncState.status === "loading" ||
		controller.modelSyncState.status === "checking" ||
		controller.modelSyncState.status === "syncing" ||
		controller.modelSyncState.status === "canceling" ||
		controller.verificationAction ||
		controller.verification?.status === "syncing"
	);
}

function isSynchronizationBusy(controller: ConnectionController): boolean {
	return controller.comfyRestartAction || isSynchronizationProgressActive(controller);
}

function canStartWorkerSetup(controller: ConnectionController): boolean {
	const state = controller.workerComfyState;
	return (
		!isSynchronizationBusy(controller) &&
		(state.status === "ready" ||
			state.status === "stopped" ||
			state.status === "failed" ||
			(state.status === "unavailable" && state.retryable !== true))
	);
}

function canRestartWorkerComfy(controller: ConnectionController): boolean {
	const state = controller.workerComfyState;
	return (
		controller.state.status === "connected" &&
		controller.workflow === null &&
		controller.backendState.status === "ready" &&
		!isSynchronizationBusy(controller) &&
		state.status !== "disconnected" &&
		state.status !== "loading" &&
		state.status !== "starting" &&
		state.status !== "unavailable"
	);
}

function setupSynchronizationActive(controller: ConnectionController): boolean {
	return (
		controller.setupState.status === "running" &&
		controller.setupState.phase === "preparation" &&
		(controller.syncState.status === "loading" ||
			controller.syncState.status === "syncing" ||
			controller.modelSyncState.status === "loading" ||
			controller.modelSyncState.status === "checking" ||
			controller.modelSyncState.status === "syncing")
	);
}

function setupSynchronizationCanceling(controller: ConnectionController): boolean {
	if (controller.setupCancelAction) return true;
	if (
		controller.setupState.status !== "running" &&
		controller.setupState.status !== "canceled"
	) {
		return false;
	}

	return (
		controller.syncCancelAction ||
		controller.modelSyncCancelAction ||
		controller.syncState.status === "canceling" ||
		controller.modelSyncState.status === "canceling"
	);
}

function backendMatchesEditorComfy(controller: ConnectionController): boolean {
	return (
		controller.backendState.status === "ready" &&
		controller.backendState.version === controller.backendState.editorComfyVersion
	);
}

function collectionVerificationProgress(
	verification: CollectionVerification | undefined,
): Pick<SyncAreaSummary, "completed" | "total"> | null {
	if (verification?.status === "synced") {
		return { completed: verification.total, total: verification.total };
	}
	if (verification?.status !== "out-of-sync") return null;
	const problemTargets = new Set(
		verification.problems
			.filter((problem) => problem.expected !== null)
			.map((problem) => problem.name),
	);
	return {
		completed: Math.max(verification.total - problemTargets.size, 0),
		total: verification.total,
	};
}

function syncAreaSummaries(controller: ConnectionController): SyncAreaSummary[] {
	const setupPhase =
		controller.setupState.status === "running" ? controller.setupState.phase : null;
	const verificationRunning =
		controller.verificationAction ||
		setupPhase === "verification" ||
		controller.verification?.status === "syncing";
	const backendVerification = controller.verification?.backend;
	const backendPrepared =
		backendVerification === undefined
			? backendMatchesEditorComfy(controller)
			: backendVerification.status === "synced";
	const backendSyncing =
		verificationRunning ||
		controller.backendAction ||
		controller.backendState.status === "loading" ||
		controller.backendState.status === "preparing";
	const backendError =
		controller.backendError !== null ||
		controller.backendState.status === "failed" ||
		controller.backendState.status === "unavailable" ||
		backendVerification?.status === "out-of-sync" ||
		backendVerification?.status === "unavailable";
	const workerComfyReady =
		backendPrepared &&
		controller.workerComfyState.status === "ready" &&
		controller.comfyRestartAction === false &&
		setupPhase !== "comfy";
	const workerComfySyncing =
		backendPrepared &&
		(controller.comfyRestartAction ||
			setupPhase === "comfy" ||
			controller.workerComfyState.status === "loading" ||
			controller.workerComfyState.status === "starting");
	const workerComfyError =
		backendPrepared &&
		(controller.workerComfyState.status === "failed" ||
			controller.workerComfyState.status === "unavailable");
	const workerComfyWarning =
		workerComfyReady && workerComfyWarnings(controller.workerComfyState).length > 0;
	const synchronizationProblemStatus =
		controller.workerComfyState.status === "ready" ? "warning" : "error";

	const nodesVerification = controller.verification?.customNodes;
	const targetNodes =
		"targetNodes" in controller.syncState
			? controller.syncState.targetNodes
			: undefined;
	const currentTargetNodes =
		targetNodes !== undefined &&
		"targetStatus" in controller.syncState &&
		controller.syncState.targetStatus === "current"
			? targetNodes
			: null;
	const verifiedTargetNodes =
		currentTargetNodes === null
			? null
			: verifiedCustomNodeTargets(currentTargetNodes, nodesVerification);
	const unsupportedNodeCount =
		"unsupportedNodes" in controller.syncState
			? controller.syncState.unsupportedNodes.length
			: 0;
	const verifiedNodesProgress =
		currentTargetNodes === null
			? collectionVerificationProgress(nodesVerification)
			: verifiedTargetNodes === null
				? null
				: {
						completed: verifiedTargetNodes.filter((node) => node.status === "installed")
							.length,
						total: verifiedTargetNodes.length,
					};
	const nodesVerificationProgress =
		verifiedNodesProgress === null
			? null
			: {
					completed: verifiedNodesProgress.completed,
					total:
						verifiedNodesProgress.total +
						(currentTargetNodes === null ? 0 : unsupportedNodeCount),
				};
	let nodesProgress =
		nodesVerificationProgress !== null
			? nodesVerificationProgress
			: targetNodes === undefined
				? { completed: 0, total: 0 }
				: {
						completed: targetNodes.filter((node) => node.status === "installed").length,
						total: targetNodes.length + unsupportedNodeCount,
					};
	if (targetNodes === undefined && nodesVerificationProgress === null) {
		if (controller.syncState.status === "syncing") {
			nodesProgress = {
				completed: controller.syncState.current,
				total:
					controller.syncState.total + controller.syncState.unsupportedNodes.length,
			};
		} else if (controller.syncState.status === "ready") {
			nodesProgress = {
				completed: controller.syncState.nodes.length,
				total:
					controller.syncState.nodes.length +
					controller.syncState.unsupportedNodes.length,
			};
		}
	}
	const nodesSyncing =
		verificationRunning ||
		controller.syncAction ||
		controller.preparingReinstallNodeId !== null ||
		controller.syncCancelAction ||
		controller.syncState.status === "loading" ||
		controller.syncState.status === "syncing" ||
		controller.syncState.status === "canceling" ||
		nodesVerification?.status === "syncing";
	const nodesError =
		controller.syncError !== null ||
		controller.syncState.status === "failed" ||
		controller.syncState.status === "canceled" ||
		controller.syncState.status === "unavailable" ||
		("unsupportedNodes" in controller.syncState &&
			controller.syncState.unsupportedNodes.length > 0) ||
		nodesVerification?.status === "out-of-sync" ||
		nodesVerification?.status === "unavailable";
	const nodesSynced =
		nodesVerification?.status === "synced" ||
		(controller.syncState.status === "ready" &&
			controller.syncState.unsupportedNodes.length === 0);

	const modelsVerification = controller.verification?.models;
	const modelsVerificationProgress = collectionVerificationProgress(modelsVerification);
	let modelsProgress = modelsVerificationProgress ?? { completed: 0, total: 0 };
	if (modelsVerificationProgress === null) {
		const targetModels =
			"targetModels" in controller.modelSyncState &&
			controller.modelSyncState.targetStatus === "current"
				? controller.modelSyncState.targetModels
				: undefined;
		if (targetModels !== undefined) {
			modelsProgress = {
				completed: targetModels.filter((model) => model.status === "ready").length,
				total: targetModels.length,
			};
		} else if (controller.modelSyncState.status === "checking") {
			modelsProgress = { completed: 0, total: controller.modelSyncState.total };
		} else if (controller.modelSyncState.status === "syncing") {
			modelsProgress = {
				completed: controller.modelSyncState.completed,
				total: controller.modelSyncState.total,
			};
		} else if (controller.modelSyncState.status === "synced") {
			modelsProgress = {
				completed: controller.modelSyncState.models.length,
				total: controller.modelSyncState.models.length,
			};
		} else if (
			controller.modelSyncState.status === "failed" &&
			controller.modelSyncState.total !== undefined
		) {
			modelsProgress = {
				completed: controller.modelSyncState.models.length,
				total: controller.modelSyncState.total,
			};
		}
	}
	const modelsSyncing =
		verificationRunning ||
		controller.modelSyncAction ||
		controller.preparingRedownloadPath !== null ||
		controller.modelSyncCancelAction ||
		controller.modelSyncState.status === "loading" ||
		controller.modelSyncState.status === "checking" ||
		controller.modelSyncState.status === "syncing" ||
		controller.modelSyncState.status === "canceling" ||
		modelsVerification?.status === "syncing";
	const modelsError =
		controller.modelSyncError !== null ||
		controller.modelSyncState.status === "failed" ||
		controller.modelSyncState.status === "canceled" ||
		controller.modelSyncState.status === "unavailable" ||
		modelsVerification?.status === "out-of-sync" ||
		modelsVerification?.status === "unavailable";
	const projectedModelsSynced =
		"targetModels" in controller.modelSyncState &&
		controller.modelSyncState.targetStatus === "current" &&
		controller.modelSyncState.targetModels !== undefined &&
		controller.modelSyncState.targetModels.length > 0 &&
		controller.modelSyncState.targetModels.every((model) => model.status === "ready");
	const modelsSynced =
		modelsVerification?.status === "synced" ||
		projectedModelsSynced ||
		(controller.modelSyncState.status === "synced" &&
			(!("operationKind" in controller.modelSyncState) ||
				controller.modelSyncState.operationKind !== "redownload"));

	return [
		{
			id: "backend",
			label: "Backend",
			fullLabel: "ComfyUI Backend",
			shortLabel: "B",
			status:
				backendSyncing || workerComfySyncing
					? "syncing"
					: backendError || workerComfyError
						? "error"
						: workerComfyWarning
							? "warning"
							: workerComfyReady
								? "synced"
								: "pending",
			completed: backendPrepared ? (workerComfyReady ? 2 : 1) : 0,
			total: 2,
		},
		{
			id: "nodes",
			label: "Nodes",
			fullLabel: "Custom Nodes",
			shortLabel: "N",
			status: nodesSyncing
				? "syncing"
				: nodesError
					? synchronizationProblemStatus
					: nodesSynced
						? "synced"
						: "pending",
			...nodesProgress,
		},
		{
			id: "models",
			label: "Models",
			fullLabel: "Models",
			shortLabel: "M",
			status: modelsSyncing
				? "syncing"
				: modelsError
					? synchronizationProblemStatus
					: modelsSynced
						? "synced"
						: "pending",
			...modelsProgress,
		},
	];
}

const SYNC_STATUS_LABELS: Record<SyncAreaStatus, string> = {
	pending: "Pending",
	syncing: "Syncing",
	synced: "Synced",
	warning: "Needs attention",
	error: "Needs attention",
};

function SyncAreaStatusIcon({ status }: { status: SyncAreaStatus }): React.JSX.Element {
	const Icon =
		status === "synced"
			? CheckIcon
			: status === "warning" || status === "error"
				? CircleAlertIcon
				: status === "syncing"
					? LoaderCircleIcon
					: CircleIcon;
	return (
		<span
			className={cn(
				"inline-flex size-4 shrink-0 items-center justify-center",
				status === "synced" && "text-emerald-500",
				status === "warning" && "text-warning",
				status === "error" && "text-destructive",
				status === "pending" && "text-sidebar-foreground/45",
			)}
			aria-hidden="true"
		>
			<Icon
				className={cn(
					"size-full origin-center",
					status === "syncing" && "animate-spin",
				)}
			/>
		</span>
	);
}

function SyncAreaPopoverStatus({
	area,
	controller,
}: {
	area: SyncAreaId;
	controller: ConnectionController;
}): React.JSX.Element {
	const setupBlocksIndividualSynchronization =
		controller.setupCancelAction ||
		(controller.setupState.status === "running" &&
			controller.setupState.phase !== "preparation");
	const workerComfyBlocksSynchronization =
		controller.workerComfyState.status === "loading" ||
		controller.workerComfyState.status === "starting";

	if (area === "backend") {
		return <ComfyBackendStatus controller={controller} />;
	}

	if (area === "nodes") {
		return (
			<WorkerCustomNodeSyncStatus
				state={controller.syncState}
				verification={controller.verification?.customNodes}
				backendState={controller.backendState}
				starting={controller.syncAction}
				preparingReinstallNodeId={controller.preparingReinstallNodeId}
				preparingRemovalNodeName={controller.preparingRemovalNodeName}
				canceling={controller.syncCancelAction}
				error={controller.syncError}
				disabled={
					setupBlocksIndividualSynchronization || workerComfyBlocksSynchronization
				}
				onSync={() => void controller.syncCustomNodes()}
				onReinstall={controller.requestCustomNodeReinstall}
				onRemove={controller.requestCustomNodeRemoval}
				onCancel={() => void controller.cancelCustomNodes()}
			/>
		);
	}

	return (
		<WorkerModelSyncStatus
			state={controller.modelSyncState}
			verification={controller.verification?.models}
			rate={controller.modelSyncRate}
			starting={controller.modelSyncAction}
			preparingRedownloadPath={controller.preparingRedownloadPath}
			canceling={controller.modelSyncCancelAction}
			error={controller.modelSyncError}
			disabled={
				setupBlocksIndividualSynchronization || workerComfyBlocksSynchronization
			}
			onSync={() => void controller.syncModels()}
			onRedownload={controller.requestModelRedownload}
			onCancel={() => void controller.cancelModels()}
		/>
	);
}

function SyncAreaItem({
	area,
	controller,
	open,
	onOpenChange,
}: {
	area: SyncAreaSummary;
	controller: ConnectionController;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
	const trigger = useRef<HTMLButtonElement>(null);
	return (
		<li
			aria-label={`${area.label}: ${SYNC_STATUS_LABELS[area.status]}, ${area.completed}/${area.total}`}
		>
			<Popover
				open={open}
				onOpenChange={(nextOpen) => {
					if (nextOpen) trigger.current?.focus({ preventScroll: true });
					onOpenChange(nextOpen);
				}}
			>
				<Tooltip
					trigger={
						<PopoverTrigger asChild>
							<Button
								ref={trigger}
								type="button"
								variant="secondary"
								size="sm"
								aria-label={`Open ${area.label} status`}
								className={cn(
									"shrink-0 bg-sidebar-accent text-sidebar-accent-foreground shadow-none hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
									open && "ring-1 ring-inset ring-sidebar-ring/50",
								)}
							>
								<SyncAreaStatusIcon status={area.status} />
								<span className="text-sidebar-foreground/55">{area.shortLabel}</span>
								<span className="text-sidebar-foreground/55 tabular-nums">
									{area.completed}/{area.total}
								</span>
							</Button>
						</PopoverTrigger>
					}
				>
					{area.fullLabel}
				</Tooltip>
				<PopoverContent
					data-connection-control
					align="start"
					side="bottom"
					sideOffset={12}
					aria-label={`${area.label} status`}
					className="max-h-[min(32rem,calc(100vh-4rem))] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto p-0 select-text cursor-text"
					onInteractOutside={(event) => {
						const target = event.detail.originalEvent.target;
						if (
							target instanceof Element &&
							(target.closest("[data-worker-sync-action-menu]") !== null ||
								(area.id === "nodes" &&
									target.closest(
										"[data-custom-node-reinstall-dialog], [data-custom-node-removal-dialog]",
									) !== null) ||
								(area.id === "models" &&
									target.closest("[data-model-redownload-dialog]") !== null))
						) {
							event.preventDefault();
						}
					}}
				>
					<SyncAreaPopoverStatus area={area.id} controller={controller} />
				</PopoverContent>
			</Popover>
		</li>
	);
}

export function ConnectionServerStatus(): React.JSX.Element | null {
	const controller = useConnectionController();

	return controller.state.status === "connected" && controller.systemMetricsEnabled ? (
		<ServerStatus
			status={
				controller.systemMetrics.status === "available"
					? controller.systemMetrics.metrics
					: undefined
			}
		/>
	) : null;
}

function ConnectionElapsedTime({
	connectedAt,
}: {
	connectedAt: number;
}): React.JSX.Element {
	const [now, setNow] = useState(Date.now);
	const totalMinutes = Math.floor(
		Math.max(0, now - connectedAt) / CONNECTION_MINUTE_MS,
	);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	useEffect(() => {
		const elapsed = Math.max(0, now - connectedAt);
		const timeout = window.setTimeout(
			() => setNow(Date.now()),
			CONNECTION_MINUTE_MS - (elapsed % CONNECTION_MINUTE_MS),
		);
		return () => window.clearTimeout(timeout);
	}, [connectedAt, now]);

	return (
		<>
			<span className="tabular-nums text-sidebar-foreground/60" aria-hidden="true">
				{hours}h {minutes}m
			</span>
			<span className="sr-only">
				for {hours} {hours === 1 ? "hour" : "hours"} {minutes}{" "}
				{minutes === 1 ? "minute" : "minutes"}
			</span>
		</>
	);
}

export function ConnectionControl({
	openPopovers,
	onPopoverOpenChange,
	closeRequest,
}: {
	openPopovers: ReadonlySet<ConnectionPopoverId>;
	onPopoverOpenChange: (popover: ConnectionPopoverId, open: boolean) => void;
	closeRequest: number;
}): React.JSX.Element {
	const controller = useConnectionController();
	const closePopovers = useEffectEvent((keepDetails = false) => {
		for (const popover of openPopovers) {
			if (!keepDetails || popover !== "details") {
				onPopoverOpenChange(popover, false);
			}
		}
	});
	const detailsOpen = openPopovers.has("details");

	useEffect(() => {
		if (closeRequest !== 0) closePopovers();
	}, [closeRequest]);

	useEffect(() => {
		if (controller.state.status === "connected") return;
		if (controller.state.status === "offline" || controller.state.status === "error") {
			closePopovers(true);
			return;
		}
		closePopovers();
	}, [controller.state.status]);

	if (controller.state.status === "disconnected") {
		return (
			<div className="flex min-w-0 shrink-0 items-center gap-2">
				<Button type="button" size="sm" onClick={controller.showDialog}>
					<PlugIcon aria-hidden="true" />
					Connect
				</Button>
				{controller.workflow === null ? null : (
					<CompactWorkflowStatus workflow={controller.workflow} />
				)}
			</div>
		);
	}
	if (
		controller.state.status === "connected" ||
		controller.state.status === "offline"
	) {
		const offline = controller.state.status === "offline";
		const connectedAt =
			controller.state.status === "connected" ? controller.state.connectedAt : null;
		const syncAreas = syncAreaSummaries(controller);
		return (
			<div className="flex min-w-0 items-center gap-1.5">
				<Popover
					open={detailsOpen}
					onOpenChange={(open) => {
						if (open) controller.resetActionFeedback();
						onPopoverOpenChange("details", open);
					}}
				>
					<PopoverTrigger asChild>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className={cn(
								"shrink-0 bg-sidebar-accent text-sidebar-accent-foreground shadow-none hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
								detailsOpen && "ring-1 ring-inset ring-sidebar-ring/50",
							)}
						>
							<span
								className={cn(
									"size-2 rounded-full",
									offline ? "bg-red-400" : "bg-emerald-400",
								)}
								aria-hidden="true"
							/>
							<span>{offline ? "Offline" : "Connected"}</span>
							{connectedAt === null ? null : (
								<ConnectionElapsedTime connectedAt={connectedAt} />
							)}
						</Button>
					</PopoverTrigger>
					<PopoverContent
						data-connection-control
						align="start"
						side="bottom"
						sideOffset={12}
						aria-label="Connection details"
						className="max-h-[min(38rem,calc(100vh-4rem))] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto p-0"
					>
						<ConnectionDetails
							controller={controller}
							onReconnect={() => {
								onPopoverOpenChange("details", false);
								controller.showDialog();
							}}
						/>
					</PopoverContent>
				</Popover>
				{!offline ? (
					<TooltipProvider delayDuration={150}>
						<ul
							className="flex min-w-0 items-center gap-1.5 overflow-hidden"
							aria-label="Synchronization areas"
						>
							{syncAreas.map((area) => (
								<SyncAreaItem
									key={area.id}
									area={area}
									controller={controller}
									open={openPopovers.has(area.id)}
									onOpenChange={(open) => onPopoverOpenChange(area.id, open)}
								/>
							))}
						</ul>
					</TooltipProvider>
				) : null}
			</div>
		);
	}

	if (controller.state.status === "error") {
		return (
			<Popover
				open={detailsOpen}
				onOpenChange={(open) => onPopoverOpenChange("details", open)}
			>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="secondary"
						size="xs"
						className="bg-sidebar-accent text-sidebar-accent-foreground shadow-none hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
					>
						<span className="size-2 rounded-full bg-red-400" aria-hidden="true" />
						<span>Connection error</span>
					</Button>
				</PopoverTrigger>
				<PopoverContent data-connection-control align="start" className="w-80">
					<div className="grid gap-4">
						<div>
							<p className="text-sm font-medium">Connection error</p>
							<p className="mt-1 text-sm text-destructive" role="alert">
								{controller.actionFeedback?.type === "error"
									? controller.actionFeedback.message
									: controller.state.message}
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void controller.retryInitialization()}
							disabled={controller.connectionAction === "initialize"}
						>
							{controller.connectionAction === "initialize" ? (
								<LoaderCircleIcon className="animate-spin" />
							) : (
								<RefreshCwIcon />
							)}
							{controller.connectionAction === "initialize" ? "Retrying…" : "Retry"}
						</Button>
					</div>
				</PopoverContent>
			</Popover>
		);
	}
	return (
		<div className="flex h-7 items-center gap-1.5 px-2.5 text-xs" role="status">
			<span className="size-2 rounded-full bg-amber-400" aria-hidden="true" />
			<span>Connecting…</span>
		</div>
	);
}

function ConnectionDetails({
	controller,
	onReconnect,
}: {
	controller: ConnectionController;
	onReconnect: () => void;
}): React.JSX.Element | null {
	const { state } = controller;
	if (state.status !== "connected" && state.status !== "offline") return null;

	const offline = state.status === "offline";

	return (
		<div data-testid="connection-popover" className="select-text cursor-text">
			{offline ? null : <WorkerSynchronizationStatus controller={controller} />}

			<ServerConnectionDetails
				controller={controller}
				state={state}
				onReconnect={onReconnect}
			/>
		</div>
	);
}

function ServerConnectionDetails({
	controller,
	state,
	onReconnect,
}: {
	controller: ConnectionController;
	state: Extract<ConnectionState, { status: "connected" | "offline" }>;
	onReconnect: () => void;
}): React.JSX.Element {
	const offline = state.status === "offline";

	return (
		<div className={cn("grid gap-3 p-5", !offline && "border-t")}>
			{controller.actionFeedback ? (
				<p
					className={cn(
						"text-xs",
						controller.actionFeedback.type === "success"
							? "text-success"
							: "text-destructive",
					)}
					role={controller.actionFeedback.type === "success" ? "status" : "alert"}
				>
					{controller.actionFeedback.message}
				</p>
			) : state.status === "offline" ? (
				<p className="text-xs text-destructive" role="alert">
					{state.message}
				</p>
			) : null}
			<div>
				<p className="text-xs text-muted-foreground">Worker address</p>
				<p className="mt-1 break-all font-mono text-sm">{state.serverUrl}</p>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				{offline ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							if (state.reconnectRequired) onReconnect();
							else void controller.retry();
						}}
						disabled={controller.connectionAction !== null}
					>
						{!state.reconnectRequired && controller.connectionAction === "retry" ? (
							<LoaderCircleIcon className="animate-spin" />
						) : (
							<RefreshCwIcon />
						)}
						{state.reconnectRequired ? "Reconnect" : "Retry"}
					</Button>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={controller.viewLogs}
						disabled={controller.connectionAction !== null}
					>
						<FileTextIcon />
						View Worker logs
					</Button>
				)}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="text-destructive hover:bg-destructive/10 hover:text-destructive"
					onClick={() => void controller.disconnect()}
					disabled={controller.connectionAction !== null}
				>
					{controller.connectionAction === "disconnect" ? (
						<LoaderCircleIcon className="animate-spin" />
					) : (
						<UnplugIcon />
					)}
					Disconnect
				</Button>
			</div>
		</div>
	);
}

function CompactWorkflowStatus({
	workflow,
}: {
	workflow: WorkerWorkflowCurrentState;
}): React.JSX.Element {
	return (
		<div
			className="min-w-0 select-text text-xs text-muted-foreground cursor-text"
			role="status"
		>
			<p>{workflowStatusLabel(workflow)}</p>
			<p className="max-w-64 truncate font-mono" title={workflow.workerUrl}>
				{workflow.workerUrl}
			</p>
		</div>
	);
}

function workflowStatusLabel(workflow: WorkerWorkflowCurrentState): string {
	if (workflow.cancellation === "requested") return "Canceling…";
	if (workflow.cancellation === "unconfirmed") return "Cancellation unconfirmed";
	if (workflow.phase === "dispatching") return "Dispatching";
	if (workflow.phase === "reconciling") return "Checking Worker state";
	if (workflow.phase === "collecting") return "Collecting results";
	return "Running";
}

function WorkerSetupStartButton({
	running,
	resync,
	disabled,
	variant,
	className,
	onStart,
}: {
	running: boolean;
	resync: boolean;
	disabled: boolean;
	variant?: React.ComponentProps<typeof Button>["variant"];
	className?: string;
	onStart: () => void;
}): React.JSX.Element {
	return (
		<Button
			type="button"
			size="sm"
			variant={variant}
			className={className}
			onClick={onStart}
			disabled={disabled}
		>
			{running ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
			{running ? "Syncing…" : resync ? "Resync" : "Sync"}
		</Button>
	);
}

type ComfyBackendStatusContent = {
	message: string;
	detail: string | null;
	tone: "success" | "warning" | "muted" | "error";
};

function ComfyBackendStatus({
	controller,
}: {
	controller: ConnectionController;
}): React.JSX.Element {
	const state = controller.backendState;
	const comfyState = controller.workerComfyState;
	const comfyWarnings = workerComfyWarnings(comfyState);
	const runtime = "runtime" in state ? state.runtime : null;
	const backendMatches = backendMatchesEditorComfy(controller);
	const isRetry = state.status === "failed" && state.retryable;
	const canPrepare = state.status === "not-installed" || isRetry;
	const canRestart = canRestartWorkerComfy(controller);
	const setupStartingComfy =
		controller.setupState.status === "running" &&
		controller.setupState.phase === "comfy";
	const restartBusy =
		controller.comfyRestartAction ||
		comfyState.status === "starting" ||
		setupStartingComfy;
	const restartBlockedReason =
		controller.workflow === null
			? null
			: "Restart is unavailable while a workflow is active.";
	const restartBlockedReasonId = useId();
	const content = comfyBackendStatusContent(controller);
	const versionMismatch =
		state.status === "ready" && state.version !== state.editorComfyVersion;
	const showRequiredVersion =
		state.status !== "disconnected" &&
		state.status !== "loading" &&
		state.status !== "ready";
	const prepareLabel = controller.backendAction
		? isRetry
			? "Retrying…"
			: "Starting…"
		: isRetry
			? "Retry backend"
			: "Prepare backend";

	return (
		<section className="grid gap-4 p-5" aria-labelledby="comfy-backend-status-title">
			<header className="grid gap-2">
				<div className="flex items-start justify-between gap-4">
					<div className="grid gap-2">
						<h2 id="comfy-backend-status-title" className="text-sm font-medium">
							ComfyUI backend
						</h2>
						<p
							className={cn(
								"text-xs font-medium",
								content.tone === "success" && "text-success",
								content.tone === "warning" && "text-warning",
								content.tone === "muted" && "text-muted-foreground",
								content.tone === "error" && "text-destructive",
							)}
							role={content.tone === "error" ? "alert" : "status"}
						>
							{content.message}
						</p>
					</div>
					{canPrepare ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void controller.prepareBackend()}
							disabled={
								controller.setupState.status === "running" || controller.backendAction
							}
						>
							{controller.backendAction ? (
								<LoaderCircleIcon className="animate-spin" />
							) : isRetry ? (
								<RefreshCwIcon />
							) : (
								<DownloadIcon />
							)}
							{prepareLabel}
						</Button>
					) : backendMatches ? (
						<div className="grid justify-items-end gap-1">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void controller.restartWorkerComfy()}
								disabled={!canRestart}
								aria-describedby={
									restartBlockedReason === null ? undefined : restartBlockedReasonId
								}
								aria-label={
									restartBusy ? "Starting Worker ComfyUI" : "Restart Worker ComfyUI"
								}
							>
								{restartBusy ? (
									<LoaderCircleIcon className="animate-spin" />
								) : (
									<RefreshCwIcon />
								)}
								{restartBusy ? "Starting…" : "Restart"}
							</Button>
							{restartBlockedReason === null ? null : (
								<p
									id={restartBlockedReasonId}
									className="max-w-56 text-right text-xs text-muted-foreground"
								>
									{restartBlockedReason}
								</p>
							)}
						</div>
					) : null}
				</div>
				{versionMismatch && state.status === "ready" ? (
					<div className="grid gap-1 rounded-md bg-muted/55 px-3 py-2 font-mono text-[11px]">
						<p>Worker ComfyUI v{state.version}</p>
						<p className="text-warning">
							Kastard requires v{state.editorComfyVersion || "unknown"}
						</p>
					</div>
				) : state.status === "ready" ? (
					<p className="font-mono text-xs text-muted-foreground">
						ComfyUI v{state.version}
					</p>
				) : showRequiredVersion ? (
					<p className="font-mono text-xs text-muted-foreground">
						Required ComfyUI v{state.editorComfyVersion || "unknown"}
					</p>
				) : null}
			</header>
			{state.status === "preparing" ? (
				<div className="grid gap-1.5" role="status">
					<div className="flex justify-between text-xs text-muted-foreground">
						<span>
							{state.phaseElapsedMs === undefined
								? phaseLabel(state.phase)
								: `${formatDuration(state.phaseElapsedMs)}`}
							{state.totalElapsedMs === undefined
								? null
								: ` · ${formatDuration(state.totalElapsedMs)} total`}
						</span>
						<span>{state.progress}%</span>
					</div>
					<ProgressBar
						label="ComfyUI backend preparation"
						value={state.progress}
						showPercentage={false}
					/>
				</div>
			) : null}
			{content.detail === null ? null : (
				<p className="text-xs leading-relaxed text-muted-foreground">
					{content.detail}
				</p>
			)}
			{comfyWarnings.length === 0 ? null : (
				<div
					className="grid gap-1.5 text-xs text-warning select-text cursor-text"
					role="status"
				>
					<p>
						{comfyWarnings.length} custom node startup{" "}
						{comfyWarnings.length === 1 ? "warning" : "warnings"}
					</p>
					<ul
						className="grid max-h-32 gap-1 overflow-y-auto break-words font-mono text-[11px]"
						aria-label="Custom node startup warnings"
					>
						{comfyWarnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</div>
			)}
			{runtime === null ? null : (
				<p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
					{workerComputeLabel(runtime)} · Python {runtime.pythonVersion} · PyTorch{" "}
					{runtime.torchVersion}
				</p>
			)}
		</section>
	);
}

function comfyBackendStatusContent(
	controller: ConnectionController,
): ComfyBackendStatusContent {
	const backendState = controller.backendState;
	const comfyState = controller.workerComfyState;
	if (controller.backendError !== null) {
		return { message: controller.backendError, detail: null, tone: "error" };
	}
	if (backendState.status === "disconnected" || backendState.status === "loading") {
		return { message: "Loading Worker status…", detail: null, tone: "muted" };
	}
	if (controller.backendAction) {
		return { message: "Preparing ComfyUI…", detail: null, tone: "muted" };
	}
	if (backendState.status === "not-installed") {
		return { message: "Not installed on Worker", detail: null, tone: "muted" };
	}
	if (backendState.status === "preparing") {
		return { message: phaseLabel(backendState.phase), detail: null, tone: "muted" };
	}
	if (backendState.status === "failed" || backendState.status === "unavailable") {
		return { message: backendState.error, detail: null, tone: "error" };
	}
	if (backendState.version !== backendState.editorComfyVersion) {
		return {
			message: "Update required",
			detail: "Run Sync from Connected to install the required version.",
			tone: "warning",
		};
	}
	if (controller.comfyRestartError !== null) {
		return { message: controller.comfyRestartError, detail: null, tone: "error" };
	}
	if (
		controller.comfyRestartAction ||
		comfyState.status === "starting" ||
		(controller.setupState.status === "running" &&
			controller.setupState.phase === "comfy")
	) {
		return { message: "Starting Worker ComfyUI…", detail: null, tone: "muted" };
	}
	if (comfyState.status === "disconnected" || comfyState.status === "loading") {
		return { message: "Loading execution status…", detail: null, tone: "muted" };
	}
	if (comfyState.status === "stopped") {
		return { message: "Downloaded · Waiting to start", detail: null, tone: "muted" };
	}
	if (comfyState.status === "ready") {
		if (workerComfyWarnings(comfyState).length > 0) {
			return {
				message: "Running with custom node warnings",
				detail: null,
				tone: "success",
			};
		}
		return { message: "Running", detail: null, tone: "success" };
	}
	return {
		message: comfyState.error,
		detail:
			comfyState.status === "failed"
				? "Worker logs include ComfyUI output from this connection."
				: null,
		tone: "error",
	};
}

function workerComfyWarnings(state: WorkerComfyState): string[] {
	return state.status === "ready" ? (state.warnings ?? []) : [];
}

function WorkerSynchronizationStatus({
	controller,
}: {
	controller: ConnectionController;
}): React.JSX.Element {
	const problemsSummaryId = useId();
	const problemsListId = useId();
	const setupRunning = controller.setupState.status === "running";
	const synchronizationBusy = isSynchronizationBusy(controller);
	const synchronizationActive = setupSynchronizationActive(controller);
	const synchronizationCanceling = setupSynchronizationCanceling(controller);
	const checking =
		controller.verificationAction ||
		(controller.setupState.status === "running" &&
			controller.setupState.phase === "verification");
	const showStartSetup =
		!setupRunning &&
		!(
			controller.setupState.status === "idle" &&
			controller.setupState.pendingAutomaticStart === true
		);
	const problems = synchronizationProblems(controller);
	const problemsAreWarnings = controller.workerComfyState.status === "ready";
	const problemNoun = problemsAreWarnings ? "warning" : "problem";
	const problemsLabel = `Synchronization ${problemNoun}s`;
	const problemsSummary = `${problems.length} synchronization ${problemNoun}${
		problems.length === 1 ? "" : "s"
	}.`;
	const status = synchronizationStatusMessage(controller);
	const showProblems =
		problems.length > 0 && !isSynchronizationProgressActive(controller);

	return (
		<section className="grid gap-3 p-5">
			<div className="grid gap-2">
				<p className="text-sm font-medium">Synchronization status</p>
				{showProblems ? (
					<>
						<p
							key={`${problemsAreWarnings ? "warning" : "error"}:${problems.join("|")}`}
							id={problemsSummaryId}
							className="sr-only"
							role={problemsAreWarnings ? "status" : "alert"}
							aria-controls={problemsListId}
						>
							{problemsSummary}
						</p>
						<ul
							id={problemsListId}
							aria-label={problemsLabel}
							aria-describedby={problemsSummaryId}
							className={cn(
								"grid max-h-32 gap-1 overflow-y-auto break-words pr-1 text-xs font-medium",
								problemsAreWarnings ? "text-warning" : "text-destructive",
							)}
						>
							{problems.map((message) => (
								<li key={message}>{message}</li>
							))}
						</ul>
					</>
				) : (
					<p
						className={cn(
							"text-xs font-medium",
							controller.verification?.status === "synced" && !setupRunning
								? "text-success"
								: "text-muted-foreground",
						)}
						role="status"
					>
						{status}
					</p>
				)}
			</div>
			<div className="flex flex-wrap justify-start gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void controller.verifySynchronization()}
					disabled={synchronizationBusy}
				>
					{checking ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
					{checking ? "Checking…" : "Check sync status"}
				</Button>
				{synchronizationActive || synchronizationCanceling ? (
					<WorkerSyncCancelButton
						description="Worker synchronization"
						canceling={synchronizationCanceling}
						label="Cancel sync"
						onCancel={() => void controller.cancelWorkerSetup()}
					/>
				) : setupRunning ? (
					<Button type="button" variant="outline" size="sm" disabled>
						<LoaderCircleIcon className="animate-spin" />
						Resyncing…
					</Button>
				) : showStartSetup ? (
					<WorkerSetupStartButton
						running={false}
						resync={
							controller.setupState.status !== "idle" ||
							controller.workerComfyState.status === "ready"
						}
						disabled={!canStartWorkerSetup(controller)}
						variant="outline"
						onStart={() => void controller.startWorkerSetup()}
					/>
				) : null}
			</div>
		</section>
	);
}

function synchronizationStatusMessage(controller: ConnectionController): string {
	if (setupSynchronizationCanceling(controller)) {
		return "Canceling synchronization…";
	}
	if (controller.verificationAction) return "Checking synchronization status…";
	if (controller.setupState.status === "running") {
		return {
			preparation: "Synchronization in progress…",
			verification: "Checking synchronization status…",
			comfy: "Synchronization verified. Starting Worker ComfyUI…",
		}[controller.setupState.phase];
	}
	if (isSynchronizationProgressActive(controller)) {
		if (
			controller.syncCancelAction ||
			controller.modelSyncCancelAction ||
			controller.syncState.status === "canceling" ||
			controller.modelSyncState.status === "canceling"
		) {
			return "Canceling synchronization…";
		}
		if (
			controller.verificationAction ||
			controller.verification?.status === "syncing"
		) {
			return "Checking synchronization status…";
		}
		return "Synchronization in progress…";
	}
	if (controller.setupState.status === "canceled") {
		return "Synchronization was canceled.";
	}
	if (controller.verification !== null) {
		return verificationSummary(controller.verification.status);
	}
	return "Synchronization status has not been checked.";
}

function synchronizationProblems(controller: ConnectionController): string[] {
	const problems = new Set<string>();
	for (const error of [
		controller.verificationError,
		controller.backendError,
		controller.syncError,
		controller.modelSyncError,
	]) {
		if (error !== null) problems.add(error);
	}

	if (
		controller.backendState.status === "failed" ||
		controller.backendState.status === "unavailable"
	) {
		problems.add(controller.backendState.error);
	}
	if (
		controller.syncState.status === "failed" ||
		controller.syncState.status === "unavailable"
	) {
		problems.add(controller.syncState.error);
	}
	if (
		controller.modelSyncState.status === "failed" ||
		controller.modelSyncState.status === "unavailable"
	) {
		problems.add(controller.modelSyncState.error);
	}
	const verification = controller.verification;
	if (verification !== null) {
		const backendError = backendVerificationError(verification.backend);
		if (backendError !== null) problems.add(backendError);
		for (const collection of [verification.models, verification.customNodes]) {
			if (collection.status === "unavailable") problems.add(collection.error);
			if (collection.status === "out-of-sync") {
				for (const problem of collection.problems) {
					problems.add(verificationProblemLabel(problem));
				}
			}
		}
		if (verification.status === "out-of-sync" && problems.size === 0) {
			problems.add("Worker synchronization is out of date.");
		}
		if (verification.status === "unavailable" && problems.size === 0) {
			problems.add("The full synchronization state could not be verified.");
		}
	}

	if (controller.setupState.status === "failed") {
		problems.add(controller.setupState.error);
	}
	return [...problems];
}

function backendVerificationError(verification: BackendVerification): string | null {
	if (verification.status === "synced" || verification.status === "syncing")
		return null;
	if (verification.status === "unavailable") return verification.error;
	if (verification.reason === "not-installed")
		return "Backend is not installed on Worker.";
	if (verification.reason === "failed") {
		return verification.error ?? "Backend preparation failed.";
	}
	return `Expected backend v${verification.expectedVersion}, found v${verification.actualVersion}.`;
}

function verificationSummary(status: SyncVerification["status"]): string {
	return {
		synced: "Backend, models, and custom nodes are synchronized.",
		"out-of-sync": "Worker synchronization is out of date.",
		syncing: "Synchronization is still in progress.",
		unavailable: "The full synchronization state could not be verified.",
	}[status];
}

function verificationProblemLabel(problem: VerificationProblem): string {
	const reason = {
		missing: "Missing",
		conflict: "Conflict",
		stale: "Stale",
		unexpected: "Unexpected",
		unsupported: "Unsupported",
		"version-mismatch": "Version mismatch",
	}[problem.reason];
	const comparison =
		problem.expected === null && problem.actual === null
			? ""
			: ` · expected ${problem.expected ?? "none"}, found ${problem.actual ?? "none"}`;
	return `${reason}: ${problem.name}${comparison}`;
}

function phaseLabel(phase: "download" | "verify" | "extract" | "validate"): string {
	return {
		download: "Downloading",
		verify: "Verifying",
		extract: "Extracting",
		validate: "Validating",
	}[phase];
}

function formatDuration(durationMs: number): string {
	const seconds = Math.floor(durationMs / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}
