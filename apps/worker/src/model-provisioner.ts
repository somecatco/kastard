import { createHash, randomUUID } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
	MODEL_SYNC_CONTRACT_VERSION,
	type ModelProvider,
	type ModelSyncFileState,
	type ModelSyncOperationKind,
	type ModelSyncParseIssue,
	type ModelSyncRequest,
	type ModelSyncSnapshot,
	type ModelSyncState,
	type ModelSyncTarget,
	parseModelSyncRequest,
	parseModelSyncTargets,
	parseModelVerificationRequest,
	sameModelSyncTarget,
} from "@kastard/common";
import { ProcessOutputLineBuffer } from "./process-output";
import type { CollectionVerification, VerificationProblem } from "./sync-verification";
import type { WorkerLogStore } from "./worker-log";

const MAX_MODEL_IDENTITIES = 10_000;
const MAX_PROVIDER_CONCURRENCY = 2;
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const MANIFEST_NAME = "model-sync.json";

type ModelManifest = {
	models: ModelSyncTarget[];
	identities: ModelSyncTarget[];
	complete: boolean;
};

export type {
	ModelArtifact,
	ModelProvider,
	ModelSyncRequest,
	ModelSyncState,
	ModelSyncTarget,
} from "@kastard/common";

export interface ModelProvisionerApi {
	getState(): ModelSyncState;
	verify(request: unknown): Promise<CollectionVerification>;
	sync(request: unknown): ModelSyncState;
	redownload(request: unknown): ModelSyncState;
	cancel(operationId?: string): ModelSyncState;
}

type ActiveModelOperation = {
	id: string;
	kind: ModelSyncOperationKind;
	request: ModelSyncRequest;
	controller: AbortController;
};

function createModelOperation(
	request: ModelSyncRequest,
	kind: ModelSyncOperationKind,
): ActiveModelOperation {
	return { id: randomUUID(), kind, request, controller: new AbortController() };
}

function operationState(operation: ActiveModelOperation) {
	return {
		contractVersion: MODEL_SYNC_CONTRACT_VERSION,
		capabilities: { forceRedownload: true as const },
		target: { models: operation.request.models },
		operationId: operation.id,
		operationKind: operation.kind,
	};
}

type DownloadModel = (
	target: ModelSyncTarget,
	token: string | undefined,
	stagingDirectory: string,
	onProgress: (bytes: number) => void,
	signal: AbortSignal,
) => Promise<string>;

type ModelProvisionerOptions = {
	rootDirectory: string;
	runtimePython: string;
	logs: WorkerLogStore;
	download?: DownloadModel;
};

export class ModelSyncError extends Error {
	constructor(
		message: string,
		readonly statusCode: 400 | 409,
	) {
		super(message);
	}
}

export class ModelProvisionerUnavailableError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

export class ModelProvisionerController implements ModelProvisionerApi {
	private provisioner: ModelProvisionerApi | null = null;
	private error = "Model synchronization is initializing.";
	private retryable = true;

	attach(provisioner: ModelProvisionerApi): void {
		this.provisioner = provisioner;
	}

	fail(error: string): void {
		this.provisioner = null;
		this.error = error;
		this.retryable = false;
	}

	getState(): ModelSyncState {
		return this.current().getState();
	}

	verify(request: unknown): Promise<CollectionVerification> {
		return this.current().verify(request);
	}

	sync(request: unknown): ModelSyncState {
		return this.current().sync(request);
	}

	redownload(request: unknown): ModelSyncState {
		return this.current().redownload(request);
	}

	cancel(operationId?: string): ModelSyncState {
		return this.current().cancel(operationId);
	}

	private current(): ModelProvisionerApi {
		if (this.provisioner === null) {
			throw new ModelProvisionerUnavailableError(this.error, this.retryable);
		}
		return this.provisioner;
	}
}

export class ModelProvisioner implements ModelProvisionerApi {
	private state: ModelSyncState = {
		contractVersion: MODEL_SYNC_CONTRACT_VERSION,
		capabilities: { forceRedownload: true },
		target: null,
		operationId: null,
		status: "idle",
		models: null,
	};
	private readonly rootDirectory: string;
	private readonly runtimePython: string;
	private readonly logs: WorkerLogStore;
	private readonly download: DownloadModel;
	private activeOperation: ActiveModelOperation | null = null;

	static async create(options: ModelProvisionerOptions): Promise<ModelProvisioner> {
		const provisioner = new ModelProvisioner(options);
		await mkdir(provisioner.modelsDirectory(), { recursive: true });
		await mkdir(provisioner.kastardDirectory(), { recursive: true });
		await rm(provisioner.downloadsDirectory(), { recursive: true, force: true });
		const manifest = await readManifest(provisioner.manifestPath());
		if (manifest !== null) {
			const restored = await presentTargets(
				manifest.models,
				provisioner.modelsDirectory(),
			);
			provisioner.state = {
				contractVersion: MODEL_SYNC_CONTRACT_VERSION,
				capabilities: { forceRedownload: true },
				target: restored.length === 0 ? null : { models: restored },
				operationId: null,
				status: "idle",
				models: restored,
				...(restored.length === 0
					? {}
					: {
							modelSnapshot: modelSnapshot(restored, {
								ready: new Set(restored.map((target) => target.path)),
							}),
						}),
			};
		}
		return provisioner;
	}

