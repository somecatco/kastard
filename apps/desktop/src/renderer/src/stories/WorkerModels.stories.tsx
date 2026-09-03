import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { userEvent, within } from "storybook/test";
import { ConnectionProvider } from "@/components/ConnectionControl";
import { ModelRedownloadDialog } from "@/components/ModelRedownloadDialog";
import { WorkerModelSyncStatus } from "@/components/WorkerModelSyncStatus";
import type {
	ModelSyncTarget,
	WorkerModelSyncState,
	WorkerModelTargetState,
} from "../../../shared/api";
import { useConfigureStoryWorker } from "./desktop-api-mock";
import { WindowTitlebarMockup } from "./desktop-mockups";
import { completeSyncScenario, connectedConnection } from "./worker-scenarios";

const MODEL_TARGETS = [
	{
		name: "FLUX.1 Dev FP8",
		path: "diffusion_models/flux1-dev-fp8.safetensors",
		artifact: {
			provider: "huggingface",
			modelId: "Comfy-Org/flux1-dev",
			versionId: "8f5f07b823e7c9f8f10df8a7850cbf3f66a2f98a",
			versionLabel: "main",
			fileId: "split_files/diffusion_models/flux1-dev-fp8.safetensors",
			fileName: "flux1-dev-fp8.safetensors",
			sizeBytes: 11_945_877_504,
		},
	},
	{
		name: "T5 XXL FP16",
		path: "text_encoders/t5xxl_fp16.safetensors",
		artifact: {
			provider: "huggingface",
			modelId: "Comfy-Org/flux_text_encoders",
			versionId: "f2a8ca1433d81e86a2dbe471c86169f11200d8fd",
			versionLabel: "main",
			fileId: "split_files/text_encoders/t5xxl_fp16.safetensors",
			fileName: "t5xxl_fp16.safetensors",
			sizeBytes: 9_795_283_968,
		},
	},
	{
		name: "CLIP-L",
		path: "text_encoders/clip_l.safetensors",
		artifact: {
			provider: "huggingface",
			modelId: "Comfy-Org/flux_text_encoders",
			versionId: "f2a8ca1433d81e86a2dbe471c86169f11200d8fd",
			versionLabel: "main",
			fileId: "split_files/text_encoders/clip_l.safetensors",
			fileName: "clip_l.safetensors",
			sizeBytes: 246_144_152,
		},
	},
	{
		name: "FLUX VAE",
		path: "vae/ae.safetensors",
		artifact: {
			provider: "huggingface",
			modelId: "Comfy-Org/flux1-dev",
			versionId: "8f5f07b823e7c9f8f10df8a7850cbf3f66a2f98a",
			versionLabel: "main",
			fileId: "split_files/vae/ae.safetensors",
			fileName: "ae.safetensors",
			sizeBytes: 335_304_388,
		},
	},
	{
		name: "FLUX Realism LoRA",
		path: "loras/flux-realism-lora.safetensors",
		artifact: {
			provider: "civitai",
			modelId: "631986",
			versionId: "706528",
			versionLabel: "v1.0",
			fileId: "790813",
			fileName: "flux-realism-lora.safetensors",
			sizeBytes: 684_146_720,
		},
	},
] as const satisfies readonly ModelSyncTarget[];

const READY_ROWS = MODEL_TARGETS.map(readyRow);
const SYNCING_ROWS: WorkerModelTargetState[] = [
	readyRow(MODEL_TARGETS[0]),
	{
		target: MODEL_TARGETS[1],
		status: "downloading",
		downloadedBytes: 4_438_540_288,
	},
	{
		target: MODEL_TARGETS[2],
		status: "downloading",
		downloadedBytes: 163_577_856,
	},
	missingRow(MODEL_TARGETS[3]),
	missingRow(MODEL_TARGETS[4]),
];
const FAILED_ROWS: WorkerModelTargetState[] = [
	readyRow(MODEL_TARGETS[0]),
	readyRow(MODEL_TARGETS[1]),
	readyRow(MODEL_TARGETS[2]),
	{ ...missingRow(MODEL_TARGETS[3]), status: "needs-redownload" },
	{
		...missingRow(MODEL_TARGETS[4]),
		status: "failed",
		error: "Provider download failed.",
	},
];

