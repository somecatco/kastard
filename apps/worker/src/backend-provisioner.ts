import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, mkdirSync } from "node:fs";
import {
	access,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
	type BackendPhase,
	type BackendState,
	type BackendTarget,
	backendTargetIssue,
	isWorkerRuntime,
	parseBackendTarget,
	type WorkerRuntime,
} from "@kastard/common";
import { Unzip, UnzipInflate } from "fflate";
import type { WorkerLogStore } from "./worker-log";

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;

export type {
	BackendPhase,
	BackendState,
	BackendTarget,
	WorkerRuntime,
} from "@kastard/common";

export interface BackendProvisionerApi {
	getState(): BackendState;
	prepare(target: unknown): BackendState;
}

type DownloadArtifact = (
	url: string,
	destination: string,
	onProgress: (progress: number) => void,
) => Promise<string>;

type BackendProvisionerOptions = {
	rootDirectory: string;
	runtime: WorkerRuntime;
	logs: WorkerLogStore;
	onReady?: () => void | Promise<void>;
	/** Stops Worker ComfyUI so an installed backend can be replaced by another version. */
	onReplace?: () => void | Promise<void>;
	isBusy?: () => boolean;
	downloadArtifact?: DownloadArtifact;
	now?: () => number;
};

type ReadyStamp = {
	schemaVersion: 1;
	version: string;
	/** A release tag can be rebuilt, so the version alone does not identify the bytes. */
	sha256: string;
	runtime: WorkerRuntime;
};

export class BackendProvisioningError extends Error {
	constructor(
		message: string,
		readonly statusCode: 400 | 409,
	) {
		super(message);
	}
}

export class BackendProvisionerUnavailableError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

export class BackendProvisionerController implements BackendProvisionerApi {
	private provisioner: BackendProvisionerApi | null = null;
	private error = "Backend provisioning is initializing.";
	private retryable = true;

	attach(provisioner: BackendProvisionerApi): void {
		this.provisioner = provisioner;
	}

	fail(error: string): void {
		this.error = error;
		this.retryable = false;
		this.provisioner = null;
	}

	getState(): BackendState {
		return this.current().getState();
	}

	prepare(target: unknown): BackendState {
		return this.current().prepare(target);
	}

	private current(): BackendProvisionerApi {
		if (this.provisioner === null) {
			throw new BackendProvisionerUnavailableError(this.error, this.retryable);
		}
		return this.provisioner;
	}
}

export class BackendProvisioner implements BackendProvisionerApi {
	private state: BackendState;
	private readonly rootDirectory: string;
	private readonly runtime: WorkerRuntime;
	private readonly logs: WorkerLogStore;
	private readonly downloadArtifact: DownloadArtifact;
	private readonly onReady: () => void | Promise<void>;
	private readonly onReplace: () => void | Promise<void>;
	private readonly isBusy: () => boolean;
	private readonly now: () => number;
	/** What a run would publish over; `sha256` is null when the stamp is unreadable. */
	private installed: { version: string; sha256: string | null } | null;
	private preparationStartedAt = 0;
	private phaseStartedAt = 0;

	private constructor(
		options: BackendProvisionerOptions,
		state: BackendState,
		installed: { version: string; sha256: string | null } | null,
	) {
		this.rootDirectory = options.rootDirectory;
		this.runtime = options.runtime;
		this.logs = options.logs;
		this.downloadArtifact = options.downloadArtifact ?? downloadArtifact;
		this.onReady = options.onReady ?? (() => {});
		this.onReplace = options.onReplace ?? (() => {});
		this.isBusy = options.isBusy ?? (() => false);
		this.now = options.now ?? Date.now;
		this.state = state;
		this.installed = installed;
	}

	static async create(options: BackendProvisionerOptions): Promise<BackendProvisioner> {
		const rootDirectory = validateRootDirectory(options.rootDirectory);
		await mkdir(rootDirectory, { recursive: true });
		await access(rootDirectory, constants.R_OK | constants.W_OK);
		await removeAbandonedBackendData(rootDirectory, options.logs);
		const stamp = await readReadyStamp(rootDirectory);
		const ready = await restoreReadyState(rootDirectory, options.runtime, stamp);
		// A backend on disk has to be stopped before it is republished even when its
		// stamp is unreadable, so this follows the directory rather than the state.
		const installed = (await pathExists(join(rootDirectory, "backend")))
			? { version: stamp?.version ?? "unknown", sha256: stamp?.sha256 ?? null }
			: null;
		return new BackendProvisioner({ ...options, rootDirectory }, ready, installed);
	}

