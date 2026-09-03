import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
	collectWorkflowInputStringLeaves,
	type WorkflowInputFailure,
	type WorkflowInputManifestEntry,
	type WorkflowInputProblem,
	type WorkflowInputReference,
} from "@kastard/common";

const MAX_WORKFLOW_INPUT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_WORKFLOW_INPUT_JOB_BYTES = 1024 * 1024 * 1024;
const MAX_WORKFLOW_INPUT_SNAPSHOT_BYTES = 4 * 1024 * 1024 * 1024;

const OBJECT_INFO_TIMEOUT_MS = 10_000;

export type {
	WorkflowInputFailure,
	WorkflowInputManifestEntry,
	WorkflowInputProblem,
	WorkflowInputReference,
} from "@kastard/common";

export type WorkflowInputSnapshotEntry = WorkflowInputManifestEntry & {
	path: string;
};

export type WorkflowInputSnapshot = {
	prompt: Record<string, unknown>;
	inputs: WorkflowInputSnapshotEntry[];
};

type SnapshotStoreOptions = {
	dataDirectory: string;
	rootDirectory: string;
	getRuntimeUrl: () => string | null;
	requestFetch?: typeof fetch;
	maxFileBytes?: number;
	maxJobBytes?: number;
	maxTotalBytes?: number;
};

type ResolvedReference = {
	path: string;
	name: string;
	reference: WorkflowInputReference;
};

export class WorkflowInputSnapshotError extends Error {
	constructor(readonly failure: WorkflowInputFailure) {
		super(failure.message);
	}
}

export class WorkflowInputSnapshotStore {
	private readonly requestFetch: typeof fetch;
	private readonly maxFileBytes: number;
	private readonly maxJobBytes: number;
	private readonly maxTotalBytes: number;
	private operation = Promise.resolve();
	private totalBytes = 0;
	private readonly snapshotBytes = new Map<string, number>();
	private nodeDefinitions: Record<string, unknown> | null = null;

	constructor(private readonly options: SnapshotStoreOptions) {
		this.requestFetch = options.requestFetch ?? fetch;
		this.maxFileBytes = options.maxFileBytes ?? MAX_WORKFLOW_INPUT_FILE_BYTES;
		this.maxJobBytes = options.maxJobBytes ?? MAX_WORKFLOW_INPUT_JOB_BYTES;
		this.maxTotalBytes = options.maxTotalBytes ?? MAX_WORKFLOW_INPUT_SNAPSHOT_BYTES;
	}

	initialize(): Promise<void> {
		return this.lock(async () => {
			await rm(this.options.rootDirectory, { recursive: true, force: true });
			await mkdir(this.options.rootDirectory, { recursive: true });
			this.snapshotBytes.clear();
			this.totalBytes = 0;
		});
	}

	create(
		jobId: string,
		prompt: Record<string, unknown>,
	): Promise<WorkflowInputSnapshot> {
		return this.lock(() => this.createSnapshot(jobId, prompt));
	}

	cleanup(jobId: string): Promise<void> {
		return this.lock(async () => {
			await rm(join(this.options.rootDirectory, jobId), {
				recursive: true,
				force: true,
			});
			const bytes = this.snapshotBytes.get(jobId) ?? 0;
			this.snapshotBytes.delete(jobId);
			this.totalBytes = Math.max(0, this.totalBytes - bytes);
		});
	}