function WorkerModelsMockup({
	initialState,
	preparingRedownloadPath = null,
}: {
	initialState: WorkerModelSyncState;
	preparingRedownloadPath?: string | null;
}) {
	const [state, setState] = useState(initialState);
	const [confirmationPath, setConfirmationPath] = useState<string | null>(null);
	useConfigureStoryWorker(connectedConnection, {
		...completeSyncScenario,
		models: state,
	});
	const targetModels = "targetModels" in state ? state.targetModels : undefined;
	const confirmationTarget =
		targetModels?.find((model) => model.target.path === confirmationPath)?.target ??
		null;

	return (
		<div className="flex min-h-svh items-start justify-center bg-[#090a0b] p-6">
			<ConnectionProvider closeRequest={0}>
				<div className="relative flex h-[46rem] w-full max-w-[60rem] flex-col overflow-hidden rounded-[14px] border border-white/10 bg-background shadow-2xl">
					<WindowTitlebarMockup />
					<div
						className="relative min-h-0 flex-1 bg-[#17191a]"
						style={{
							backgroundImage:
								"radial-gradient(circle, rgba(255, 255, 255, 0.08) 1px, transparent 1px)",
							backgroundSize: "20px 20px",
						}}
					>
						<div className="absolute left-1/2 top-3 max-h-[calc(100%-1.5rem)] w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md">
							<WorkerModelSyncStatus
								state={state}
								rate={state.status === "syncing" ? 49_073_356 : null}
								starting={false}
								preparingRedownloadPath={preparingRedownloadPath}
								canceling={false}
								error={null}
								disabled={false}
								onSync={() => undefined}
								onRedownload={setConfirmationPath}
								onCancel={() => setState(canceledRedownloadState(state))}
							/>
						</div>
					</div>
				</div>
				<ModelRedownloadDialog
					target={confirmationTarget}
					onOpenChange={(open) => {
						if (!open) setConfirmationPath(null);
					}}
					onConfirm={(path) => {
						setConfirmationPath(null);
						setState(redownloadingState(state, path));
					}}
				/>
			</ConnectionProvider>
		</div>
	);
}

function readyRow(target: ModelSyncTarget): WorkerModelTargetState {
	return {
		target,
		status: "ready",
		downloadedBytes: target.artifact.sizeBytes,
	};
}

function missingRow(target: ModelSyncTarget): WorkerModelTargetState {
	return { target, status: "not-downloaded", downloadedBytes: 0 };
}

function syncedState(rows = READY_ROWS): WorkerModelSyncState {
	return {
		status: "synced",
		operationKind: "sync",
		capabilities: { forceRedownload: true },
		models: rows.filter((row) => row.status === "ready").map((row) => row.target),
		targetStatus: "current",
		targetModels: rows,
	};
}

function syncingState(): WorkerModelSyncState {
	return {
		status: "syncing",
		operationKind: "sync",
		capabilities: { forceRedownload: true },
		completed: 1,
		total: SYNCING_ROWS.length,
		completedBytes: SYNCING_ROWS.reduce((total, row) => total + row.downloadedBytes, 0),
		totalBytes: MODEL_TARGETS.reduce(
			(total, target) => total + target.artifact.sizeBytes,
			0,
		),
		present: 1,
		active: SYNCING_ROWS.filter((row) => row.status === "downloading").map(
			(row) => row.target.path,
		),
		targetStatus: "current",
		targetModels: SYNCING_ROWS,
	};
}

