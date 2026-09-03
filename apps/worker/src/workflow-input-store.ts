import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	copyFile,
	link,
	mkdir,
	open,
	readdir,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
	rewriteWorkflowInputStringLeaves,
	type WorkflowInputFailure,
	type WorkflowInputManifestEntry,
	type WorkflowInputProblem,
	type WorkflowInputReference,
} from "@kastard/common";

const MAX_WORKFLOW_INPUT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_WORKFLOW_INPUT_JOB_BYTES = 1024 * 1024 * 1024;
const MAX_WORKFLOW_INPUT_STAGING_BYTES = 4 * 1024 * 1024 * 1024;

export type {
	WorkflowInputFailure,
	WorkflowInputManifestEntry,
	WorkflowInputProblem,
	WorkflowInputReference,
} from "@kastard/common";

export class WorkflowInputStoreError extends Error {
	constructor(readonly failure: WorkflowInputFailure) {
		super(failure.message);
	}
}

type WorkflowInputStoreOptions = {
	getRootDirectory: () => string | null;
	maxFileBytes?: number;
	maxJobBytes?: number;
	maxStagingBytes?: number;
};

export class WorkflowInputStore {
	private readonly maxFileBytes: number;
	private readonly maxJobBytes: number;
	private readonly maxStagingBytes: number;
	private initializedRoot: string | null = null;
	private operation = Promise.resolve();

	constructor(private readonly options: WorkflowInputStoreOptions) {
		this.maxFileBytes = options.maxFileBytes ?? MAX_WORKFLOW_INPUT_FILE_BYTES;
		this.maxJobBytes = options.maxJobBytes ?? MAX_WORKFLOW_INPUT_JOB_BYTES;
		this.maxStagingBytes = options.maxStagingBytes ?? MAX_WORKFLOW_INPUT_STAGING_BYTES;
	}

	initialize(): Promise<void> {
		return this.lock(async () => {
			await this.root();
		});
	}

	upload(
		jobId: string,
		inputId: string,
		body: ReadableStream<Uint8Array> | null,
		expectedSize: number,
		expectedSha256: string,
	): Promise<void> {
		return this.lock(() =>
			this.uploadOnce(jobId, inputId, body, expectedSize, expectedSha256),
		);
	}

	private async uploadOnce(
		jobId: string,
		inputId: string,
		body: ReadableStream<Uint8Array> | null,
		expectedSize: number,
		expectedSha256: string,
	): Promise<void> {
		validateJobId(jobId);
		validateInputId(inputId);
		if (
			body === null ||
			!Number.isSafeInteger(expectedSize) ||
			expectedSize < 0 ||
			expectedSize > this.maxFileBytes
		) {
			throw inputFailure(
				expectedSize > this.maxFileBytes ? "too-large" : "transfer-failed",
				inputId,
			);
		}
		if (!isSha256(expectedSha256)) {
			throw inputFailure("checksum-mismatch", inputId);
		}
		const root = await this.root();
		const directory = join(root, ".kastard", "workflow-inputs", jobId);
		const target = join(directory, inputId);
		const existing = await stat(target).catch(() => null);
		if (
			existing?.isFile() &&
			existing.size === expectedSize &&
			(await hashFile(target)) === expectedSha256
		) {
			return;
		}
		await rm(target, { force: true });
		const stagingRoot = join(root, ".kastard", "workflow-inputs");
		const [jobUsage, stagingBytes] = await Promise.all([
			stagedInputUsage(directory),
			stagedInputBytes(stagingRoot),
		]);
		if (
			jobUsage.count >= 256 ||
			jobUsage.bytes + expectedSize > this.maxJobBytes ||
			stagingBytes + expectedSize > this.maxStagingBytes
		) {
			throw inputFailure("too-large", "Workflow inputs");
		}
		await mkdir(directory, { recursive: true });
		const temporary = join(directory, `.tmp-${randomUUID()}`);
		const file = await open(temporary, "wx", 0o600);
		const hash = createHash("sha256");
		let size = 0;
		const reader = body.getReader();
		let complete = false;
		try {
			try {
				while (true) {
					const { done, value: chunk } = await reader.read();
					if (done) {
						complete = true;
						break;
					}
					const buffer = Buffer.from(chunk);
					size += buffer.byteLength;
					if (size > expectedSize || size > this.maxFileBytes) {
						throw inputFailure("too-large", inputId);
					}
					hash.update(buffer);
					await writeAll(file, buffer);
				}
				await file.sync();
			} finally {
				await file.close();
			}
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		} finally {
			if (!complete) {
				try {
					await reader.cancel();
				} catch {}
			}
			try {
				reader.releaseLock();
			} catch {}
		}
		if (size !== expectedSize || hash.digest("hex") !== expectedSha256) {
			await rm(temporary, { force: true });
			throw inputFailure("checksum-mismatch", inputId);
		}
		await rename(temporary, target);
	}