	private async createSnapshot(
		jobId: string,
		prompt: Record<string, unknown>,
	): Promise<WorkflowInputSnapshot> {
		const copiedPrompt = clonePrompt(prompt);
		const references = await this.resolveReferences(copiedPrompt);
		const temporaryDirectory = join(
			this.options.rootDirectory,
			`.tmp-${jobId}-${randomUUID()}`,
		);
		const targetDirectory = join(this.options.rootDirectory, jobId);
		await mkdir(temporaryDirectory, { recursive: true });
		try {
			const inputs: WorkflowInputSnapshotEntry[] = [];
			const bySource = new Map<string, WorkflowInputSnapshotEntry>();
			let totalBytes = 0;
			for (const resolved of references) {
				const sourceId = `${resolved.path}\0${resolved.name}`;
				const existing = bySource.get(sourceId);
				if (existing !== undefined) {
					existing.references.push(resolved.reference);
					continue;
				}
				const source = await stat(resolved.path).catch(() => null);
				if (source === null || !source.isFile()) {
					throw inputError("missing", resolved);
				}
				const reservedJobBytes = totalBytes + source.size;
				this.assertCapacity(source.size, reservedJobBytes, resolved);
				const copyPath = join(temporaryDirectory, String(inputs.length));
				await copyFile(resolved.path, copyPath).catch(() => {
					throw inputError("snapshot-failed", resolved);
				});
				const copied = await stat(copyPath);
				const actualJobBytes = totalBytes + copied.size;
				this.assertCapacity(copied.size, actualJobBytes, resolved);
				const sha256 = await hashFile(copyPath);
				const entry: WorkflowInputSnapshotEntry = {
					id: inputId(jobId, inputs.length),
					name: resolved.name,
					path: copyPath,
					size: copied.size,
					sha256,
					references: [resolved.reference],
				};
				inputs.push(entry);
				bySource.set(sourceId, entry);
				totalBytes = actualJobBytes;
			}
			await rename(temporaryDirectory, targetDirectory);
			for (const entry of inputs) {
				entry.path = join(targetDirectory, basename(entry.path));
			}
			this.snapshotBytes.set(jobId, totalBytes);
			this.totalBytes += totalBytes;
			return { prompt: copiedPrompt, inputs };
		} catch (error) {
			await rm(temporaryDirectory, { recursive: true, force: true });
			if (error instanceof WorkflowInputSnapshotError) throw error;
			throw new WorkflowInputSnapshotError({
				code: "input_failed",
				message: "Could not create the workflow input snapshot.",
				problems: [{ reason: "snapshot-failed", name: "Workflow inputs" }],
			});
		}
	}

	private async resolveReferences(
		prompt: Record<string, unknown>,
	): Promise<ResolvedReference[]> {
		const runtimeUrl = this.options.getRuntimeUrl();
		if (runtimeUrl !== null) {
			const response = await this.requestFetch(new URL("object_info", runtimeUrl), {
				cache: "no-store",
				signal: AbortSignal.timeout(OBJECT_INFO_TIMEOUT_MS),
			}).catch(() => null);
			const definitions: unknown = await response?.json().catch(() => null);
			if (response?.ok === true && isRecord(definitions)) {
				this.nodeDefinitions = definitions;
			}
		}

		const definitions = this.nodeDefinitions;

		const references: ResolvedReference[] = [];
		const serialized = new Set<string>();
		for (const [nodeId, value] of Object.entries(prompt)) {
			if (
				!isRecord(value) ||
				typeof value.class_type !== "string" ||
				!isRecord(value.inputs)
			) {
				continue;
			}
			const definition = definitions?.[value.class_type];
			const inputDefinitions =
				isRecord(definition) && isRecord(definition.input) ? definition.input : {};
			const required = isRecord(inputDefinitions.required)
				? inputDefinitions.required
				: {};
			const optional = isRecord(inputDefinitions.optional)
				? inputDefinitions.optional
				: {};
			for (const [inputName, input] of Object.entries(value.inputs)) {
				if (isNodeLink(input)) continue;
				if (!isUploadInput(required[inputName] ?? optional[inputName])) {
					await this.collectSerializedReferences(
						nodeId,
						inputName,
						input,
						references,
						serialized,
					);
					continue;
				}
				if (typeof input !== "string") {
					throw new WorkflowInputSnapshotError({
						code: "input_failed",
						message: "Workflow input reference is invalid.",
						problems: [
							{
								reason: "invalid-reference",
								name: `${value.class_type}.${inputName}`,
								nodeId,
								inputName,
							},
						],
					});
				}
				references.push(await this.resolveReference(nodeId, inputName, input));
			}
		}
		return references;
	}

	private async collectSerializedReferences(
		nodeId: string,
		inputName: string,
		value: unknown,
		references: ResolvedReference[],
		serialized: Set<string>,
	): Promise<void> {
		for (const leaf of collectWorkflowInputStringLeaves(value)) {
			const key = `${nodeId}\0${inputName}\0${leaf}`;
			if (serialized.has(key)) continue;
			serialized.add(key);
			const resolved = await this.findFileReference(nodeId, inputName, leaf);
			if (resolved !== null) references.push(resolved);
		}
	}

