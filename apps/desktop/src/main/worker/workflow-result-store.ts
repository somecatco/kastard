import { createHash, randomUUID } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	isWorkflowResultFile,
	parseWorkflowResultManifest,
	type WorkflowResultFile as WorkerResultFile,
	type WorkflowResultManifest as WorkerResultManifest,
} from "@kastard/common";
import type { WorkerSessionCredential, WorkflowJobFailure } from "./client";

const RESULT_REQUEST_TIMEOUT_MS = 15 * 60_000;
const RESULT_RETRY_DELAYS_MS = [250, 1_000] as const;
const JOB_METADATA_NAME = ".job.json";

export type WorkflowResultContext = {
	id: string;
	number: number;
	createdAt: number;
	prompt: Record<string, unknown>;
	extraData: Record<string, unknown>;
	clientId: string | null;
};

export type StoredWorkflowJob = WorkflowResultContext & {
	status: "completed" | "failed" | "canceled";
	completedAt: number;
	outputs: unknown;
	files: WorkerResultFile[];
	error?: WorkflowJobFailure;
};

export class WorkflowResultStore {
	private readonly jobs = new Map<string, StoredWorkflowJob>();
	private readonly unavailableFiles = new Map<string, Set<string>>();

	constructor(
		private readonly rootDirectory: string,
		private readonly legacyRootDirectory?: string,
		private readonly onRestoreFailure: () => Promise<void> = async () => {},
	) {}

	async initialize(): Promise<void> {
		await mkdir(this.rootDirectory, { recursive: true });
		await this.migrateLegacyResults();
		for (const entry of await readdir(this.rootDirectory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") && entry.name.endsWith(".staging")) {
				await rm(join(this.rootDirectory, entry.name), {
					recursive: true,
					force: true,
				});
				continue;
			}
			const job = await readStoredWorkflowJob(
				join(this.rootDirectory, entry.name),
				entry.name,
			);
			if (job !== null) this.jobs.set(job.id, job);
		}
	}

	list(): StoredWorkflowJob[] {
		return [...this.jobs.values()]
			.map((job) => this.visibleJob(job))
			.sort((left, right) => right.createdAt - left.createdAt);
	}

	get(jobId: string): StoredWorkflowJob | null {
		const job = this.jobs.get(jobId);
		return job === undefined ? null : this.visibleJob(job);
	}

	async restoreNativeFiles(signal?: AbortSignal): Promise<void> {
		let failed = false;
		for (const job of this.jobs.values()) {
			signal?.throwIfAborted();
			if (!(await this.restoreJobFiles(job, signal))) failed = true;
		}
		signal?.throwIfAborted();
		if (failed) void this.onRestoreFailure().catch(() => undefined);
	}

	private visibleJob(job: StoredWorkflowJob): StoredWorkflowJob {
		const unavailable = this.unavailableFiles.get(job.id);
		return unavailable === undefined
			? job
			: {
					...job,
					outputs: filterResultOutputs(job.outputs, (id) => !unavailable.has(id)),
				};
	}

	private async restoreJobFiles(
		job: StoredWorkflowJob,
		signal?: AbortSignal,
	): Promise<boolean> {
		const unavailable = new Set<string>();
		for (const file of job.files) {
			signal?.throwIfAborted();
			if (file.type === "output") continue;
			try {
				const source = join(this.rootDirectory, job.id, file.id, file.filename);
				const destination = join(
					dirname(dirname(this.rootDirectory)),
					file.type,
					"kastard",
					job.id,
					file.id,
					file.filename,
				);
				await mkdir(dirname(destination), { recursive: true });
				try {
					await link(source, destination);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const [original, existing] = await Promise.all([
						stat(source),
						lstat(destination),
					]);
					if (original.dev !== existing.dev || original.ino !== existing.ino) {
						unavailable.add(file.id);
					}
				}
			} catch {
				unavailable.add(file.id);
			}
		}
		if (unavailable.size === 0) this.unavailableFiles.delete(job.id);
		else this.unavailableFiles.set(job.id, unavailable);
		return unavailable.size === 0;
	}

	async collect(
		credential: WorkerSessionCredential,
		context: WorkflowResultContext,
		requestFetch: typeof fetch = fetch,
		signal?: AbortSignal,
	): Promise<void> {
		if (this.jobs.get(context.id)?.status === "completed") return;
		let lastError: unknown = new Error("Kastard result collection failed.");
		for (let attempt = 0; attempt <= RESULT_RETRY_DELAYS_MS.length; attempt += 1) {
			try {
				signal?.throwIfAborted();
				await this.collectOnce(credential, context, requestFetch, signal);
				return;
			} catch (error) {
				lastError = error;
				if (signal?.aborted) throw error;
				const retryDelay = RESULT_RETRY_DELAYS_MS[attempt];
				if (retryDelay === undefined) break;
				await delay(retryDelay);
			}
		}
		throw lastError;
	}