	constructor(options: ModelProvisionerOptions) {
		this.rootDirectory = validateRootDirectory(options.rootDirectory);
		this.runtimePython = options.runtimePython;
		this.logs = options.logs;
		this.download =
			options.download ??
			((target, token, directory, onProgress, signal) =>
				target.artifact.provider === "huggingface"
					? downloadHuggingFace(
							this.runtimePython,
							target,
							token,
							directory,
							onProgress,
							signal,
						)
					: downloadCivitai(target, token, directory, onProgress, signal));
	}

	getState(): ModelSyncState {
		return this.state;
	}

	async verify(value: unknown): Promise<CollectionVerification> {
		const models = validateVerificationRequest(value);
		if (
			this.state.status === "checking" ||
			this.state.status === "syncing" ||
			this.state.status === "canceling"
		) {
			return { status: "syncing" };
		}
		try {
			const manifest = await readManifest(this.manifestPath());
			return await this.verifySelection(models, manifest);
		} catch {
			return {
				status: "unavailable",
				error: "Could not inspect Worker model files.",
			};
		}
	}

	private async verifySelection(
		models: ModelSyncTarget[],
		manifest: ModelManifest | null,
	): Promise<CollectionVerification> {
		const checked = await Promise.all(
			models.map(async (target) => ({
				target,
				result: await inspectTarget(target, this.modelsDirectory()),
			})),
		);
		const recorded = new Map(
			(manifest?.identities ?? []).map((target) => [target.path, target] as const),
		);
		const problems: VerificationProblem[] = [];
		for (const { target, result } of checked) {
			if (result === "missing") {
				problems.push({
					reason: "missing",
					name: target.path,
					expected: modelIdentity(target),
					actual: null,
				});
				continue;
			}
			if (result === "conflict") {
				problems.push({
					reason: "conflict",
					name: target.path,
					expected: `${target.artifact.sizeBytes} bytes`,
					actual: "Different file type or size",
				});
				continue;
			}
			const previous = recorded.get(target.path);
			if (previous === undefined || !sameModelSyncTarget(previous, target)) {
				problems.push({
					reason: "stale",
					name: target.path,
					expected: modelIdentity(target),
					actual: previous === undefined ? null : modelIdentity(previous),
				});
			}
		}
		return problems.length === 0
			? { status: "synced", total: models.length }
			: { status: "out-of-sync", total: models.length, problems };
	}

	sync(value: unknown): ModelSyncState {
		const request = validateRequest(value);
		return this.start(request, "sync");
	}

	redownload(value: unknown): ModelSyncState {
		const request = validateRequest(value);
		if (request.models.length !== 1) {
			throw new ModelSyncError("Force redownload requires exactly one model.", 400);
		}
		return this.start(request, "redownload");
	}

	private start(
		request: ModelSyncRequest,
		kind: ModelSyncOperationKind,
	): ModelSyncState {
		if (
			this.state.status === "checking" ||
			this.state.status === "syncing" ||
			this.state.status === "canceling"
		) {
			throw new ModelSyncError("Models are already synchronizing.", 409);
		}
		const totalBytes = request.models.reduce(
			(total, model) => total + model.artifact.sizeBytes,
			0,
		);
		const operation = createModelOperation(request, kind);
		this.activeOperation = operation;
		this.state = {
			...operationState(operation),
			status: "checking",
			total: request.models.length,
			totalBytes,
			modelSnapshot: modelSnapshot(request.models),
		};
		const run =
			kind === "redownload" ? this.runRedownload(operation) : this.run(operation);
		void run.finally(() => {
			if (this.activeOperation === operation) this.activeOperation = null;
		});
		return this.state;
	}

	cancel(operationId?: string): ModelSyncState {
		if (operationId !== undefined && this.state.operationId !== operationId) {
			throw new ModelSyncError(
				"The model synchronization operation is no longer current.",
				409,
			);
		}
		if (this.state.status === "canceling") return this.state;
		if (this.state.status !== "checking" && this.state.status !== "syncing") {
			return this.state;
		}
		if (operationId === undefined && this.state.operationKind === "redownload") {
			throw new ModelSyncError(
				"Force redownload cancellation requires its operation id.",
				409,
			);
		}
		const operation = this.activeOperation;
		if (operation === null || operation.id !== this.state.operationId) {
			throw new ModelSyncError(
				"The model synchronization operation is unavailable.",
				409,
			);
		}
		this.state = {
			...operationState(operation),
			status: "canceling",
			...(this.state.modelSnapshot === undefined
				? {}
				: { modelSnapshot: this.state.modelSnapshot }),
		};
		const action = operation.kind === "redownload" ? "redownload" : "synchronization";
		this.logs.write("info", `Canceling model ${action}.`);
		operation.controller.abort(new Error(`Model ${action} was canceled.`));
		return this.state;
	}