function failedState(): WorkerModelSyncState {
	return {
		status: "failed",
		operationKind: "sync",
		capabilities: { forceRedownload: true },
		models: FAILED_ROWS.filter((row) => row.status === "ready").map(
			(row) => row.target,
		),
		total: FAILED_ROWS.length,
		error:
			"FLUX Realism LoRA could not be downloaded. FLUX VAE does not match the selected artifact.",
		targetStatus: "current",
		targetModels: FAILED_ROWS,
	};
}

function redownloadingState(
	state: WorkerModelSyncState,
	path: string = MODEL_TARGETS[0].path,
): WorkerModelSyncState {
	const rows =
		"targetModels" in state ? (state.targetModels ?? READY_ROWS) : READY_ROWS;
	const target =
		rows.find((row) => row.target.path === path)?.target ?? MODEL_TARGETS[0];
	const targetModels = rows.map((row) =>
		row.target.path === target.path
			? { ...row, status: "redownloading" as const, downloadedBytes: 3_274_571_776 }
			: row,
	);
	return {
		status: "syncing",
		operationKind: "redownload",
		capabilities: { forceRedownload: true },
		completed: 0,
		total: 1,
		completedBytes: 3_274_571_776,
		totalBytes: target.artifact.sizeBytes,
		present: 0,
		active: [target.path],
		targetStatus: "current",
		targetModels,
	};
}

function canceledRedownloadState(state: WorkerModelSyncState): WorkerModelSyncState {
	if (!("operationKind" in state) || state.operationKind !== "redownload") return state;
	const targetModels =
		"targetModels" in state
			? (state.targetModels ?? []).map((row) =>
					row.status === "redownloading" ? missingRow(row.target) : row,
				)
			: [];
	return {
		status: "canceled",
		operationKind: "redownload",
		capabilities: { forceRedownload: true },
		models: targetModels
			.filter((row) => row.status === "ready")
			.map((row) => row.target),
		targetStatus: "current",
		targetModels,
	};
}

function redownloadFailedState(): WorkerModelSyncState {
	const targetModels = READY_ROWS.map((row, index) =>
		index === 0
			? {
					...row,
					status: "redownload-failed" as const,
					downloadedBytes: 0,
					error: "Provider download failed.",
				}
			: row,
	);
	return {
		status: "failed",
		operationKind: "redownload",
		capabilities: { forceRedownload: true },
		models: targetModels
			.filter((row) => row.status === "ready")
			.map((row) => row.target),
		total: 1,
		error: "Provider download failed.",
		targetStatus: "current",
		targetModels,
	};
}

const meta = {
	title: "Mockups/Worker Models",
	component: WorkerModelsMockup,
	parameters: { layout: "fullscreen" },
	args: { initialState: syncingState() },
} satisfies Meta<typeof WorkerModelsMockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Syncing: Story = {};

export const NeedsAttention: Story = {
	args: { initialState: failedState() },
};

export const Complete: Story = {
	args: { initialState: syncedState() },
};

export const ForceRedownloadMenu: Story = {
	args: { initialState: syncedState() },
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", {
				name: "Actions for FLUX.1 Dev FP8",
			}),
		);
	},
};

export const ForceRedownloadConfirmation: Story = {
	args: { initialState: syncedState() },
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", {
				name: "Actions for FLUX.1 Dev FP8",
			}),
		);
		await userEvent.click(
			within(canvasElement.ownerDocument.body).getByRole("button", {
				name: "Force redownload",
			}),
		);
	},
};

export const ForceRedownloadPreparing: Story = {
	args: {
		initialState: syncedState(),
		preparingRedownloadPath: MODEL_TARGETS[0].path,
	},
};

export const Redownloading: Story = {
	args: { initialState: redownloadingState(syncedState()) },
};

export const RedownloadCanceled: Story = {
	args: {
		initialState: canceledRedownloadState(redownloadingState(syncedState())),
	},
};

export const RedownloadFailed: Story = {
	args: { initialState: redownloadFailedState() },
};
