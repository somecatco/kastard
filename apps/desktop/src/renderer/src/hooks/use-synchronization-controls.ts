import { useBackendRequests } from "@/hooks/use-worker-backend-requests";
import { useModelsRequests } from "@/hooks/use-worker-models-requests";
import { useNodesRequests } from "@/hooks/use-worker-nodes-requests";
import { sameFields, useWorkerSessionSelector } from "@/hooks/use-worker-session";
import { useSetupRequests } from "@/hooks/use-worker-setup-requests";
import { canRestartWorkerComfy } from "@/lib/worker-synchronization";
export function useSynchronizationControls() {
	const session = useWorkerSessionSelector(
		(state) => ({
			state: state.connection,
			workflow: state.workflow ?? null,
			setupState: state.setup,
			backendState: state.backend,
			workerComfyState: state.comfy,
			syncState: state.customNodes,
			modelSyncState: state.models,
			verification: state.verification,
		}),
		sameFields,
	);
	const backend = useBackendRequests();
	const nodes = useNodesRequests();
	const models = useModelsRequests();
	const setup = useSetupRequests();
	return {
		state: {
			...session,
			backendAction: backend.backendAction,
			backendError: backend.backendError,
			comfyRestartAction: backend.comfyRestartAction,
			comfyRestartError: backend.comfyRestartError,
			syncAction: nodes.syncAction,
			syncCancelAction: nodes.syncCancelAction,
			syncError: nodes.syncError,
			preparingReinstallNodeId: nodes.preparingReinstallNodeId,
			preparingRemovalNodeName: nodes.preparingRemovalNodeName,
			modelSyncAction: models.modelSyncAction,
			modelSyncCancelAction: models.modelSyncCancelAction,
			modelSyncError: models.modelSyncError,
			preparingRedownloadPath: models.preparingRedownloadPath,
			verificationAction: setup.verificationAction,
			verificationError: setup.verificationError,
			setupCancelAction: setup.setupCancelAction,
			setupStartAction: setup.setupStartAction,
		},
		actions: {
			prepareBackend: backend.prepareBackend,
			restartWorkerComfy: backend.restartWorkerComfy,
			startWorkerSetup: setup.startWorkerSetup,
			cancelWorkerSetup: setup.cancelWorkerSetup,
			verifySynchronization: setup.verifySynchronization,
		},
	};
}

export function useBackendControls() {
	const backend = useBackendRequests();
	const nodes = useNodesRequests();
	const models = useModelsRequests();
	const setup = useSetupRequests();
	const state = useWorkerSessionSelector(
		(session) => ({
			backendState: session.backend,
			workerComfyState: session.comfy,
			setupState: session.setup,
			workflow: session.workflow ?? null,
			canRestart: canRestartWorkerComfy({
				setupStartAction: setup.setupStartAction,
				state: session.connection,
				workflow: session.workflow ?? null,
				backendState: session.backend,
				workerComfyState: session.comfy,
				setupState: session.setup,
				syncState: session.customNodes,
				modelSyncState: session.models,
				verification: session.verification,
				backendAction: backend.backendAction,
				comfyRestartAction: backend.comfyRestartAction,
				syncAction: nodes.syncAction,
				syncCancelAction: nodes.syncCancelAction,
				modelSyncAction: models.modelSyncAction,
				modelSyncCancelAction: models.modelSyncCancelAction,
				preparingRedownloadPath: models.preparingRedownloadPath,
				verificationAction: setup.verificationAction,
			}),
		}),
		sameFields,
	);
	return {
		state: {
			...state,
			backendAction: backend.backendAction,
			comfyRestartAction: backend.comfyRestartAction,
		},
		actions: {
			prepareBackend: backend.prepareBackend,
			restartWorkerComfy: backend.restartWorkerComfy,
		},
	};
}