	private async run(operation: ActiveModelOperation): Promise<void> {
		const { request } = operation;
		const { signal } = operation.controller;
		const totalBytes = request.models.reduce(
			(total, model) => total + model.artifact.sizeBytes,
			0,
		);
		const ready: ModelSyncTarget[] = [];
		const readyPaths = new Set<string>();
		const needsRedownload = new Set<string>();
		const failures = new Map<string, string>();
		let recordedIdentities: ModelSyncTarget[] | null = null;
		try {
			const [manifest, inspected] = await Promise.all([
				readManifest(this.manifestPath()),
				Promise.all(
					request.models.map(async (target) => ({
						target,
						result: await inspectTarget(target, this.modelsDirectory()),
					})),
				),
			]);
			recordedIdentities = manifest?.identities ?? [];
			const recorded = new Map(
				recordedIdentities.map((target) => [target.path, target] as const),
			);
			const checked = inspected.map(({ target, result }) => {
				const previous = recorded.get(target.path);
				return {
					target,
					result:
						result === "present" &&
						previous !== undefined &&
						!sameModelSyncTarget(previous, target)
							? ("conflict" as const)
							: result,
				};
			});
			const present = checked
				.filter(({ result }) => result === "present")
				.map(({ target }) => target);
			ready.push(...present);
			for (const target of present) readyPaths.add(target.path);
			signal.throwIfAborted();
			const conflicts = checked.filter(({ result }) => result === "conflict");
			for (const { target } of conflicts) needsRedownload.add(target.path);
			if (conflicts.length > 0) {
				throw new Error(
					`Existing model files do not match the selected artifacts: ${conflicts
						.slice(0, 5)
						.map(({ target }) => target.path)
						.join(", ")}.`,
				);
			}

			const queued = checked
				.filter(({ result }) => result === "missing")
				.map(({ target }) => target)
				.sort((left, right) => right.artifact.sizeBytes - left.artifact.sizeBytes);

			if (queued.length === 0) {
				await writeManifest(this.manifestPath(), {
					models: request.models,
					identities: mergeModelIdentities(recordedIdentities, request.models),
					complete: true,
				});
				signal.throwIfAborted();
				this.state = {
					...operationState(operation),
					status: "synced",
					models: request.models,
					modelSnapshot: modelSnapshot(request.models, { ready: readyPaths }),
				};
				this.logs.write("info", `${request.models.length} models are ready.`);
				return;
			}

			let completed = present.length;
			let completedBytes = present.reduce(
				(total, model) => total + model.artifact.sizeBytes,
				0,
			);
			const active = new Map<string, number>();
			const publishProgress = (): void => {
				if (signal.aborted) return;
				const activeBytes = [...active.values()].reduce(
					(total, bytes) => total + bytes,
					0,
				);
				this.state = {
					...operationState(operation),
					status: "syncing",
					completed,
					total: request.models.length,
					completedBytes: Math.min(totalBytes, completedBytes + activeBytes),
					totalBytes,
					present: present.length,
					active: [...active.keys()],
					modelSnapshot: modelSnapshot(request.models, {
						ready: readyPaths,
						active,
						failures,
						needsRedownload,
					}),
				};
			};
			publishProgress();

			const providerQueues = new Map<ModelProvider, ModelSyncTarget[]>([
				[
					"huggingface",
					queued.filter((target) => target.artifact.provider === "huggingface"),
				],
				["civitai", queued.filter((target) => target.artifact.provider === "civitai")],
			]);
			const workers: Promise<void>[] = [];
			for (const [provider, queue] of providerQueues) {
				const token = request.credentials[provider];
				const workerCount = Math.min(MAX_PROVIDER_CONCURRENCY, queue.length);
				for (let index = 0; index < workerCount; index += 1) {
					workers.push(
						this.runQueue(
							queue,
							token,
							active,
							(target) => {
								ready.push(target);
								readyPaths.add(target.path);
								completed += 1;
								completedBytes += target.artifact.sizeBytes;
							},
							(target, message) => failures.set(target.path, message),
							publishProgress,
							signal,
						),
					);
				}
			}
			await Promise.all(workers);
			signal.throwIfAborted();

			if (failures.size > 0) {
				await writeManifest(this.manifestPath(), {
					models: ready,
					identities: mergeModelIdentities(recordedIdentities, ready),
					complete: false,
				});
				signal.throwIfAborted();
				const error = [...failures.values()].slice(0, 3).join(" ");
				this.state = {
					...operationState(operation),
					status: "failed",
					models: ready,
					total: request.models.length,
					error,
					modelSnapshot: modelSnapshot(request.models, {
						ready: readyPaths,
						failures,
						needsRedownload,
					}),
				};
				this.logs.write("error", `Model synchronization failed: ${error}`);
				return;
			}
			await writeManifest(this.manifestPath(), {
				models: request.models,
				identities: mergeModelIdentities(recordedIdentities, request.models),
				complete: true,
			});
			signal.throwIfAborted();
			this.state = {
				...operationState(operation),
				status: "synced",
				models: request.models,
				modelSnapshot: modelSnapshot(request.models, { ready: readyPaths }),
			};
			this.logs.write("info", `${request.models.length} models are ready.`);
		} catch (error) {
			let failure = error;
			if (signal.aborted) {
				try {
					if (recordedIdentities !== null) {
						await writeManifest(this.manifestPath(), {
							models: ready,
							identities: mergeModelIdentities(recordedIdentities, ready),
							complete: false,
						});
					}
					this.state = {
						...operationState(operation),
						status: "canceled",
						models: ready,
						modelSnapshot: modelSnapshot(request.models, {
							ready: readyPaths,
							failures,
							needsRedownload,
						}),
					};
					this.logs.write("info", "Model synchronization was canceled.");
					return;
				} catch (cleanupError) {
					failure = cleanupError;
				}
			}
			const message = userFacingError(failure);
			this.state = {
				...operationState(operation),
				status: "failed",
				models: ready,
				total: request.models.length,
				error: message,
				modelSnapshot: modelSnapshot(request.models, {
					ready: readyPaths,
					failures,
					needsRedownload,
				}),
			};
			this.logs.write("error", `Model synchronization failed: ${message}`);
		}
	}

