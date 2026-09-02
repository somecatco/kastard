import type { CustomNodeInventoryEntry } from "@kastard/common";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { userEvent, within } from "storybook/test";
import { CustomNodeReinstallDialog } from "@/components/CustomNodeReinstallDialog";
import { CustomNodeRemovalDialog } from "@/components/CustomNodeRemovalDialog";
import type { WorkerCustomNodeSyncState } from "../../../shared/api";
import { CustomNodeListMockup } from "./desktop-mockups";
import {
	completeSyncScenario,
	customNodeListCompleteScenario,
	customNodeListFailedScenario,
	customNodeListSyncingScenario,
	type StoryWorkerScenario,
} from "./worker-scenarios";

const meta = {
	title: "Mockups/Worker Custom Nodes",
	component: CustomNodeListMockup,
	parameters: { layout: "fullscreen" },
	args: { syncScenario: customNodeListSyncingScenario },
} satisfies Meta<typeof CustomNodeListMockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Syncing: Story = {};

export const Failed: Story = {
	args: { syncScenario: customNodeListFailedScenario },
};

export const Complete: Story = {
	args: { syncScenario: customNodeListCompleteScenario },
};

const FORCE_REINSTALL_NODES = [
	{
		id: "comfyui-easy-use",
		editorVersion: "1.3.6",
		workerVersion: "1.3.6",
		status: "installed" as const,
	},
	{
		id: "ComfyUI-KJNodes",
		editorVersion: "1.5.0",
		workerVersion: "1.5.0",
		status: "installed" as const,
	},
	{
		id: "ComfyUI-GGUF",
		editorVersion: "1.1.2",
		workerVersion: "1.1.2",
		status: "installed" as const,
	},
	{
		id: "RES4LYF",
		editorVersion: "cdf2f4a",
		workerVersion: "cdf2f4a",
		status: "installed" as const,
	},
];

type ForceReinstallMockState =
	| "ready"
	| "preparing"
	| "removing"
	| "installing"
	| "failed";

function CustomNodeForceReinstallStory({
	initialState = "ready",
}: {
	initialState?: ForceReinstallMockState;
}): React.JSX.Element {
	const [reinstallState, setReinstallState] =
		useState<ForceReinstallMockState>(initialState);
	const [targetNodeId, setTargetNodeId] = useState("comfyui-easy-use");
	const [confirmationNodeId, setConfirmationNodeId] = useState<string | null>(null);
	const targetNodes = FORCE_REINSTALL_NODES.map((node) =>
		node.id === targetNodeId && ["removing", "installing"].includes(reinstallState)
			? { ...node, status: "installing" as const }
			: node.id === targetNodeId && reinstallState === "failed"
				? { ...node, status: "failed" as const }
				: node,
	);
	const baseState = {
		capabilities: { forceReinstall: true } as const,
		targetStatus: "current" as const,
		targetNodes,
		unsupportedNodes: [],
		unselectedNodes: [
			{
				name: "ComfyUI-Impact-Pack",
				managerId: "ComfyUI-Impact-Pack",
				version: "8.19.1",
			},
		],
	};
	let nodes: WorkerCustomNodeSyncState;
	if (reinstallState === "ready" || reinstallState === "preparing") {
		nodes = {
			...baseState,
			status: "ready",
			nodes: FORCE_REINSTALL_NODES.map(({ id, editorVersion: version }) => ({
				id,
				version,
			})),
		};
	} else if (reinstallState === "removing" || reinstallState === "installing") {
		nodes = {
			...baseState,
			status: "syncing",
			operationKind: "reinstall",
			reinstallNodeId: targetNodeId,
			phase: "install",
			reinstallPhase: reinstallState === "removing" ? "remove" : "install",
			current: 0,
			total: 1,
			currentNode: targetNodeId,
		};
	} else {
		nodes = {
			...baseState,
			status: "failed",
			operationKind: "reinstall",
			reinstallNodeId: targetNodeId,
			nodes: [],
			error: `Could not reinstall ${targetNodeId}.`,
		};
	}
	const syncScenario = {
		...completeSyncScenario,
		nodes,
	} satisfies StoryWorkerScenario;
	const prepareReinstall = (nodeId: string): void => {
		setTargetNodeId(nodeId);
		setConfirmationNodeId(null);
		setReinstallState("preparing");
	};

	return (
		<>
			<CustomNodeListMockup
				syncScenario={syncScenario}
				preparingReinstallNodeId={reinstallState === "preparing" ? targetNodeId : null}
				onReinstall={setConfirmationNodeId}
			/>
			<CustomNodeReinstallDialog
				nodeId={confirmationNodeId}
				onOpenChange={(open) => {
					if (!open) setConfirmationNodeId(null);
				}}
				onConfirm={prepareReinstall}
			/>
		</>
	);
}

