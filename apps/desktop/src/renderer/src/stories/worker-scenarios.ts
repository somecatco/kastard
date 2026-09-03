import type {
	ConnectionState,
	SyncVerification,
	WorkerBackendState,
	WorkerComfyState,
	WorkerCustomNodeSyncState,
	WorkerModelSyncState,
	WorkerSetupState,
} from "../../../shared/api";

export type StoryWorkerScenario = {
	setup: WorkerSetupState;
	backend: WorkerBackendState;
	comfy: WorkerComfyState;
	nodes: WorkerCustomNodeSyncState;
	models: WorkerModelSyncState;
};

export const disconnectedConnection = {
	status: "disconnected",
	recentProvider: null,
	recentServerUrl: null,
} satisfies ConnectionState;

export const connectedConnection = {
	status: "connected",
	provider: "other",
	serverUrl: "worker.example.com:22001",
	connectedAt: Date.now(),
} satisfies ConnectionState;

export const offlineConnection = {
	status: "offline",
	provider: "other",
	serverUrl: "https://kastard.example.com",
	message: "Worker is unreachable.",
} satisfies ConnectionState;

const storyRuntime = {
	cudaVersion: "12.8",
	pythonVersion: "3.12.13",
	torchVersion: "2.11.0+cu128",
	torchvisionVersion: "0.26.0+cu128",
	torchaudioVersion: "2.11.0+cu128",
	uvVersion: "0.12.4",
};

const syncedVerification = {
	status: "synced",
	backend: {
		status: "synced",
		expectedVersion: "0.34.0",
		actualVersion: "0.34.0",
	},
	models: { status: "synced", total: 2 },
	customNodes: { status: "synced", total: 2 },
} satisfies SyncVerification;

export const initialSyncScenario = {
	setup: { status: "idle" },
	backend: {
		status: "not-installed",
		editorComfyVersion: "0.34.0",
		runtime: storyRuntime,
	},
	comfy: { status: "stopped" },
	nodes: { status: "idle", nodes: null, unsupportedNodes: [] },
	models: { status: "idle", models: null },
} satisfies StoryWorkerScenario;

export const backendSyncScenario = {
	setup: { status: "running", phase: "preparation" },
	backend: {
		status: "preparing",
		targetVersion: "0.34.0",
		phase: "download",
		progress: 42,
		phaseElapsedMs: 12_000,
		totalElapsedMs: 12_000,
		editorComfyVersion: "0.34.0",
		runtime: storyRuntime,
	},
	comfy: { status: "stopped" },
	nodes: { status: "idle", nodes: null, unsupportedNodes: [] },
	models: { status: "idle", models: null },
} satisfies StoryWorkerScenario;

export const targetsSyncScenario = {
	setup: { status: "running", phase: "preparation" },
	backend: {
		status: "ready",
		editorComfyVersion: "0.34.0",
		version: "0.34.0",
		runtime: storyRuntime,
	},
	comfy: { status: "stopped" },
	nodes: {
		status: "syncing",
		phase: "install",
		current: 1,
		total: 3,
		currentNode: "ComfyUI-KJNodes",
		unsupportedNodes: [],
	},
	models: {
		status: "syncing",
		completed: 2,
		total: 4,
		completedBytes: 3_221_225_472,
		totalBytes: 6_442_450_944,
		present: 1,
		active: ["flux1-dev-fp8.safetensors"],
	},
} satisfies StoryWorkerScenario;

export const comfyStartScenario = {
	setup: { status: "running", phase: "comfy" },
	backend: {
		status: "ready",
		editorComfyVersion: "0.34.0",
		version: "0.34.0",
		runtime: storyRuntime,
	},
	comfy: { status: "starting" },
	nodes: { status: "ready", nodes: [], unsupportedNodes: [] },
	models: { status: "synced", models: [] },
} satisfies StoryWorkerScenario;

export const comfyReadyModelsSyncScenario = {
	setup: { status: "running", phase: "preparation" },
	backend: {
		status: "ready",
		editorComfyVersion: "0.34.0",
		version: "0.34.0",
		runtime: storyRuntime,
	},
	comfy: { status: "ready" },
	nodes: { status: "ready", nodes: [], unsupportedNodes: [] },
	models: {
		status: "syncing",
		completed: 2,
		total: 4,
		completedBytes: 3_221_225_472,
		totalBytes: 6_442_450_944,
		present: 1,
		active: ["flux1-dev-fp8.safetensors"],
	},
} satisfies StoryWorkerScenario;

