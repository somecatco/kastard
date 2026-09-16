import type {
	ComfyStartupFailure,
	ComfyVersionUpdate,
	CustomNodeEntry,
	ModelLibraryEntry,
} from "../../shared/api";
import type { CustomNodeSyncStore } from "../worker/custom-node-sync-store";
import type { EditorCustomNodes, InstalledCustomNode } from "./custom-nodes";
import type { EditorModelPaths } from "./model-paths";
import type { ComfyRuntime } from "./runtime";
import { ComfyStartupError } from "./startup-log";
import type { ComfyVersions } from "./versions";

type EditorComfyOptions = {
	runtime: Pick<ComfyRuntime, "start" | "stop" | "restart" | "getState">;
	gateway: { start: () => Promise<string> };
	versions: ComfyVersions | null;
	versionsError?: string | null;
	nodes: Pick<
		EditorCustomNodes,
		"installCustomNode" | "removeCustomNode" | "listCustomNodes" | "cancelInstallation"
	>;
	modelPaths: Pick<EditorModelPaths, "syncModels" | "settled">;
	getSyncStore: () => Pick<CustomNodeSyncStore, "get" | "update" | "remove">;
	getWorkerCustomNodeStatus: () => string | undefined;
	refreshCustomNodeTarget: () => void;
};

export class EditorComfyStartError extends Error {
	constructor(
		message: string,
		readonly reason: "custom-node" | undefined,
		cause: unknown,
		readonly startupFailure?: ComfyStartupFailure,
	) {
		super(message, { cause });
	}
}

export class EditorComfy {
	private readonly lifetime = new AbortController();
	private readonly operations = new Set<Promise<unknown>>();
	private nodeMutation = false;
	private versionMutations = 0;
	private managerSwitching = false;
	private runtimeOperations = 0;
	private restartQueue: Promise<unknown> = Promise.resolve();
	private manualRestart: Promise<string> | null = null;
	private shutdownPromise: Promise<void> | null = null;

	constructor(private readonly options: EditorComfyOptions) {}

	private assertOpen(): void {
		if (this.lifetime.signal.aborted) throw new Error("ComfyUI is shutting down.");
	}

	private assertCanStart(): void {
		this.assertOpen();
		if (this.nodeMutation)
			throw new Error(
				"ComfyUI cannot start or restart while a custom-node change is in progress.",
			);
	}

	private track<T>(operation: () => Promise<T>): Promise<T> {
		const pending = operation();
		this.operations.add(pending);
		const remove = () => {
			this.operations.delete(pending);
		};
		void pending.then(remove, remove);
		return pending;
	}

	start(): Promise<string> {
		return this.track(async () => {
			this.assertCanStart();
			this.runtimeOperations += 1;
			try {
				const url = await this.options.gateway.start();
				this.assertCanStart();
				try {
					await this.options.runtime.start();
				} catch (error) {
					const state = this.options.runtime.getState();
					throw new EditorComfyStartError(
						errorMessage(error),
						state.status === "error" ? state.reason : undefined,
						error,
						error instanceof ComfyStartupError ? error.failure : undefined,
					);
				}
				this.assertOpen();
				return url;
			} finally {
				this.runtimeOperations -= 1;
			}
		});
	}

	restart(): Promise<string> {
		if (this.manualRestart !== null) return this.manualRestart;
		const restart = this.enqueueRestart().finally(() => {
			if (this.manualRestart === restart) this.manualRestart = null;
		});
		this.manualRestart = restart;
		return restart;
	}

	private enqueueRestart(): Promise<string> {
		return this.track(async () => {
			this.assertCanStart();
			this.runtimeOperations += 1;
			const restart = this.restartQueue
				.catch(() => undefined)
				.then(async () => {
					this.assertCanStart();
					await this.options.gateway.start();
					this.assertCanStart();
					return this.options.runtime.restart(this.lifetime.signal);
				});
			this.restartQueue = restart;
			try {
				return await restart;
			} finally {
				this.runtimeOperations -= 1;
			}
		});
	}

	selectVersion(
		update: ComfyVersionUpdate,
	): Promise<ReturnType<ComfyVersions["getState"]>> {
		return this.track(async () => {
			this.assertCanStart();
			const versions = this.options.versions;
			if (versions === null)
				throw new Error(
					this.options.versionsError ?? "ComfyUI versions are unavailable.",
				);
			if (update.component === "manager") {
				// An unchanged Manager selection does not supersede the active transition.
				if (update.version === versions.getState().selection.manager)
					return versions.getState();
				if (this.managerSwitching)
					throw new Error("A ComfyUI Manager version switch is already in progress.");
			}
			this.versionMutations += 1;
			if (update.component === "manager") this.managerSwitching = true;
			try {
				const selection = await versions.prepareSelection(update, this.lifetime.signal);
				this.assertOpen();
				if (selection === null) return versions.getState();
				if (selection.component !== "manager") {
					try {
						await this.enqueueRestart();
					} catch {
						this.assertOpen();
						// Runtime state reports startup failure; the saved selection remains available for retry.
						return versions.getState();
					}
					this.assertOpen();
					await versions
						.completeSelection(selection, this.lifetime.signal)
						.catch(() => undefined);
					return versions.getState();
				}
				try {
					await this.enqueueRestart();
					this.assertOpen();
					return await versions.completeSelection(selection, this.lifetime.signal);
				} catch (error) {
					versions.clearPendingManager();
					if (this.lifetime.signal.aborted) throw error;
					try {
						await this.enqueueRestart();
					} catch (recoveryError) {
						throw new AggregateError(
							[error, recoveryError],
							"ComfyUI Manager switch and recovery failed.",
						);
					}
					throw new Error(errorMessage(error), { cause: error });
				}
			} finally {
				if (update.component === "manager") {
					versions.clearPendingManager();
					this.managerSwitching = false;
				}
				this.versionMutations -= 1;
			}
		});
	}