export const ForceReinstallMenu: Story = {
	render: () => <CustomNodeForceReinstallStory />,
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", {
				name: "Actions for comfyui-easy-use",
			}),
		);
	},
};

export const ForceReinstallConfirmation: Story = {
	render: () => <CustomNodeForceReinstallStory />,
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", {
				name: "Actions for comfyui-easy-use",
			}),
		);
		await userEvent.click(
			within(canvasElement.ownerDocument.body).getByRole("button", {
				name: "Force reinstall",
			}),
		);
	},
};

export const ForceReinstallPreparing: Story = {
	render: () => <CustomNodeForceReinstallStory initialState="preparing" />,
};

export const ForceReinstallRemoving: Story = {
	render: () => <CustomNodeForceReinstallStory initialState="removing" />,
};

export const ForceReinstallInstalling: Story = {
	render: () => <CustomNodeForceReinstallStory initialState="installing" />,
};

export const ForceReinstallFailed: Story = {
	render: () => <CustomNodeForceReinstallStory initialState="failed" />,
};

const MANUAL_WORKER_NODE = {
	name: "manual.py",
	managerId: null,
	version: null,
} satisfies CustomNodeInventoryEntry;
const MANAGED_WORKER_NODE = {
	name: "ComfyUI-Impact-Pack",
	managerId: "ComfyUI-Impact-Pack",
	version: "8.19.1",
} satisfies CustomNodeInventoryEntry;

type RemovalMockState = "ready" | "preparing" | "removing" | "failed" | "removed";

function CustomNodeRemovalStory({
	initialState = "ready",
}: {
	initialState?: RemovalMockState;
}): React.JSX.Element {
	const [removalState, setRemovalState] = useState<RemovalMockState>(initialState);
	const [confirmationNode, setConfirmationNode] =
		useState<CustomNodeInventoryEntry | null>(null);
	const targetNodes = FORCE_REINSTALL_NODES;
	const target = targetNodes.map(({ id, editorVersion: version }) => ({ id, version }));
	const unselectedNodes =
		removalState === "removed"
			? [MANAGED_WORKER_NODE]
			: [MANAGED_WORKER_NODE, MANUAL_WORKER_NODE];
	const baseState = {
		capabilities: { remove: true } as const,
		targetStatus: "current" as const,
		targetNodes,
		unsupportedNodes: [],
		unselectedNodes,
	};
	let nodes: WorkerCustomNodeSyncState;
	if (removalState === "removing") {
		nodes = {
			...baseState,
			status: "syncing",
			operationKind: "remove",
			removalNode: MANUAL_WORKER_NODE,
			phase: "remove",
			removalPhase: "remove",
			current: 0,
			total: 1,
			currentNode: MANUAL_WORKER_NODE.name,
		};
	} else if (removalState === "failed") {
		nodes = {
			...baseState,
			status: "failed",
			operationKind: "remove",
			removalNode: MANUAL_WORKER_NODE,
			nodes: unselectedNodes,
			error: `Could not remove ${MANUAL_WORKER_NODE.name} from the Worker.`,
		};
	} else {
		nodes = {
			...baseState,
			status: "ready",
			...(removalState === "removed"
				? { operationKind: "remove" as const, removalNode: MANUAL_WORKER_NODE }
				: {}),
			nodes: target,
		};
	}
	const syncScenario = { ...completeSyncScenario, nodes } satisfies StoryWorkerScenario;

	return (
		<>
			<CustomNodeListMockup
				syncScenario={syncScenario}
				preparingRemovalNodeName={
					removalState === "preparing" ? MANUAL_WORKER_NODE.name : null
				}
				onRemove={setConfirmationNode}
			/>
			<CustomNodeRemovalDialog
				node={confirmationNode}
				onOpenChange={(open) => {
					if (!open) setConfirmationNode(null);
				}}
				onConfirm={() => {
					setConfirmationNode(null);
					setRemovalState("preparing");
				}}
			/>
		</>
	);
}

export const RemoveMenu: Story = {
	render: () => <CustomNodeRemovalStory />,
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", { name: "Actions for manual.py" }),
		);
	},
};

export const RemoveConfirmation: Story = {
	render: () => <CustomNodeRemovalStory />,
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", { name: "Actions for manual.py" }),
		);
		await userEvent.click(
			within(canvasElement.ownerDocument.body).getByRole("button", {
				name: "Delete from Worker",
			}),
		);
	},
};

export const RemovePreparing: Story = {
	render: () => <CustomNodeRemovalStory initialState="preparing" />,
};

export const Removing: Story = {
	render: () => <CustomNodeRemovalStory initialState="removing" />,
};

export const RemoveFailed: Story = {
	render: () => <CustomNodeRemovalStory initialState="failed" />,
};

export const Removed: Story = {
	render: () => <CustomNodeRemovalStory initialState="removed" />,
};