	private async runRedownload(operation: ActiveModelOperation): Promise<void> {
		const target = operation.request.models[0];
		if (target === undefined) return;
		const { signal } = operation.controller;
		const destination = modelPath(this.modelsDirectory(), target.path);
		let originalStatus: ModelSyncFileState["status"] | null = null;
		let removed = false;
		let published = false;
		let downloadedBytes = 0;
		let manifestWithoutTarget: ModelManifest = {
			models: [],
			identities: [],
			complete: false,
		};
		try {
			const manifest = await readManifest(this.manifestPath());
			const manifestModels = manifest?.models ?? [];
			const restoreCompleteManifest =
				manifest?.complete === true &&
				manifestModels.some(
					(model) => model.path === target.path && sameModelSyncTarget(model, target),
				);
			const inspected = await inspectTarget(target, this.modelsDirectory());
			originalStatus =
				inspected === "present"
					? "ready"
					: inspected === "conflict"
						? "needs-redownload"
						: "not-downloaded";
			signal.throwIfAborted();
			await removeModelTarget(destination, this.modelsDirectory());
			removed = true;
			manifestWithoutTarget = {
				models: (manifest?.models ?? []).filter((model) => model.path !== target.path),
				identities: (manifest?.identities ?? []).filter(
					(model) => model.path !== target.path,
				),
				complete: false,
			};
			await writeManifest(this.manifestPath(), manifestWithoutTarget);
			this.logs.write("info", `Removed ${target.path} before force redownload.`);
			signal.throwIfAborted();

			const publishProgress = (bytes: number): void => {
				if (signal.aborted) return;
				downloadedBytes = Math.min(bytes, target.artifact.sizeBytes);
				this.state = {
					...operationState(operation),
					status: "syncing",
					completed: 0,
					total: 1,
					completedBytes: downloadedBytes,
					totalBytes: target.artifact.sizeBytes,
					present: 0,
					active: [target.path],
					modelSnapshot: modelSnapshot([target], {
						active: new Map([[target.path, downloadedBytes]]),
					}),
				};
			};
			publishProgress(0);
			await this.downloadTarget(
				target,
				operation.request.credentials[target.artifact.provider],
				publishProgress,
				signal,
			);
			published = true;
			signal.throwIfAborted();
			await writeManifest(this.manifestPath(), {
				models: manifestModels.some((model) => model.path === target.path)
					? manifestModels.map((model) => (model.path === target.path ? target : model))
					: [...manifestModels, target],
				identities: mergeModelIdentities(manifest?.identities ?? [], [target]),
				complete: restoreCompleteManifest,
			});
			signal.throwIfAborted();
			this.state = {
				...operationState(operation),
				status: "synced",
				models: [target],
				modelSnapshot: modelSnapshot([target], {
					ready: new Set([target.path]),
				}),
			};
			this.logs.write("info", `${target.path} was force redownloaded.`);
		} catch (error) {
			let failure = error;
			if (signal.aborted) {
				try {
					if (!removed && originalStatus === null) {
						const inspected = await inspectTarget(target, this.modelsDirectory());
						originalStatus =
							inspected === "present"
								? "ready"
								: inspected === "conflict"
									? "needs-redownload"
									: "not-downloaded";
					}
					if (published) {
						await removeModelTarget(destination, this.modelsDirectory());
					}
					if (removed || published) {
						await writeManifest(this.manifestPath(), manifestWithoutTarget);
					}
					const retained = !removed && originalStatus === "ready";
					const needsRedownload = !removed && originalStatus === "needs-redownload";
					this.state = {
						...operationState(operation),
						status: "canceled",
						models: retained ? [target] : [],
						modelSnapshot: modelSnapshot([target], {
							...(retained ? { ready: new Set([target.path]) } : {}),
							...(needsRedownload ? { needsRedownload: new Set([target.path]) } : {}),
						}),
					};
					this.logs.write("info", "Model redownload was canceled.");
					return;
				} catch (cleanupError) {
					failure = cleanupError;
				}
			}
			const message = userFacingError(
				failure,
				operation.request.credentials[target.artifact.provider],
			);
			const status: ModelSyncFileState["status"] = published
				? "needs-redownload"
				: removed
					? "not-downloaded"
					: originalStatus === "ready"
						? "ready"
						: originalStatus === "needs-redownload"
							? "needs-redownload"
							: "failed";
			this.state = {
				...operationState(operation),
				status: "failed",
				models: published || (!removed && originalStatus === "ready") ? [target] : [],
				total: 1,
				error: message,
				modelSnapshot: {
					models: [
						{
							path: target.path,
							status,
							downloadedBytes: status === "ready" ? target.artifact.sizeBytes : 0,
							error: message,
						},
					],
				},
			};
			this.logs.write("error", `Model redownload failed: ${message}`);
		}
	}

