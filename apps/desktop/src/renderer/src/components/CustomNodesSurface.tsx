import { PuzzleIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppFormDialog } from "@/components/AppFormDialog";
import { useWorkerCustomNodeSyncState } from "@/components/ConnectionControl";
import { Switch } from "@/components/common/switch";
import { LibrarySurface } from "@/components/LibrarySurface";
import { Button } from "@/components/ui/button";
import { useOptimisticUpdateQueue } from "@/hooks/useOptimisticUpdateQueue";
import {
	type ComfyRuntimeState,
	type CustomNodeEntry,
	isComfyUiManagerNode,
	type WorkerCustomNodeSyncState,
} from "../../../shared/api";

type CustomNodesState =
	| { status: "loading" }
	| {
			status: "ready";
			nodes: CustomNodeEntry[];
			message: { nodeName: string; text: string } | null;
	  }
	| { status: "error"; message: string };

export function CustomNodesSurface({
	runtime,
	notice,
	onRemoved,
}: {
	runtime: ComfyRuntimeState;
	notice: string | null;
	onRemoved: (name: string, restartRequired: boolean) => void;
}): React.JSX.Element {
	const [state, setState] = useState<CustomNodesState>({ status: "loading" });
	const [pendingDeletion, setPendingDeletion] = useState<CustomNodeEntry | null>(null);
	const [removingName, setRemovingName] = useState<string | null>(null);
	const [removalError, setRemovalError] = useState<string | null>(null);
	const {
		confirm: confirmNodeSync,
		enqueue: enqueueNodeSync,
		forget: forgetNodeSync,
		pendingKeys: pendingNodeNames,
	} = useOptimisticUpdateQueue<string, boolean>();
	const workerCustomNodesBusy = isCustomNodeSyncBusy(useWorkerCustomNodeSyncState());

	useEffect(() => {
		let active = true;
		void window.kastard.customNodes
			.list()
			.then((result) => {
				if (!active) return;
				if (result.ok) {
					for (const node of result.nodes) {
						confirmNodeSync(node.name, node.sync);
					}
				}
				setState(
					result.ok
						? {
								status: "ready",
								nodes: result.nodes,
								message: null,
							}
						: { status: "error", message: result.error },
				);
			})
			.catch((error: unknown) => {
				if (active) setState({ status: "error", message: errorMessage(error) });
			});
		return () => {
			active = false;
		};
	}, [confirmNodeSync]);

	useEffect(() => {
		if (workerCustomNodesBusy && removingName === null) {
			setPendingDeletion(null);
			setRemovalError(null);
		}
	}, [removingName, workerCustomNodesBusy]);

	const updateNode = useCallback(
		(node: CustomNodeEntry, sync: boolean) => {
			setState((current) =>
				current.status === "ready"
					? {
							...current,
							nodes: current.nodes.map((item) =>
								item.name === node.name ? { ...item, sync } : item,
							),
							message: null,
						}
					: current,
			);

			void enqueueNodeSync({
				key: node.name,
				previousValue: node.sync,
				formatError: errorMessage,
				save: async () => {
					const result = await window.kastard.customNodes.update({
						name: node.name,
						sync,
					});
					return result.ok ? { ok: true, value: sync, data: undefined } : result;
				},
				onSuccess: (_data, { latest }) => {
					if (!latest) return;
					setState((current) =>
						current.status === "ready" && current.message?.nodeName === node.name
							? { ...current, message: null }
							: current,
					);
				},
				onError: (message, { confirmed, latest }) => {
					setState((current) =>
						current.status === "ready"
							? {
									...current,
									nodes: latest
										? current.nodes.map((item) =>
												item.name === node.name ? { ...item, sync: confirmed } : item,
											)
										: current.nodes,
									message: { nodeName: node.name, text: message },
								}
							: current,
					);
				},
			});
		},
		[enqueueNodeSync],
	);
	const recoveryDeletion =
		runtime.status === "error" && runtime.reason === "custom-node";
	const deletionEnabled = runtime.status === "ready" || recoveryDeletion;
	const removeNode = useCallback(async (): Promise<void> => {
		if (pendingDeletion === null || !deletionEnabled || workerCustomNodesBusy) return;
		const node = pendingDeletion;
		setRemovingName(node.name);
		setRemovalError(null);
		try {
			const result = await window.kastard.customNodes.remove({ name: node.name });
			if (!result.ok) {
				setRemovalError(result.error);
				return;
			}
			forgetNodeSync(node.name);
			setState((current) =>
				current.status === "ready"
					? {
							...current,
							nodes: current.nodes.filter((item) => item.name !== node.name),
							message: null,
						}
					: current,
			);
			setPendingDeletion(null);
			onRemoved(node.name, result.restartRequired);
		} catch (error) {
			setRemovalError(errorMessage(error));
		} finally {
			setRemovingName(null);
		}
	}, [
		deletionEnabled,
		forgetNodeSync,
		onRemoved,
		pendingDeletion,
		workerCustomNodesBusy,
	]);
	const message =
		state.status === "loading"
			? null
			: state.status === "error"
				? state.message
				: (state.message?.text ?? null);
	const stats =
		state.status === "ready"
			? {
					total: state.nodes.length,
					sync: state.nodes.filter((node) => node.sync).length,
				}
			: null;

	const managerDeletion =
		!recoveryDeletion &&
		pendingDeletion !== null &&
		(pendingDeletion.managerId !== null || pendingDeletion.repository !== undefined);

	return (
		<>
			<LibrarySurface
				title="Custom Nodes"
				description="Choose which local custom nodes to sync to the Worker."
				directory="custom-nodes"
				summary={
					stats === null
						? null
						: {
								label: "Custom nodes summary",
								items: [
									{ label: "All", value: stats.total },
									{ label: "Sync", value: stats.sync },
								],
							}
				}
				error={message}
				notice={notice}
				loadingLabel={state.status === "loading" ? "Loading custom nodes…" : null}
				emptyState={
					state.status === "ready" && state.nodes.length === 0
						? {
								icon: PuzzleIcon,
								title: "No custom nodes installed",
								description:
									"Custom nodes installed in local ComfyUI will appear here.",
							}
						: null
				}
			>
				{state.status === "ready" && state.nodes.length > 0
					? state.nodes.map((node) => (
							<article
								key={node.name}
								aria-busy={
									pendingNodeNames.has(node.name) || removingName === node.name
								}
								className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 border-b px-5 py-4 last:border-b-0"
							>
								<div className="min-w-0">
									<h2 className="truncate font-medium">{node.name}</h2>
									<p className="mt-1 select-text font-mono text-xs text-muted-foreground">
										Version {node.version}
									</p>
									{node.repository !== undefined ? (
										<a
											href={node.repository}
											target="_blank"
											rel="noreferrer"
											className="mt-1 block select-text break-all font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										>
											{node.repository}
										</a>
									) : null}
									{node.workerSyncIssue !== undefined ? (
										<p className="mt-1 select-text text-xs text-warning">
											Worker sync unsupported · {node.workerSyncIssue}
										</p>
									) : null}
								</div>
								<div className="flex items-center gap-2">
									<Switch
										label="Sync"
										aria-label={`Sync ${node.name}`}
										checked={node.sync}
										disabled={removingName === node.name}
										onChange={(event) => {
											updateNode(node, event.currentTarget.checked);
										}}
									/>
									{!workerCustomNodesBusy && !isComfyUiManagerNode(node) ? (
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={`Delete ${node.name}`}
											disabled={
												!deletionEnabled ||
												removingName !== null ||
												pendingNodeNames.has(node.name)
											}
											className="text-destructive hover:bg-destructive/10 hover:text-destructive"
											onClick={() => {
												setRemovalError(null);
												setPendingDeletion(node);
											}}
										>
											<TrashIcon />
										</Button>
									) : null}
								</div>
							</article>
						))
					: null}
			</LibrarySurface>
			<AppFormDialog
				open={pendingDeletion !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDeletion(null);
						setRemovalError(null);
					}
				}}
				title={
					managerDeletion ? "Uninstall custom node?" : "Move custom node to Trash?"
				}
				description={
					recoveryDeletion
						? `Move ${pendingDeletion?.name} to Trash so ComfyUI can start again? This removes only the local custom node. The Worker is not changed.`
						: managerDeletion
							? `Uninstall ${pendingDeletion?.name} with ComfyUI Manager? This removes only the local custom node. The Worker is not changed.`
							: `Move ${pendingDeletion?.name} to Trash? This removes only the local custom node. The Worker is not changed.`
				}
				onSubmit={(event) => {
					event.preventDefault();
					void removeNode();
				}}
				submitting={removingName !== null}
				submitLabel={managerDeletion ? "Uninstall" : "Move to Trash"}
				submittingLabel={managerDeletion ? "Uninstalling…" : "Moving to Trash…"}
				submitVariant="destructive"
				submitDisabled={!deletionEnabled || workerCustomNodesBusy}
				error={removalError}
			/>
		</>
	);
}

function isCustomNodeSyncBusy(state: WorkerCustomNodeSyncState): boolean {
	return (
		state.status === "loading" ||
		state.status === "syncing" ||
		state.status === "canceling"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "The custom-nodes request failed.";
}