	private async findFileReference(
		nodeId: string,
		inputName: string,
		value: string,
	): Promise<ResolvedReference | null> {
		if (value.length === 0) return null;
		// The generic scan only accepts filename-like values. This bounds but
		// does not eliminate false positives: a text widget whose whole value
		// matches an existing filename is still collected and rewritten.
		if (!hasFileExtension(annotatedReference(value).path)) return null;
		const located = await this.locateDataFile(value);
		if ("error" in located) return null;
		const source = await stat(located.path).catch(() => null);
		if (source === null || !source.isFile()) return null;
		return { ...located, reference: { nodeId, inputName, value } };
	}

	private async resolveReference(
		nodeId: string,
		inputName: string,
		value: string,
	): Promise<ResolvedReference> {
		const located = await this.locateDataFile(value);
		if ("error" in located) {
			throw new WorkflowInputSnapshotError({
				code: "input_failed",
				message:
					"Workflow input file is missing or outside the ComfyUI data directory.",
				problems: [
					{
						reason: located.error,
						name: value,
						nodeId,
						inputName,
					},
				],
			});
		}
		return { ...located, reference: { nodeId, inputName, value } };
	}

	private async locateDataFile(
		value: string,
	): Promise<
		{ path: string; name: string } | { error: "missing" | "invalid-reference" }
	> {
		const parsed = annotatedReference(value);
		const baseDirectory = join(this.options.dataDirectory, "data", parsed.type);
		const candidate = resolve(baseDirectory, parsed.path);
		const base = await realpath(baseDirectory).catch(() => baseDirectory);
		const resolved = await realpath(candidate).catch(() => null);
		if (resolved === null) return { error: "missing" };
		if (isAbsolute(parsed.path) || !isWithin(base, resolved)) {
			return { error: "invalid-reference" };
		}
		return { path: resolved, name: basename(parsed.path) };
	}

	private assertCapacity(
		fileBytes: number,
		jobBytes: number,
		resolved: ResolvedReference,
	): void {
		if (
			fileBytes > this.maxFileBytes ||
			jobBytes > this.maxJobBytes ||
			this.totalBytes + jobBytes > this.maxTotalBytes
		) {
			throw inputError("too-large", resolved);
		}
	}

	private async lock<Result>(operation: () => Promise<Result>): Promise<Result> {
		const previous = this.operation;
		let release = (): void => undefined;
		this.operation = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

function annotatedReference(value: string): {
	type: "input" | "output" | "temp";
	path: string;
} {
	for (const type of ["input", "output", "temp"] as const) {
		const annotation = ` [${type}]`;
		if (value.endsWith(annotation)) {
			return { type, path: value.slice(0, -annotation.length) };
		}
	}
	return { type: "input", path: value };
}

function hasFileExtension(path: string): boolean {
	return /\.[^./\\]{1,16}$/.test(path);
}

function clonePrompt(prompt: Record<string, unknown>): Record<string, unknown> {
	try {
		const cloned: unknown = JSON.parse(JSON.stringify(prompt));
		if (!isRecord(cloned)) throw new Error("Invalid prompt");
		return cloned;
	} catch {
		throw new WorkflowInputSnapshotError({
			code: "input_failed",
			message: "Workflow prompt could not be snapshotted.",
			problems: [{ reason: "snapshot-failed", name: "Workflow prompt" }],
		});
	}
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function inputId(jobId: string, index: number): string {
	return createHash("sha256")
		.update(jobId)
		.update("\0")
		.update(String(index))
		.digest("hex");
}

function inputError(
	reason: WorkflowInputProblem["reason"],
	resolved: ResolvedReference,
): WorkflowInputSnapshotError {
	return new WorkflowInputSnapshotError({
		code: "input_failed",
		message:
			reason === "too-large"
				? "Workflow input file exceeds the size limit."
				: reason === "missing"
					? "Workflow input file is missing."
					: "Could not snapshot the workflow input file.",
		problems: [
			{
				reason,
				name: resolved.reference.value,
				nodeId: resolved.reference.nodeId,
				inputName: resolved.reference.inputName,
			},
		],
	});
}

function isWithin(base: string, target: string): boolean {
	const path = relative(base, target);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isUploadInput(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		isRecord(value[1]) &&
		Object.entries(value[1]).some(
			([name, enabled]) => name.endsWith("_upload") && enabled === true,
		)
	);
}

function isNodeLink(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		(typeof value[0] === "string" || typeof value[0] === "number") &&
		typeof value[1] === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