	publish(
		jobId: string,
		prompt: Record<string, unknown>,
		inputs: WorkflowInputManifestEntry[],
	): Promise<Record<string, unknown>>;
	publish(
		jobId: string,
		prompt: unknown,
		inputs: WorkflowInputManifestEntry[],
	): Promise<unknown>;
	publish(
		jobId: string,
		prompt: unknown,
		inputs: WorkflowInputManifestEntry[],
	): Promise<unknown> {
		return this.lock(() => this.publishOnce(jobId, prompt, inputs));
	}

	private async publishOnce(
		jobId: string,
		prompt: unknown,
		inputs: WorkflowInputManifestEntry[],
	): Promise<unknown> {
		if (inputs.length === 0) return prompt;
		validateJobId(jobId);
		validateManifest(inputs, this.maxFileBytes, this.maxJobBytes);
		const root = await this.root();
		const staging = join(root, ".kastard", "workflow-inputs", jobId);
		const inputRoot = join(root, "input", "kastard");
		const target = join(inputRoot, jobId);
		const temporary = join(inputRoot, `.tmp-${jobId}-${randomUUID()}`);
		await mkdir(temporary, { recursive: true });
		const rewritten = clonePrompt(prompt);
		try {
			for (const input of inputs) {
				const source = join(staging, input.id);
				const sourceStat = await stat(source).catch(() => null);
				if (
					sourceStat === null ||
					!sourceStat.isFile() ||
					sourceStat.size !== input.size
				) {
					throw inputFailure("missing", input.name);
				}
				if ((await hashFile(source)) !== input.sha256) {
					throw inputFailure("checksum-mismatch", input.name);
				}
				const filename = `${input.id}-${safeFilename(input.name)}`;
				const destination = join(temporary, filename);
				await link(source, destination).catch(async () =>
					copyFile(source, destination),
				);
				const workerReference = `kastard/${jobId}/${filename}`;
				for (const reference of input.references) {
					rewriteReference(rewritten, reference, workerReference);
				}
			}
			await rename(temporary, target);
			await rm(staging, { recursive: true, force: true });
			return rewritten;
		} catch (error) {
			await rm(temporary, { recursive: true, force: true });
			if (error instanceof WorkflowInputStoreError) throw error;
			throw inputFailure("transfer-failed", "Workflow inputs");
		}
	}

	cleanup(jobId: string): Promise<void> {
		return this.lock(() => this.cleanupOnce(jobId));
	}

	private async cleanupOnce(jobId: string): Promise<void> {
		validateJobId(jobId);
		const root = await this.root();
		await Promise.all([
			rm(join(root, ".kastard", "workflow-inputs", jobId), {
				recursive: true,
				force: true,
			}),
			rm(join(root, "input", "kastard", jobId), {
				recursive: true,
				force: true,
			}),
		]);
	}