export const completeSyncScenario = {
	setup: { status: "succeeded", verification: syncedVerification },
	backend: {
		status: "ready",
		editorComfyVersion: "0.34.0",
		version: "0.34.0",
		runtime: storyRuntime,
	},
	comfy: { status: "ready" },
	nodes: { status: "ready", nodes: [], unsupportedNodes: [] },
	models: { status: "synced", models: [] },
} satisfies StoryWorkerScenario;

export const comfyWarningScenario = {
	...completeSyncScenario,
	comfy: {
		status: "ready",
		warnings: [
			"ComfyUI could not initialize every custom node. 0.1 seconds (IMPORT FAILED): /workspace/kastard/custom_nodes/comfyui-impact-pack",
		],
	},
} satisfies StoryWorkerScenario;

export const backendWaitingScenario = {
	...completeSyncScenario,
	setup: { status: "idle" },
	comfy: { status: "stopped" },
} satisfies StoryWorkerScenario;

export const backendMismatchScenario = {
	...completeSyncScenario,
	setup: { status: "idle" },
	backend: {
		status: "ready",
		editorComfyVersion: "0.34.0",
		version: "0.33.1",
		runtime: storyRuntime,
	},
} satisfies StoryWorkerScenario;

export const backendErrorScenario = {
	...completeSyncScenario,
	setup: {
		status: "failed",
		phase: "preparation",
		error: "Backend download failed.",
	},
	backend: {
		status: "failed",
		editorComfyVersion: "0.34.0",
		targetVersion: "0.34.0",
		error: "Backend download failed.",
		retryable: true,
		runtime: storyRuntime,
	},
	comfy: { status: "stopped" },
} satisfies StoryWorkerScenario;

export const checkingSyncScenario = {
	...completeSyncScenario,
	setup: { status: "running", phase: "verification" },
} satisfies StoryWorkerScenario;

export const syncWarningScenario = {
	...completeSyncScenario,
	setup: {
		status: "failed",
		phase: "verification",
		error: "Worker synchronization is out of date.",
		verification: {
			status: "out-of-sync",
			backend: {
				status: "synced",
				expectedVersion: "0.34.0",
				actualVersion: "0.34.0",
			},
			models: {
				status: "out-of-sync",
				total: 1,
				problems: [
					{
						reason: "missing",
						name: "flux1-dev-fp8.safetensors",
						expected: "huggingface:comfy-org/flux1-dev@main",
						actual: null,
					},
				],
			},
			customNodes: { status: "synced", total: 0 },
		},
	},
} satisfies StoryWorkerScenario;

export const comfyErrorScenario = {
	...completeSyncScenario,
	setup: {
		status: "failed",
		phase: "comfy",
		error: "CUDA initialization failed.",
		verification: syncedVerification,
	},
	comfy: { status: "failed", error: "CUDA initialization failed." },
} satisfies StoryWorkerScenario;

const notSelectedWorkerNodes = [
	{
		name: "ComfyUI-Impact-Pack",
		managerId: "ComfyUI-Impact-Pack",
		version: "8.19.1",
	},
];

export const customNodeListSyncingScenario = {
	setup: { status: "running", phase: "preparation" },
	backend: {
		status: "ready",
		editorComfyVersion: "0.34.0",
		version: "0.34.0",
		runtime: storyRuntime,
	},
	comfy: { status: "stopped" },
	nodes: {
		status: "syncing",
		phase: "install",
		current: 1,
		total: 4,
		currentNode: "ComfyUI-KJNodes",
		unsupportedNodes: [],
		targetNodes: [
			{
				id: "comfyui-obvpm",
				editorVersion: "1.0.3",
				workerVersion: "1.0.3",
				status: "installed",
			},
			{
				id: "ComfyUI-KJNodes",
				editorVersion: "1.5.0",
				workerVersion: null,
				status: "installing",
			},
			{
				id: "ComfyUI-GGUF",
				editorVersion: "1.1.2",
				workerVersion: null,
				status: "not-installed",
			},
			{
				id: "RES4LYF",
				editorVersion: "cdf2f4a",
				workerVersion: "8a109de",
				status: "version-mismatch",
			},
		],
		unselectedNodes: notSelectedWorkerNodes,
	},
	models: { status: "synced", models: [] },
} satisfies StoryWorkerScenario;