	private async collectOnce(
		credential: WorkerSessionCredential,
		context: WorkflowResultContext,
		requestFetch: typeof fetch,
		signal?: AbortSignal,
	): Promise<void> {
		const manifest = await fetchManifest(credential, context.id, requestFetch, signal);
		const files = new Map(manifest.files.map((file) => [file.id, file]));
		if (files.size !== manifest.files.length) {
			throw new Error("The Worker returned duplicate result files.");
		}
		await this.publish(
			context.id,
			async (staging) => {
				for (const file of manifest.files) {
					signal?.throwIfAborted();
					await downloadResultFile(
						credential,
						context.id,
						file,
						join(staging, file.id, file.filename),
						requestFetch,
						signal,
					);
				}
				const job: StoredWorkflowJob = {
					...context,
					status: "completed",
					completedAt: Date.now(),
					outputs: localOutputs(manifest.outputs, context.id, files),
					files: manifest.files,
				};
				return job;
			},
			signal,
		);
	}

	async recordFailure(
		context: WorkflowResultContext,
		error: WorkflowJobFailure,
	): Promise<void> {
		if (this.jobs.has(context.id)) return;
		const job: StoredWorkflowJob = {
			...context,
			status: "failed",
			completedAt: Date.now(),
			outputs: {},
			files: [],
			error,
		};
		await this.publish(context.id, async () => job);
	}

	async recordCanceled(context: WorkflowResultContext): Promise<void> {
		if (this.jobs.has(context.id)) return;
		const job: StoredWorkflowJob = {
			...context,
			status: "canceled",
			completedAt: Date.now(),
			outputs: {},
			files: [],
		};
		await this.publish(context.id, async () => job);
	}