	private async runQueue(
		queue: ModelSyncTarget[],
		token: string | undefined,
		active: Map<string, number>,
		onComplete: (target: ModelSyncTarget) => void,
		onError: (target: ModelSyncTarget, message: string) => void,
		onProgress: () => void,
		signal: AbortSignal,
	): Promise<void> {
		for (;;) {
			if (signal.aborted) return;
			const target = queue.shift();
			if (target === undefined) return;
			active.set(target.path, 0);
			onProgress();
			try {
				await this.downloadTarget(
					target,
					token,
					(bytes) => {
						active.set(target.path, Math.min(bytes, target.artifact.sizeBytes));
						onProgress();
					},
					signal,
				);
				onComplete(target);
			} catch (error) {
				if (!signal.aborted)
					onError(target, `${target.name}: ${userFacingError(error, token)}`);
			} finally {
				active.delete(target.path);
				onProgress();
			}
		}
	}

	private async downloadTarget(
		target: ModelSyncTarget,
		token: string | undefined,
		onProgress: (bytes: number) => void,
		signal: AbortSignal,
	): Promise<void> {
		const stagingDirectory = join(
			this.kastardDirectory(),
			"model-downloads",
			randomUUID(),
		);
		const destination = modelPath(this.modelsDirectory(), target.path);
		await mkdir(stagingDirectory, { recursive: true });
		await mkdir(dirname(destination), { recursive: true });
		try {
			signal.throwIfAborted();
			this.logs.write("info", `Downloading ${target.path}.`);
			let loggedPercent = 0;
			const downloaded = await this.download(
				target,
				token,
				stagingDirectory,
				(bytes) => {
					onProgress(bytes);
					const percent = Math.floor(
						(Math.min(bytes, target.artifact.sizeBytes) * 100) /
							target.artifact.sizeBytes,
					);
					if (percent < 10 || percent >= 100 || percent < loggedPercent + 10) return;
					loggedPercent = percent - (percent % 10);
					this.logs.write("info", `Downloading ${target.path}: ${loggedPercent}%.`);
				},
				signal,
			);
			signal.throwIfAborted();
			const metadata = await lstat(downloaded);
			if (!metadata.isFile() || metadata.size !== target.artifact.sizeBytes) {
				throw new Error(
					`Downloaded size did not match ${target.artifact.sizeBytes} bytes.`,
				);
			}
			try {
				await link(downloaded, destination);
			} catch (error) {
				if (isErrorCode(error, "EEXIST")) {
					throw new Error("A model file appeared at the destination during sync.");
				}
				throw error;
			}
		} finally {
			await rm(stagingDirectory, { recursive: true, force: true });
		}
		this.logs.write("info", `Downloaded ${target.path}.`);
	}

	private modelsDirectory(): string {
		return join(this.rootDirectory, "models");
	}

	private kastardDirectory(): string {
		return join(this.rootDirectory, ".kastard");
	}

	private downloadsDirectory(): string {
		return join(this.kastardDirectory(), "model-downloads");
	}

	private manifestPath(): string {
		return join(this.kastardDirectory(), MANIFEST_NAME);
	}
}

async function presentTargets(
	targets: ModelSyncTarget[],
	modelsDirectory: string,
): Promise<ModelSyncTarget[]> {
	const checked = await Promise.all(
		targets.map(async (target) => ({
			target,
			result: await inspectTarget(target, modelsDirectory),
		})),
	);
	return checked
		.filter(({ result }) => result === "present")
		.map(({ target }) => target);
}

async function inspectTarget(
	target: ModelSyncTarget,
	modelsDirectory: string,
): Promise<"present" | "missing" | "conflict"> {
	try {
		const metadata = await lstat(modelPath(modelsDirectory, target.path));
		return metadata.isFile() && metadata.size === target.artifact.sizeBytes
			? "present"
			: "conflict";
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return "missing";
		throw error;
	}
}

async function removeModelTarget(path: string, modelsDirectory: string): Promise<void> {
	let metadata: Awaited<ReturnType<typeof lstat>>;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) {
			await assertModelAncestorInsideDirectory(path, modelsDirectory);
			return;
		}
		throw error;
	}
	if (!metadata.isFile()) {
		throw new Error("Force redownload can remove only a regular model file.");
	}
	const [resolvedModelsDirectory, resolvedPath] = await Promise.all([
		realpath(modelsDirectory),
		realpath(path),
	]);
	if (
		resolvedPath !== resolvedModelsDirectory &&
		!resolvedPath.startsWith(`${resolvedModelsDirectory}${sep}`)
	) {
		throw new Error(
			"Force redownload can remove only a model file inside the models directory.",
		);
	}
	await unlink(path);
}