export const customNodeListFailedScenario = {
	setup: {
		status: "failed",
		phase: "verification",
		error: "Custom node synchronization did not complete.",
		verification: {
			status: "out-of-sync",
			backend: {
				status: "synced",
				expectedVersion: "0.34.0",
				actualVersion: "0.34.0",
			},
			models: { status: "synced", total: 0 },
			customNodes: {
				status: "out-of-sync",
				total: 4,
				problems: [
					{
						reason: "missing",
						name: "ComfyUI-GGUF",
						expected: "1.1.2",
						actual: null,
					},
					{
						reason: "version-mismatch",
						name: "RES4LYF",
						expected: "cdf2f4a",
						actual: "8a109de",
					},
				],
			},
		},
	},
	backend: {
		status: "ready",
		editorComfyVersion: "0.34.0",
		version: "0.34.0",
		runtime: storyRuntime,
	},
	comfy: { status: "stopped" },
	nodes: {
		status: "failed",
		nodes: [
			{ name: "comfyui-obvpm", managerId: "comfyui-obvpm", version: "1.0.3" },
			{ name: "ComfyUI-KJNodes", managerId: "ComfyUI-KJNodes", version: "1.5.0" },
			{
				name: "ComfyUI-Impact-Pack",
				managerId: "ComfyUI-Impact-Pack",
				version: "8.19.1",
			},
			{ name: "RES4LYF", managerId: "RES4LYF", version: "8a109de" },
		],
		error: "Custom node synchronization did not complete.",
		unsupportedNodes: [],
		targetNodes: [
			{
				id: "comfyui-obvpm",
				editorVersion: "1.0.3",
				workerVersion: "1.0.3",
				status: "installed",
			},
			{
				id: "ComfyUI-KJNodes",
				editorVersion: "1.5.0",
				workerVersion: "1.5.0",
				status: "installed",
			},
			{
				id: "ComfyUI-GGUF",
				editorVersion: "1.1.2",
				workerVersion: null,
				status: "failed",
				error: "Python dependency installation failed.",
			},
			{
				id: "RES4LYF",
				editorVersion: "cdf2f4a",
				workerVersion: "8a109de",
				status: "version-mismatch",
			},
		],
		unselectedNodes: notSelectedWorkerNodes,
	},
	models: { status: "synced", models: [] },
} satisfies StoryWorkerScenario;

export const customNodeListCompleteScenario = {
	setup: {
		status: "succeeded",
		verification: {
			status: "synced",
			backend: {
				status: "synced",
				expectedVersion: "0.34.0",
				actualVersion: "0.34.0",
			},
			models: { status: "synced", total: 0 },
			customNodes: { status: "synced", total: 4 },
		},
	},
	backend: {
		status: "ready",
		editorComfyVersion: "0.34.0",
		version: "0.34.0",
		runtime: storyRuntime,
	},
	comfy: { status: "ready" },
	nodes: {
		status: "ready",
		nodes: [
			{ id: "comfyui-obvpm", version: "1.0.3" },
			{ id: "ComfyUI-KJNodes", version: "1.5.0" },
			{ id: "ComfyUI-GGUF", version: "1.1.2" },
			{ id: "RES4LYF", version: "cdf2f4a" },
		],
		unsupportedNodes: [],
		targetNodes: [
			{
				id: "comfyui-obvpm",
				editorVersion: "1.0.3",
				workerVersion: "1.0.3",
				status: "installed",
			},
			{
				id: "ComfyUI-KJNodes",
				editorVersion: "1.5.0",
				workerVersion: "1.5.0",
				status: "installed",
			},
			{
				id: "ComfyUI-GGUF",
				editorVersion: "1.1.2",
				workerVersion: "1.1.2",
				status: "installed",
			},
			{
				id: "RES4LYF",
				editorVersion: "cdf2f4a",
				workerVersion: "cdf2f4a",
				status: "installed",
			},
		],
		unselectedNodes: notSelectedWorkerNodes,
	},
	models: { status: "synced", models: [] },
} satisfies StoryWorkerScenario;