	private async root(): Promise<string> {
		const root = this.options.getRootDirectory();
		if (root === null) throw inputFailure("transfer-failed", "Worker input storage");
		if (this.initializedRoot !== root) {
			await Promise.all([
				rm(join(root, ".kastard", "workflow-inputs"), {
					recursive: true,
					force: true,
				}),
				rm(join(root, "input", "kastard"), { recursive: true, force: true }),
			]);
			this.initializedRoot = root;
		}
		return root;
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

function validateManifest(
	inputs: WorkflowInputManifestEntry[],
	maxFileBytes: number,
	maxJobBytes: number,
): void {
	if (inputs.length > 256) throw inputFailure("too-large", "Workflow inputs");
	const ids = new Set<string>();
	let total = 0;
	for (const input of inputs) {
		if (
			!isInputId(input.id) ||
			!isSha256(input.sha256) ||
			typeof input.name !== "string" ||
			input.name.length === 0 ||
			input.name.length > 255 ||
			!Number.isSafeInteger(input.size) ||
			input.size < 0 ||
			input.size > maxFileBytes ||
			!Array.isArray(input.references) ||
			input.references.length === 0 ||
			input.references.some((reference) => !isReference(reference)) ||
			ids.has(input.id)
		) {
			throw inputFailure("invalid-reference", input.name || "Workflow input");
		}
		ids.add(input.id);
		total += input.size;
		if (total > maxJobBytes) throw inputFailure("too-large", "Workflow inputs");
	}
}

function rewriteReference(
	prompt: Record<string, unknown>,
	reference: WorkflowInputReference,
	workerReference: string,
): void {
	const node = prompt[reference.nodeId];
	if (!isRecord(node) || !isRecord(node.inputs)) {
		throw inputFailure("invalid-reference", reference.value, reference);
	}
	const current = node.inputs[reference.inputName];
	const rewritten = rewriteWorkflowInputStringLeaves(
		current,
		reference.value,
		workerReference,
	);
	if (rewritten.replacements === 0) {
		throw inputFailure("invalid-reference", reference.value, reference);
	}
	node.inputs[reference.inputName] = rewritten.value;
}

function inputFailure(
	reason: WorkflowInputProblem["reason"],
	name: string,
	reference?: Pick<WorkflowInputReference, "nodeId" | "inputName">,
): WorkflowInputStoreError {
	return new WorkflowInputStoreError({
		code: "input_failed",
		message: "Worker workflow input preparation failed.",
		problems: [{ reason, name, ...reference }],
	});
}

function safeFilename(value: string): string {
	const normalized = basename(value).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
	return normalized.length === 0 ? "input" : normalized.slice(0, 180);
}

function validateJobId(value: string): void {
	if (!isCanonicalUuid(value))
		throw inputFailure("invalid-reference", "Workflow job ID");
}

function validateInputId(value: string): void {
	if (!isInputId(value)) throw inputFailure("invalid-reference", "Workflow input ID");
}

function isInputId(value: unknown): value is string {
	return typeof value === "string" && isSha256(value);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isCanonicalUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			value,
		)
	);
}

function isReference(value: unknown): value is WorkflowInputReference {
	return (
		isRecord(value) &&
		typeof value.nodeId === "string" &&
		typeof value.inputName === "string" &&
		typeof value.value === "string"
	);
}

function clonePrompt(prompt: unknown): Record<string, unknown> {
	const value: unknown = JSON.parse(JSON.stringify(prompt));
	if (!isRecord(value)) throw inputFailure("invalid-reference", "Workflow prompt");
	return value;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function stagedInputUsage(
	directory: string,
): Promise<{ bytes: number; count: number }> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const sizes = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && isInputId(entry.name))
			.map(async (entry) => (await stat(join(directory, entry.name))).size),
	);
	return {
		bytes: sizes.reduce((total, size) => total + size, 0),
		count: sizes.length,
	};
}

async function stagedInputBytes(root: string): Promise<number> {
	const jobs = await readdir(root, { withFileTypes: true }).catch(() => []);
	const usage = await Promise.all(
		jobs
			.filter((entry) => entry.isDirectory())
			.map((entry) => stagedInputUsage(join(root, entry.name))),
	);
	return usage.reduce((total, entry) => total + entry.bytes, 0);
}

async function writeAll(
	file: Awaited<ReturnType<typeof open>>,
	buffer: Buffer,
): Promise<void> {
	let offset = 0;
	while (offset < buffer.byteLength) {
		const { bytesWritten } = await file.write(
			buffer,
			offset,
			buffer.byteLength - offset,
		);
		if (bytesWritten === 0) throw new Error("Could not write workflow input bytes.");
		offset += bytesWritten;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