	private assertCanChangeNodes(action: "installed" | "removed"): void {
		this.assertOpen();
		if (this.nodeMutation)
			throw new Error("Another custom-node change is in progress.");
		if (this.versionMutations > 0)
			throw new Error(
				`Custom nodes cannot be ${action} during a ComfyUI version change.`,
			);
		const workerStatus = this.options.getWorkerCustomNodeStatus();
		if (
			workerStatus === "loading" ||
			workerStatus === "syncing" ||
			workerStatus === "canceling"
		) {
			throw new Error(
				`Custom nodes cannot be ${action} during Worker synchronization.`,
			);
		}
		const state = this.options.runtime.getState();
		const recovery =
			action === "removed" &&
			state.status === "error" &&
			state.reason === "custom-node";
		if (state.status !== "ready" && !recovery)
			throw new Error(`Custom nodes can only be ${action} while ComfyUI is ready.`);
		if (this.runtimeOperations > 0)
			throw new Error(
				`Custom nodes cannot be ${action} while ComfyUI is starting or restarting.`,
			);
	}

	private async withSync(
		nodes: InstalledCustomNode[],
		store: Pick<CustomNodeSyncStore, "get">,
	): Promise<CustomNodeEntry[]> {
		return Promise.all(
			nodes.map(async (node) => ({ ...node, sync: await store.get(node.name) })),
		);
	}

	listCustomNodes(): Promise<CustomNodeEntry[]> {
		return this.track(async () => {
			this.assertOpen();
			const store = this.options.getSyncStore();
			return this.withSync(
				await this.options.nodes.listCustomNodes(this.lifetime.signal),
				store,
			);
		});
	}

	async nodesForSync(): Promise<CustomNodeEntry[]> {
		this.assertOpen();
		if (this.nodeMutation)
			throw new Error("Custom nodes cannot sync while a local change is in progress.");
		return this.listCustomNodes();
	}

	updateNodeSync(name: string, sync: boolean): Promise<void> {
		return this.track(async () => {
			this.assertOpen();
			if (this.nodeMutation)
				throw new Error(
					"Custom-node sync settings cannot change during installation or deletion.",
				);
			await this.options.getSyncStore().update(name, sync);
		});
	}

	installCustomNode(repository: string, version?: string) {
		return this.track(async () => {
			this.assertCanChangeNodes("installed");
			const store = this.options.getSyncStore();
			this.nodeMutation = true;
			try {
				const result = await this.options.nodes.installCustomNode(repository, version);
				const nodes = await this.withSync(result.nodes, store);
				const node = nodes.find((entry) => entry.name === result.node.name);
				if (node === undefined)
					throw new Error(
						"The installed custom node is missing from the local library.",
					);
				return { node, nodes, restartRequired: result.restartRequired };
			} finally {
				this.nodeMutation = false;
				if (!this.lifetime.signal.aborted) this.options.refreshCustomNodeTarget();
			}
		});
	}

	removeCustomNode(name: string): Promise<{ restartRequired: boolean }> {
		return this.track(async () => {
			this.assertCanChangeNodes("removed");
			const store = this.options.getSyncStore();
			this.nodeMutation = true;
			let previousSync: boolean | undefined;
			let selectionRemoved = false;
			let result: { restartRequired: boolean };
			try {
				previousSync = await store.remove(name);
				selectionRemoved = true;
				this.assertOpen();
				result = await this.options.nodes.removeCustomNode(name, this.lifetime.signal);
			} catch (error) {
				if (selectionRemoved && previousSync !== undefined) {
					try {
						await store.update(name, previousSync);
					} catch (restoreError) {
						throw new Error(
							`Custom-node removal failed and its sync setting could not be restored. Removal: ${errorMessage(error)} Restore: ${errorMessage(restoreError)}`,
						);
					}
				}
				throw error;
			} finally {
				this.nodeMutation = false;
			}
			if (!this.lifetime.signal.aborted) this.options.refreshCustomNodeTarget();
			return result;
		});
	}

	updateModels<T>(
		operation: (
			publish: (models: readonly ModelLibraryEntry[]) => Promise<void>,
		) => Promise<T>,
	): Promise<T> {
		return this.track(async () => {
			this.assertOpen();
			return operation((models) => this.options.modelPaths.syncModels(models));
		});
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise !== null) return this.shutdownPromise;
		this.lifetime.abort();
		const installing = this.options.nodes.cancelInstallation();
		const stopping = this.options.runtime.stop();
		this.shutdownPromise = (async () => {
			await Promise.allSettled([installing, stopping, ...this.operations]);
			await this.options.modelPaths.settled();
		})();
		return this.shutdownPromise;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