async function assertModelAncestorInsideDirectory(
	path: string,
	modelsDirectory: string,
): Promise<void> {
	const resolvedModelsDirectory = await realpath(modelsDirectory);
	let ancestor = dirname(path);
	for (;;) {
		try {
			const resolvedAncestor = await realpath(ancestor);
			if (
				resolvedAncestor !== resolvedModelsDirectory &&
				!resolvedAncestor.startsWith(`${resolvedModelsDirectory}${sep}`)
			) {
				throw new Error(
					"Force redownload can remove only a model file inside the models directory.",
				);
			}
			return;
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) throw error;
		}
		ancestor = dirname(ancestor);
	}
}

function modelSnapshot(
	targets: readonly ModelSyncTarget[],
	options: {
		ready?: ReadonlySet<string>;
		active?: ReadonlyMap<string, number>;
		failures?: ReadonlyMap<string, string>;
		needsRedownload?: ReadonlySet<string>;
	} = {},
): ModelSyncSnapshot {
	return {
		models: targets.map((target) => {
			const activeBytes = options.active?.get(target.path);
			if (activeBytes !== undefined) {
				return {
					path: target.path,
					status: "downloading",
					downloadedBytes: Math.min(activeBytes, target.artifact.sizeBytes),
				};
			}
			if (options.ready?.has(target.path) === true) {
				return {
					path: target.path,
					status: "ready",
					downloadedBytes: target.artifact.sizeBytes,
				};
			}
			const error = options.failures?.get(target.path);
			if (error !== undefined) {
				return {
					path: target.path,
					status: "failed",
					downloadedBytes: 0,
					error,
				};
			}
			return {
				path: target.path,
				status:
					options.needsRedownload?.has(target.path) === true
						? "needs-redownload"
						: "not-downloaded",
				downloadedBytes: 0,
			};
		}),
	};
}

function validateRequest(value: unknown): ModelSyncRequest {
	const parsed = parseModelSyncRequest(value);
	if (parsed.ok) return parsed.value;
	throw modelSyncParseError(parsed.issue, false);
}

function validateVerificationRequest(value: unknown): ModelSyncTarget[] {
	const parsed = parseModelVerificationRequest(value);
	if (parsed.ok) return parsed.value.models;
	throw modelSyncParseError(parsed.issue, true);
}

function validateModels(
	value: unknown[],
	allowEmpty: boolean,
	maximum?: number,
): ModelSyncTarget[] {
	const parsed = parseModelSyncTargets(
		value,
		maximum === undefined ? { allowEmpty } : { allowEmpty, maximum },
	);
	if (parsed.ok) return parsed.value;
	throw modelSyncParseError(parsed.issue, false);
}

function mergeModelIdentities(
	recorded: ModelSyncTarget[],
	ready: ModelSyncTarget[],
): ModelSyncTarget[] {
	const identities = new Map(recorded.map((target) => [target.path, target] as const));
	for (const target of ready) identities.set(target.path, target);
	if (identities.size > MAX_MODEL_IDENTITIES) {
		throw new Error("Too many model artifact identities are recorded.");
	}
	return [...identities.values()];
}

function modelIdentity(target: ModelSyncTarget): string {
	const artifact = target.artifact;
	return `${artifact.provider}:${artifact.modelId}@${artifact.versionId} (${artifact.versionLabel})/${artifact.fileId} -> ${artifact.fileName}, ${artifact.sizeBytes} bytes`;
}

function modelSyncParseError(
	issue: ModelSyncParseIssue,
	verification: boolean,
): ModelSyncError {
	const message = {
		request: verification
			? "Invalid model verification request."
			: "Invalid model sync request.",
		credential: "Invalid model provider credential.",
		selection: "Select between 1 and 250 models to synchronize.",
		"duplicate-path": "Model sync paths must be unique.",
		target: "Invalid model sync target.",
		"civitai-target": "Invalid CivitAI model sync target.",
		"huggingface-target": "Invalid Hugging Face model sync target.",
	}[issue];
	return new ModelSyncError(message, 400);
}

function modelPath(modelsDirectory: string, relativePath: string): string {
	const path = resolve(modelsDirectory, relativePath);
	if (!path.startsWith(`${resolve(modelsDirectory)}${sep}`)) {
		throw new Error("Model path escapes the configured models directory.");
	}
	return path;
}

async function readManifest(path: string): Promise<ModelManifest | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return null;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("Stored model synchronization state is invalid.");
	}
	if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.models)) {
		throw new Error("Stored model synchronization state is invalid.");
	}
	try {
		const models = validateModels(value.models, true);
		if (!Array.isArray(value.identities) || typeof value.complete !== "boolean") {
			throw new Error();
		}
		const identities = validateModels(value.identities, true, MAX_MODEL_IDENTITIES);
		const identityByPath = new Map(
			identities.map((target) => [target.path, target] as const),
		);
		if (
			models.some((target) => {
				const identity = identityByPath.get(target.path);
				return identity === undefined || !sameModelSyncTarget(identity, target);
			})
		) {
			throw new Error();
		}
		return {
			models,
			identities,
			complete: value.complete,
		};
	} catch {
		throw new Error("Stored model synchronization state is invalid.");
	}
}