	getState(): BackendState {
		if (this.state.status !== "preparing") return this.state;
		const now = this.now();
		return {
			...this.state,
			phaseElapsedMs: Math.max(0, now - this.phaseStartedAt),
			totalElapsedMs: Math.max(0, now - this.preparationStartedAt),
		};
	}

	prepare(value: unknown): BackendState {
		const target = validateTarget(value);
		if (this.state.status === "preparing") {
			if (this.state.targetVersion === target.version) return this.state;
			throw new BackendProvisioningError(
				`ComfyUI ${this.state.targetVersion} is already being prepared.`,
				409,
			);
		}
		// A release tag can be rebuilt, so the same version can still be different bytes;
		// only an exact match is already prepared.
		if (
			this.state.status === "ready" &&
			this.state.version === target.version &&
			this.installed?.sha256 === target.sha256
		) {
			return this.state;
		}
		// Tracked separately from the state because a failed replacement leaves the
		// installed backend in place while the state reads "failed". Whatever is
		// installed gets republished over, the same version included, so ComfyUI has to
		// stop first either way.
		const replaced = this.installed?.version ?? null;
		if (replaced !== null && this.isBusy()) {
			throw new BackendProvisioningError(
				`ComfyUI ${replaced} cannot be replaced while a workflow is running.`,
				409,
			);
		}
		if (this.state.status === "failed" && !this.state.retryable) {
			throw new BackendProvisioningError(this.state.error, 409);
		}
		this.preparationStartedAt = this.now();
		this.phaseStartedAt = this.preparationStartedAt;
		this.setPreparing(target.version, "download", 0);
		void this.run(target, replaced);
		return this.getState();
	}

	private async run(
		target: BackendTarget,
		replacedVersion: string | null,
	): Promise<void> {
		const staging = join(this.rootDirectory, `.backend-staging-${randomUUID()}`);
		const artifactDirectory = backendArtifactDirectory(this.rootDirectory);
		const artifact = backendArtifactPath(this.rootDirectory, target);
		const download = join(artifactDirectory, `.download-${randomUUID()}.partial`);
		let retryable = true;
		try {
			await this.createDataDirectories();
			await mkdir(artifactDirectory, { recursive: true });
			const candidate = (await pathExists(artifact)) ? artifact : download;
			let actualChecksum: string;
			if (candidate === artifact) {
				this.logs.write(
					"info",
					`Reusing the cached ComfyUI ${target.version} archive.`,
				);
				this.setPreparing(target.version, "download", 100);
				this.setPreparing(target.version, "verify", 0);
				actualChecksum = await hashArtifact(artifact);
			} else {
				this.logs.write("info", `Downloading ComfyUI ${target.version}.`);
				actualChecksum = await this.downloadArtifact(
					target.archiveUrl,
					download,
					(progress) => {
						this.setPreparing(target.version, "download", progress);
					},
				);
				this.setPreparing(target.version, "verify", 0);
			}

			try {
				assertChecksum(actualChecksum, target.sha256);
			} catch (error) {
				await rm(candidate, { force: true });
				throw error;
			}
			this.setPreparing(target.version, "verify", 100);
			if (candidate === download) await rename(download, artifact);

			this.setPreparing(target.version, "extract", 0);
			await mkdir(staging, { recursive: true });
			await extractZip(artifact, staging);
			this.setPreparing(target.version, "extract", 100);

			retryable = false;
			try {
				await access(join(staging, "main.py"));
			} catch (error) {
				throw new Error(
					`ComfyUI ${target.version} is incomplete because main.py is unavailable. ${userFacingError(error)}`,
				);
			}
			retryable = true;

			await writeReadyStamp(staging, target, this.runtime);
			const backendDirectory = join(this.rootDirectory, "backend");
			if (replacedVersion !== null) {
				// A workflow can be submitted while the replacement downloads, so the
				// installed backend is only given up once it is still idle here.
				if (this.isBusy()) {
					throw new Error(
						`ComfyUI ${replacedVersion} cannot be replaced while a workflow is running.`,
					);
				}
				this.logs.write(
					"info",
					`Stopping Worker ComfyUI to replace ComfyUI ${replacedVersion} with ${target.version}.`,
				);
				await this.onReplace();
			}
			await publishBackend(staging, backendDirectory);
			this.installed = { version: target.version, sha256: target.sha256 };
			await writeRootReadyStamp(this.rootDirectory, target, this.runtime, this.logs);
			this.finishPhase("completed");
			this.state = { status: "ready", version: target.version, runtime: this.runtime };
			this.logs.write(
				"info",
				`ComfyUI ${target.version} backend is prepared after ${formatDuration(this.now() - this.preparationStartedAt)}.`,
			);
		} catch (error) {
			const message = userFacingError(error);
			this.finishPhase("failed");
			this.state = {
				status: "failed",
				targetVersion: target.version,
				error: message,
				retryable,
				runtime: this.runtime,
			};
			this.logs.write(
				"error",
				`ComfyUI ${target.version} preparation failed: ${message}`,
			);
			try {
				await Promise.all([
					rm(staging, { recursive: true, force: true }),
					rm(download, { force: true }),
				]);
			} catch (cleanupError) {
				this.logs.write(
					"error",
					`Could not remove backend staging data: ${userFacingError(cleanupError)}`,
				);
			}
			return;
		}
		try {
			await this.onReady();
		} catch (error) {
			this.logs.write(
				"error",
				`Backend ready handler failed: ${userFacingError(error)}`,
			);
		}
	}

