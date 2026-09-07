import { expect, test } from "vitest";
import type {
	SyncVerification,
	WorkerCustomNodeSyncState,
	WorkerModelSyncState,
	WorkerModelTargetState,
} from "../../../shared/api";
import { modelsPresentation } from "./worker-models-presentation";
import { nodesPresentation } from "./worker-nodes-presentation";

const verification: SyncVerification = {
	status: "out-of-sync",
	backend: { status: "synced", expectedVersion: "1.0.0", actualVersion: "1.0.0" },
	models: { status: "synced", total: 0 },
	customNodes: {
		status: "out-of-sync",
		total: 2,
		problems: [
			{ reason: "missing", name: "failed-node", expected: "1.0.0", actual: null },
			{ reason: "unexpected", name: "extra-node", expected: null, actual: "1.0.0" },
		],
	},
};
const nodeState: WorkerCustomNodeSyncState = {
	status: "ready",
	nodes: [],
	unsupportedNodes: [{ name: "local-node", reason: "Repository metadata unavailable" }],
	targetStatus: "current",
	targetNodes: [
		{
			id: "ready-node",
			editorVersion: "1.0.0",
			workerVersion: "1.0.0",
			status: "installed",
		},
		{
			id: "failed-node",
			editorVersion: "1.0.0",
			workerVersion: null,
			status: "failed",
			error: "Installation failed",
		},
	],
};
const nodeInput: Parameters<typeof nodesPresentation>[0] = {
	syncState: nodeState,
	setupState: { status: "idle" },
	workerComfyState: { status: "ready" },
	verification,
	verificationAction: false,
	syncAction: false,
	syncCancelAction: false,
	syncError: null,
	preparingReinstallNodeId: null,
};
const model: WorkerModelTargetState = {
	target: {
		name: "Example",
		path: "checkpoints/example.safetensors",
		artifact: {
			provider: "huggingface",
			modelId: "example/model",
			versionId: "main",
			versionLabel: "main",
			fileId: "example.safetensors",
			fileName: "example.safetensors",
			sizeBytes: 100,
		},
	},
	status: "failed",
	downloadedBytes: 0,
	error: "Download failed",
};
const modelState: WorkerModelSyncState = {
	status: "idle",
	models: null,
	targetStatus: "current",
	targetModels: [model],
};
const modelInput: Parameters<typeof modelsPresentation>[0] = {
	modelSyncState: modelState,
	setupState: { status: "idle" },
	workerComfyState: { status: "ready" },
	verification: null,
	verificationAction: false,
	modelSyncAction: false,
	modelSyncCancelAction: false,
	modelSyncError: null,
	preparingRedownloadPath: null,
};

test("counts the displayed node selection and unsupported nodes while retaining installation failures", () => {
	const display = nodesPresentation(nodeInput);
	expect(display.summary).toMatchObject({ completed: 1, total: 3, status: "warning" });
	expect(display.targets?.[1]).toMatchObject({
		status: "failed",
		error: "Installation failed",
	});
	expect(
		nodesPresentation({ ...nodeInput, workerComfyState: { status: "stopped" } }).summary
			.status,
	).toBe("error");
});

test.each(["stale", "unknown"] as const)(
	"keeps %s target rows and counts consistent without applying verification to them",
	(targetStatus) => {
		const nodes = nodesPresentation({
			...nodeInput,
			syncState: { ...nodeState, targetStatus },
			verification: { ...verification, customNodes: { status: "synced", total: 8 } },
		});
		expect(nodes.targets).toEqual(nodeState.targetNodes);
		expect(nodes.summary).toMatchObject({ completed: 1, total: 3 });
		const models = modelsPresentation({
			...modelInput,
			modelSyncState: { ...modelState, targetStatus },
			verification: { ...verification, models: { status: "synced", total: 8 } },
		});
		expect(models.targets).toEqual(modelState.targetModels);
		expect(models.summary).toMatchObject({ completed: 0, total: 1 });
	},
);

test("preserves a failed download when verification reports the same file as missing", () => {
	const display = modelsPresentation({
		...modelInput,
		verification: {
			...verification,
			models: {
				status: "out-of-sync",
				total: 1,
				problems: [
					{ reason: "missing", name: model.target.path, expected: "100", actual: null },
				],
			},
		},
	});
	expect(display.targets?.[0]).toMatchObject({
		status: "failed",
		error: "Download failed",
	});
	expect(display.summary).toMatchObject({ completed: 0, total: 1, status: "warning" });
});

test("uses verified aggregate totals when the Worker has no target rows", () => {
	const nodes = nodesPresentation({
		...nodeInput,
		syncState: { status: "ready", nodes: [], unsupportedNodes: [] },
	});
	expect(nodes.summary).toMatchObject({ completed: 1, total: 2 });
	const models = modelsPresentation({
		...modelInput,
		modelSyncState: { status: "idle", models: null },
		verification: { ...verification, models: { status: "synced", total: 3 } },
	});
	expect(models.summary).toMatchObject({ completed: 3, total: 3 });
});