async function writeManifest(path: string, manifest: ModelManifest): Promise<void> {
	const temporary = `${path}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		temporary,
		`${JSON.stringify({ version: 2, ...manifest })}\n`,
		"utf8",
	);
	await rename(temporary, path);
}

async function downloadHuggingFace(
	runtimePython: string,
	target: ModelSyncTarget,
	token: string | undefined,
	stagingDirectory: string,
	onProgress: (bytes: number) => void,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	const child = Bun.spawn(
		[runtimePython, join(import.meta.dir, "huggingface-download.py")],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: huggingFaceEnvironment(stagingDirectory),
		},
	);
	child.stdin.write(
		JSON.stringify({
			repoId: target.artifact.modelId,
			revision: target.artifact.versionId,
			filename: target.artifact.fileId,
			directory: stagingDirectory,
			token: token ?? null,
		}),
	);
	child.stdin.end();
	const stdout = new Response(child.stdout).text();
	const stderr = readHuggingFaceOutput(child.stderr, onProgress);
	const abort = (): void => child.kill(9);
	signal.addEventListener("abort", abort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let exitCode: number;
	try {
		if (signal.aborted) abort();
		exitCode = await Promise.race([
			child.exited,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					child.kill(9);
					reject(new Error("Hugging Face download timed out."));
				}, DOWNLOAD_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
	}
	signal.throwIfAborted();
	const [output, diagnostics] = await Promise.all([stdout, stderr]);
	if (exitCode !== 0) {
		throw huggingFaceDownloadError(output, diagnostics, token);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(output);
	} catch {
		throw new Error("Hugging Face downloader returned invalid output.");
	}
	if (!isRecord(payload) || typeof payload.path !== "string") {
		throw new Error("Hugging Face downloader returned invalid output.");
	}
	const downloaded = resolve(payload.path);
	if (!downloaded.startsWith(`${resolve(stagingDirectory)}${sep}`)) {
		throw new Error("Hugging Face downloader returned an unsafe path.");
	}
	return downloaded;
}

async function readHuggingFaceOutput(
	stream: ReadableStream<Uint8Array>,
	onProgress: (bytes: number) => void,
): Promise<string | undefined> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let diagnostic: string | undefined;
	const lines = new ProcessOutputLineBuffer((line) => {
		const downloadedBytes = huggingFaceProgress(line);
		if (downloadedBytes !== null) {
			onProgress(downloadedBytes);
		} else if (line.trim().length > 0) {
			diagnostic = line.trim();
		}
	});
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			lines.write(text);
		}
		lines.write(decoder.decode());
		lines.flush();
		return diagnostic;
	} finally {
		reader.releaseLock();
	}
}

function huggingFaceProgress(line: string): number | null {
	try {
		const payload: unknown = JSON.parse(line);
		return isRecord(payload) &&
			Number.isSafeInteger(payload.downloadedBytes) &&
			Number(payload.downloadedBytes) >= 0
			? Number(payload.downloadedBytes)
			: null;
	} catch {
		return null;
	}
}

function huggingFaceEnvironment(stagingDirectory: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		HF_HOME: join(stagingDirectory, ".hf-cache"),
		HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
		HF_HUB_DISABLE_TELEMETRY: "1",
		HF_XET_HIGH_PERFORMANCE: "1",
	};
	for (const key of [
		"PATH",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"REQUESTS_CA_BUNDLE",
	] as const) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

async function downloadCivitai(
	target: ModelSyncTarget,
	token: string | undefined,
	stagingDirectory: string,
	onProgress: (bytes: number) => void,
	signal: AbortSignal,
): Promise<string> {
	const headers = new Headers({ Accept: "application/json" });
	if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
	const metadataResponse = await fetchWithSafeRedirects(
		new URL(
			`https://civitai.com/api/v1/model-versions/${encodeURIComponent(target.artifact.versionId)}`,
		),
		headers,
		signal,
	);
	if (!metadataResponse.ok) {
		throw await civitaiHttpError(metadataResponse, token);
	}
	const metadata: unknown = await metadataResponse.json().catch(() => null);
	const file = civitaiFile(metadata, target.artifact.modelId, target.artifact.fileId);
	if (file === null)
		throw new Error("CivitAI no longer provides the selected model file.");
	const downloadUrl = new URL(file.downloadUrl);
	if (
		downloadUrl.protocol !== "https:" ||
		downloadUrl.username ||
		downloadUrl.password
	) {
		throw new Error("CivitAI returned an insecure model download URL.");
	}
	const downloadHeaders = new Headers(headers);
	if (downloadUrl.origin !== "https://civitai.com") {
		downloadHeaders.delete("Authorization");
	}
	const response = await fetchWithSafeRedirects(downloadUrl, downloadHeaders, signal);
	if (!response.ok) {
		throw await civitaiHttpError(response, token);
	}
	if (response.body === null)
		throw new Error("CivitAI returned an empty model download.");

	const destination = join(stagingDirectory, "artifact");
	const handle = Bun.file(destination).writer();
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		for await (const chunk of response.body) {
			bytes += chunk.byteLength;
			if (bytes > target.artifact.sizeBytes) {
				throw new Error("CivitAI model size exceeded the selected artifact size.");
			}
			handle.write(chunk);
			hash.update(chunk);
			onProgress(bytes);
		}
	} finally {
		await handle.end();
	}
	if (file.sha256 !== null && hash.digest("hex") !== file.sha256) {
		throw new Error("CivitAI model checksum verification failed.");
	}
	return destination;
}