	private async createDataDirectories(): Promise<void> {
		await Promise.all(
			["models", "custom_nodes", "input", "output", "temp", "user"].map((name) =>
				mkdir(join(this.rootDirectory, name), { recursive: true }),
			),
		);
	}

	private setPreparing(
		targetVersion: string,
		phase: BackendPhase,
		progress: number,
	): void {
		const now = this.now();
		if (this.state.status === "preparing" && this.state.phase !== phase) {
			this.finishPhase("completed", now);
			this.phaseStartedAt = now;
		}
		this.state = {
			status: "preparing",
			targetVersion,
			phase,
			progress: Math.max(0, Math.min(100, Math.round(progress))),
			phaseElapsedMs: Math.max(0, now - this.phaseStartedAt),
			totalElapsedMs: Math.max(0, now - this.preparationStartedAt),
			runtime: this.runtime,
		};
	}

	private finishPhase(outcome: "completed" | "failed", now = this.now()): void {
		if (this.state.status !== "preparing") return;
		this.logs.write(
			outcome === "completed" ? "info" : "error",
			`${backendPhaseLabel(this.state.phase)} ${outcome} after ${formatDuration(now - this.phaseStartedAt)}.`,
		);
	}
}

export async function readWorkerRuntime(path: string): Promise<WorkerRuntime> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!isWorkerRuntime(value)) throw new Error("Invalid Worker runtime manifest.");
	return {
		...(value.computeBackend === "cpu"
			? { computeBackend: "cpu" as const, cudaVersion: null }
			: { cudaVersion: value.cudaVersion }),
		pythonVersion: value.pythonVersion,
		torchVersion: value.torchVersion,
		torchvisionVersion: value.torchvisionVersion,
		torchaudioVersion: value.torchaudioVersion,
		uvVersion: value.uvVersion,
	};
}

function validateRootDirectory(value: string): string {
	if (!isAbsolute(value))
		throw new Error("KASTARD_COMFYUI_ROOT must be an absolute path.");
	const root = resolve(value);
	if (root === "/")
		throw new Error("KASTARD_COMFYUI_ROOT cannot be the filesystem root.");
	return root;
}

function validateTarget(value: unknown): BackendTarget {
	const target = parseBackendTarget(value);
	if (target !== null) return target;
	const message = {
		target: "Invalid ComfyUI target.",
		version: "Invalid ComfyUI version.",
		"archive-url": "Invalid ComfyUI archive URL.",
		checksum: "Invalid ComfyUI checksum.",
	}[backendTargetIssue(value) ?? "target"];
	throw new BackendProvisioningError(message, 400);
}