	private async publish(
		jobId: string,
		prepare: (staging: string) => Promise<StoredWorkflowJob>,
		signal?: AbortSignal,
	): Promise<void> {
		const staging = join(this.rootDirectory, `.${jobId}-${randomUUID()}.staging`);
		const destination = join(this.rootDirectory, jobId);
		try {
			await mkdir(staging, { recursive: true });
			const job = await prepare(staging);
			signal?.throwIfAborted();
			await writeFile(join(staging, JOB_METADATA_NAME), JSON.stringify(job));
			signal?.throwIfAborted();
			await rename(staging, destination);
			// Verified files remain durable even when a native path is unavailable.
			const restored = await this.restoreJobFiles(job);
			this.jobs.set(job.id, job);
			if (!restored) void this.onRestoreFailure().catch(() => undefined);
		} catch (error) {
			await rm(staging, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	async deleteHistory(ids: string[]): Promise<void> {
		for (const id of ids) {
			if (!this.jobs.has(id)) continue;
			await rm(join(this.rootDirectory, id, JOB_METADATA_NAME), { force: true });
			this.jobs.delete(id);
			this.unavailableFiles.delete(id);
		}
	}

	async clearHistory(): Promise<void> {
		await this.deleteHistory([...this.jobs.keys()]);
	}

	private async migrateLegacyResults(): Promise<void> {
		if (
			this.legacyRootDirectory === undefined ||
			this.legacyRootDirectory === this.rootDirectory
		) {
			return;
		}
		const entries = await readdir(this.legacyRootDirectory, {
			withFileTypes: true,
		}).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const source = join(this.legacyRootDirectory, entry.name);
			let staging: string | undefined;
			try {
				const job = await readStoredWorkflowJob(source, entry.name);
				if (job === null) continue;
				const destination = join(this.rootDirectory, job.id);
				const destinationExists = await lstat(destination).then(
					() => true,
					() => false,
				);
				if (destinationExists) continue;
				staging = join(this.rootDirectory, `.${job.id}-${randomUUID()}.staging`);
				await mkdir(staging, { recursive: true });
				for (const file of job.files) {
					const target = join(staging, file.id, file.filename);
					await mkdir(dirname(target), { recursive: true });
					await link(join(source, "files", file.id, file.filename), target);
				}
				await writeFile(join(staging, JOB_METADATA_NAME), JSON.stringify(job));
				await rename(staging, destination);
				await rm(source, { recursive: true, force: true }).catch(() => undefined);
			} catch {
				if (staging !== undefined) {
					await rm(staging, { recursive: true, force: true }).catch(() => undefined);
				}
			}
		}
	}
}

async function readStoredWorkflowJob(
	directory: string,
	expectedId: string,
): Promise<StoredWorkflowJob | null> {
	for (const filename of [JOB_METADATA_NAME, "job.json"]) {
		try {
			const value: unknown = JSON.parse(
				await readFile(join(directory, filename), "utf8"),
			);
			if (isStoredWorkflowJob(value) && value.id === expectedId) {
				const files = new Map(value.files.map((file) => [file.id, file]));
				return {
					...value,
					outputs: localOutputs(
						filterResultOutputs(value.outputs, (id) => files.has(id)) ?? {},
						value.id,
						files,
					),
				};
			}
		} catch {}
	}
	return null;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchManifest(
	credential: WorkerSessionCredential,
	jobId: string,
	requestFetch: typeof fetch,
	signal?: AbortSignal,
): Promise<WorkerResultManifest> {
	const response = await requestFetch(
		`${credential.workerApiUrl}/workflow-jobs/${encodeURIComponent(jobId)}/results`,
		{
			cache: "no-store",
			headers: sessionHeaders(credential),
			signal: resultRequestSignal(signal),
		},
	);
	if (!response.ok) throw new Error(`The Worker returned HTTP ${response.status}.`);
	const value: unknown = await response.json().catch(() => null);
	const manifest = parseWorkflowResultManifest(value);
	if (manifest === null || manifest.id !== jobId) {
		throw new Error("The Worker returned an invalid result manifest.");
	}
	return manifest;
}

async function downloadResultFile(
	credential: WorkerSessionCredential,
	jobId: string,
	metadata: WorkerResultFile,
	destination: string,
	requestFetch: typeof fetch,
	signal?: AbortSignal,
): Promise<void> {
	if (!isSafeResultFilename(metadata.filename)) {
		throw new Error("The Worker returned an invalid result filename.");
	}
	const response = await requestFetch(
		`${credential.workerApiUrl}/workflow-jobs/${encodeURIComponent(jobId)}/results/${metadata.id}`,
		{
			cache: "no-store",
			headers: sessionHeaders(credential),
			signal: resultRequestSignal(signal),
		},
	);
	if (!response.ok || response.body === null) {
		throw new Error(`The Worker returned HTTP ${response.status} for a result file.`);
	}
	await mkdir(dirname(destination), { recursive: true });
	const handle = await open(destination, "w");
	const hash = createHash("sha256");
	let size = 0;
	try {
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			hash.update(value);
			size += value.byteLength;
			await handle.write(value);
		}
	} finally {
		await handle.close();
	}
	if (size !== metadata.size || hash.digest("hex") !== metadata.sha256) {
		throw new Error("Worker result verification failed.");
	}
}

function sessionHeaders(credential: WorkerSessionCredential): Record<string, string> {
	return { Authorization: `Bearer ${credential.sessionCapability}` };
}

function resultRequestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(RESULT_REQUEST_TIMEOUT_MS);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function filterResultOutputs(
	value: unknown,
	keepFile: (id: string) => boolean,
): unknown {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => {
			const output = filterResultOutputs(entry, keepFile);
			return output === undefined ? [] : [output];
		});
	}
	if (!isRecord(value)) return value;
	if (typeof value.kastard_file_id === "string" && !keepFile(value.kastard_file_id))
		return undefined;
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, entry]) => {
			const output = filterResultOutputs(entry, keepFile);
			return output === undefined ? [] : [[key, output]];
		}),
	);
}

function localOutputs(
	value: unknown,
	jobId: string,
	files: ReadonlyMap<string, WorkerResultFile>,
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => localOutputs(entry, jobId, files));
	}
	if (!isRecord(value)) return value;
	const entries = Object.entries(value).map(([key, entry]) => [
		key,
		localOutputs(entry, jobId, files),
	]);
	if (typeof value.kastard_file_id !== "string") return Object.fromEntries(entries);
	const file = files.get(value.kastard_file_id);
	if (file === undefined) {
		throw new Error("The Worker result output references an unknown file.");
	}
	return {
		...Object.fromEntries(entries),
		filename: file.filename,
		subfolder: `kastard/${jobId}/${value.kastard_file_id}`,
		type: file.type,
	};
}

function isStoredWorkflowJob(value: unknown): value is StoredWorkflowJob {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		isCanonicalUuid(value.id) &&
		(value.status === "completed" ||
			value.status === "failed" ||
			value.status === "canceled") &&
		typeof value.number === "number" &&
		typeof value.createdAt === "number" &&
		typeof value.completedAt === "number" &&
		isRecord(value.prompt) &&
		isRecord(value.extraData) &&
		(value.clientId === null || typeof value.clientId === "string") &&
		Array.isArray(value.files) &&
		value.files.every(
			(file) => isWorkflowResultFile(file) && isSafeResultFilename(file.filename),
		) &&
		"outputs" in value
	);
}

function isSafeResultFilename(value: string): boolean {
	return basename(value) === value && !value.includes("\\");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
		value,
	);
}