export async function fetchWithSafeRedirects(
	initialUrl: URL,
	initialHeaders: Headers,
	cancelSignal?: AbortSignal,
): Promise<Response> {
	let url = initialUrl;
	let headers = new Headers(initialHeaders);
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		let response: Response;
		try {
			cancelSignal?.throwIfAborted();
			response = await fetch(url, {
				headers,
				redirect: "manual",
				signal:
					cancelSignal === undefined
						? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
						: AbortSignal.any([cancelSignal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
			});
		} catch {
			if (cancelSignal?.aborted) throw cancelSignal.reason;
			throw new Error("Could not reach CivitAI.");
		}
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		const location = response.headers.get("location");
		if (location === null) throw new Error("CivitAI returned an invalid redirect.");
		const next = new URL(location, url);
		if (next.protocol !== "https:" || next.username || next.password) {
			throw new Error("CivitAI returned an insecure redirect.");
		}
		if (next.origin !== url.origin) {
			headers = new Headers(headers);
			headers.delete("Authorization");
		}
		url = next;
	}
	throw new Error("CivitAI returned too many redirects.");
}

function civitaiFile(
	value: unknown,
	modelId: string,
	fileId: string,
): { downloadUrl: string; sha256: string | null } | null {
	if (
		!isRecord(value) ||
		String(value.modelId) !== modelId ||
		!Array.isArray(value.files)
	) {
		return null;
	}
	for (const candidate of value.files) {
		if (!isRecord(candidate) || String(candidate.id) !== fileId) continue;
		if (typeof candidate.downloadUrl !== "string") return null;
		const hashes = isRecord(candidate.hashes) ? candidate.hashes : null;
		const sha256 = hashes?.SHA256;
		return {
			downloadUrl: candidate.downloadUrl,
			sha256:
				typeof sha256 === "string" && /^[0-9a-f]{64}$/iu.test(sha256)
					? sha256.toLowerCase()
					: null,
		};
	}
	return null;
}

function huggingFaceDownloadError(
	output: string,
	fallback: string | undefined,
	token: string | undefined,
): Error {
	let payload: unknown;
	try {
		payload = JSON.parse(output);
	} catch {
		payload = null;
	}
	if (isRecord(payload) && isRecord(payload.error)) {
		const status = payload.error.status;
		if (status === 401 || status === 403) {
			return providerHttpError("Hugging Face", status, token);
		}
		const message = payload.error.message;
		if (typeof message === "string" && message.length > 0) {
			return new Error(`Hugging Face download failed. ${redactToken(message, token)}`);
		}
	}
	return new Error(
		fallback
			? `Hugging Face download failed. ${redactToken(fallback, token)}`
			: "Hugging Face download failed.",
	);
}

function providerHttpError(
	provider: string,
	status: number,
	token: string | undefined,
): Error {
	if (status === 401 || status === 403) {
		return new Error(
			token === undefined
				? `${provider} authentication is required for this model. Configure its token in Kastard Settings.`
				: `${provider} rejected the token configured in Kastard. Check that it is valid and can access this model.`,
		);
	}
	if (status === 404) return new Error(`${provider} model file was not found.`);
	if (status === 429) return new Error(`${provider} rate limit was reached.`);
	return new Error(`${provider} returned HTTP ${status}.`);
}

async function civitaiHttpError(
	response: Response,
	token: string | undefined,
): Promise<Error> {
	if (response.status === 451) {
		const payload: unknown = await response.json().catch(() => null);
		if (isRecord(payload) && payload.code === "REGION_BLOCKED") {
			return new Error(
				"CivitAI access is blocked in this Worker's region due to legal restrictions. Use a Worker in a supported region.",
			);
		}
	}
	return providerHttpError("CivitAI", response.status, token);
}

function validateRootDirectory(value: string): string {
	if (!isAbsolute(value))
		throw new Error("KASTARD_COMFYUI_ROOT must be an absolute path.");
	const root = resolve(value);
	if (root === "/")
		throw new Error("KASTARD_COMFYUI_ROOT cannot be the filesystem root.");
	return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function userFacingError(
	error: unknown,
	token: string | undefined = undefined,
): string {
	return error instanceof Error && error.message.length > 0
		? redactToken(error.message, token)
		: "Unknown model synchronization error.";
}

function redactToken(message: string, token: string | undefined): string {
	return token === undefined ? message : message.split(token).join("[redacted]");
}