async function downloadArtifact(
	url: string,
	destination: string,
	onProgress: (progress: number) => void,
): Promise<string> {
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok || response.body === null) {
		throw new Error(`Download failed with HTTP ${response.status}.`);
	}
	const expectedLength = Number(response.headers.get("content-length"));
	const writer = Bun.file(destination).writer();
	const hash = createHash("sha256");
	let received = 0;
	try {
		for await (const chunk of response.body) {
			received += chunk.byteLength;
			writer.write(chunk);
			hash.update(chunk);
			if (Number.isFinite(expectedLength) && expectedLength > 0) {
				onProgress((received / expectedLength) * 100);
			}
		}
	} finally {
		await writer.end();
	}
	onProgress(100);
	return hash.digest("hex");
}

async function hashArtifact(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function assertChecksum(actual: string, expected: string): void {
	if (actual !== expected) {
		throw new Error(`Checksum mismatch. Expected ${expected}, received ${actual}.`);
	}
}

async function extractZip(archive: string, target: string): Promise<void> {
	const writes: Promise<void>[] = [];
	const unzip = new Unzip((file) => {
		if (file.name.endsWith("/")) return;
		const relative = file.name.split("/").slice(1).join("/");
		if (relative.length === 0) return;
		const output = safeArchivePath(target, relative);
		mkdirSync(dirname(output), { recursive: true });
		const writer = Bun.file(output).writer();
		const endWriter = (): Promise<void> =>
			Promise.resolve(writer.end()).then(() => undefined);
		writes.push(
			new Promise<void>((resolveWrite, rejectWrite) => {
				let settled = false;
				file.ondata = (error, data, final) => {
					if (settled) return;
					if (error) {
						settled = true;
						void endWriter().then(
							() => rejectWrite(error),
							() => rejectWrite(error),
						);
						return;
					}
					try {
						writer.write(data);
					} catch (writeError) {
						settled = true;
						file.terminate();
						void endWriter().then(
							() => rejectWrite(writeError),
							() => rejectWrite(writeError),
						);
						return;
					}
					if (final) {
						settled = true;
						void endWriter().then(resolveWrite, rejectWrite);
					}
				};
				file.start();
			}),
		);
	});
	unzip.register(UnzipInflate);
	for await (const chunk of createReadStream(archive)) unzip.push(chunk, false);
	unzip.push(new Uint8Array(), true);
	await Promise.all(writes);
}

function safeArchivePath(root: string, entry: string): string {
	if (isAbsolute(entry) || entry.split(/[\\/]/u).includes("..")) {
		throw new Error("The ComfyUI archive contains an unsafe path.");
	}
	const output = resolve(root, entry);
	if (output !== root && !output.startsWith(`${root}${sep}`)) {
		throw new Error("The ComfyUI archive contains an unsafe path.");
	}
	return output;
}

async function removeAbandonedBackendData(
	rootDirectory: string,
	logs: WorkerLogStore,
): Promise<void> {
	const stagingPattern =
		/^\.backend-staging-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
	for (const entry of await readdir(rootDirectory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name === "backend.previous") {
			await resolveInterruptedSwap(rootDirectory, logs);
			continue;
		}
		if (!stagingPattern.test(entry.name)) continue;
		try {
			await rm(join(rootDirectory, entry.name), { recursive: true, force: true });
			logs.write("info", `Removed abandoned backend staging data: ${entry.name}.`);
		} catch (error) {
			logs.write(
				"error",
				`Could not remove abandoned backend staging data ${entry.name}: ${userFacingError(error)}`,
			);
		}
	}
	const artifactDirectory = backendArtifactDirectory(rootDirectory);
	const artifacts = await readdir(artifactDirectory, { withFileTypes: true }).catch(
		(error: unknown) => {
			if (isErrorCode(error, "ENOENT")) return [];
			throw error;
		},
	);
	const partialPattern = /^\.download-[0-9a-f-]+\.partial$/u;
	for (const entry of artifacts) {
		if (!entry.isFile() || !partialPattern.test(entry.name)) continue;
		try {
			await rm(join(artifactDirectory, entry.name), { force: true });
			logs.write("info", `Removed abandoned backend download: ${entry.name}.`);
		} catch (error) {
			logs.write(
				"error",
				`Could not remove abandoned backend download ${entry.name}: ${userFacingError(error)}`,
			);
		}
	}
}

/**
 * A crash between the two renames of `publishBackend` leaves the move-aside copy as the
 * only installed backend, and the root ready stamp still describes it.
 */
async function resolveInterruptedSwap(
	rootDirectory: string,
	logs: WorkerLogStore,
): Promise<void> {
	const previous = join(rootDirectory, "backend.previous");
	const backendDirectory = join(rootDirectory, "backend");
	try {
		if (await pathExists(backendDirectory)) {
			await rm(previous, { recursive: true, force: true });
			return;
		}
		await rename(previous, backendDirectory);
		logs.write(
			"info",
			"Restored the backend left behind by an interrupted replacement.",
		);
	} catch (error) {
		logs.write(
			"error",
			`Could not resolve an interrupted backend swap: ${userFacingError(error)}`,
		);
	}
}

/**
 * Swaps a staged backend in without leaving the Worker without one: the installed
 * backend is only deleted after the replacement is in place, and is restored when the
 * swap fails.
 */
async function publishBackend(
	staging: string,
	backendDirectory: string,
): Promise<void> {
	const previous = `${backendDirectory}.previous`;
	await rm(previous, { recursive: true, force: true });
	const installed = await pathExists(backendDirectory);
	if (installed) await rename(backendDirectory, previous);
	try {
		await rename(staging, backendDirectory);
	} catch (error) {
		if (installed && !(await pathExists(backendDirectory))) {
			await rename(previous, backendDirectory);
		}
		throw error;
	}
	await rm(previous, { recursive: true, force: true });
}

function backendArtifactDirectory(rootDirectory: string): string {
	return join(rootDirectory, ".kastard", "backend-artifacts");
}

function backendArtifactPath(rootDirectory: string, target: BackendTarget): string {
	return join(
		backendArtifactDirectory(rootDirectory),
		`${target.version}-${target.sha256}.zip`,
	);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

function isErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function backendPhaseLabel(phase: BackendPhase): string {
	return {
		download: "Backend download",
		verify: "Backend checksum verification",
		extract: "Backend extraction",
	}[phase];
}

function formatDuration(durationMs: number): string {
	return `${Math.max(0, durationMs) / 1_000}s`;
}

async function restoreReadyState(
	rootDirectory: string,
	runtime: WorkerRuntime,
	stamp: ReadyStamp | null,
): Promise<BackendState> {
	const backendDirectory = join(rootDirectory, "backend");
	try {
		await access(backendDirectory);
	} catch {
		return { status: "not-installed", runtime };
	}

	if (stamp === null) {
		return {
			status: "failed",
			targetVersion: "unknown",
			error:
				"The existing backend installation is incomplete. Retry backend preparation.",
			retryable: true,
			runtime,
		};
	}
	try {
		await access(join(backendDirectory, "main.py"));
	} catch {
		return {
			status: "failed",
			targetVersion: stamp.version,
			error:
				"The existing backend installation is incomplete. Retry backend preparation.",
			retryable: true,
			runtime,
		};
	}
	return { status: "ready", version: stamp.version, runtime };
}

async function readReadyStamp(rootDirectory: string): Promise<ReadyStamp | null> {
	for (const path of [
		join(rootDirectory, "backend", ".kastard-backend.json"),
		join(rootDirectory, ".kastard-backend.json"),
	]) {
		try {
			const value: unknown = JSON.parse(await readFile(path, "utf8"));
			if (isReadyStamp(value)) return value;
		} catch {}
	}
	return null;
}

async function writeReadyStamp(
	directory: string,
	target: BackendTarget,
	runtime: WorkerRuntime,
): Promise<void> {
	const stamp: ReadyStamp = {
		schemaVersion: 1,
		version: target.version,
		sha256: target.sha256,
		runtime,
	};
	const path = join(directory, ".kastard-backend.json");
	const staging = `${path}.tmp`;
	await writeFile(staging, `${JSON.stringify(stamp, null, 2)}\n`);
	await rename(staging, path);
}

async function writeRootReadyStamp(
	rootDirectory: string,
	target: BackendTarget,
	runtime: WorkerRuntime,
	logs: WorkerLogStore,
): Promise<void> {
	try {
		await writeReadyStamp(rootDirectory, target, runtime);
	} catch (error) {
		logs.write(
			"error",
			`Could not update the root backend stamp: ${userFacingError(error)}`,
		);
	}
}

function isReadyStamp(value: unknown): value is ReadyStamp {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		typeof value.version === "string" &&
		typeof value.sha256 === "string" &&
		isWorkerRuntime(value.runtime)
	);
}

function userFacingError(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) return error.message;
	return "Unknown backend preparation error.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
