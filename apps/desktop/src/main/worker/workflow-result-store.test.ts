// @vitest-environment node

import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WorkflowResultStore } from "./workflow-result-store";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

test("verifies and atomically publishes Worker results in the ComfyUI output tree", async () => {
	const root = await mkdtemp(join(tmpdir(), "kastard-desktop-results-"));
	roots.push(root);
	const store = new WorkflowResultStore(root);
	await store.initialize();
	const jobId = "11111111-1111-4111-8111-111111111111";
	const fileId = "a".repeat(64);
	const bytes = new TextEncoder().encode("remote-image");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const requestFetch = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(input.toString());
		if (url.pathname.endsWith("/results")) {
			return Response.json({
				id: jobId,
				outputs: {
					"4": {
						images: [
							{
								filename: "result.png",
								subfolder: "images",
								type: "output",
								kastard_file_id: fileId,
							},
						],
					},
				},
				files: [
					{
						id: fileId,
						filename: "result.png",
						subfolder: "images",
						type: "output",
						size: bytes.byteLength,
						sha256,
						contentType: "image/png",
					},
				],
			});
		}
		return new Response(bytes, { headers: { "Content-Type": "image/png" } });
	});
	const context = {
		id: jobId,
		number: 2,
		createdAt: 100,
		prompt: { "4": { class_type: "SaveImage", inputs: {} } },
		extraData: { extra_pnginfo: { workflow: {} } },
		clientId: "comfy-client",
	};

	await store.collect(
		{
			serverUrl: "https://worker.example.com",
			sessionCapability: "test-session-capability",
		},
		context,
		requestFetch as unknown as typeof fetch,
	);

	expect(store.get(jobId)).toMatchObject({
		...context,
		status: "completed",
		files: [{ id: fileId, sha256 }],
		outputs: {
			"4": {
				images: [
					{
						filename: "result.png",
						subfolder: `kastard/${jobId}/${fileId}`,
						type: "output",
						kastard_file_id: fileId,
					},
				],
			},
		},
	});
	expect(await readFile(join(root, jobId, fileId, "result.png"), "utf8")).toBe(
		"remote-image",
	);
	expect((await readdir(join(root, jobId))).sort()).toEqual([".job.json", fileId]);
	expect((await readdir(root)).filter((entry) => entry.includes("staging"))).toEqual(
		[],
	);

	const restored = new WorkflowResultStore(root);
	await restored.initialize();
	expect(restored.get(jobId)).toEqual(store.get(jobId));
});

test("migrates persisted Worker results into the ComfyUI output tree", async () => {
	const container = await mkdtemp(join(tmpdir(), "kastard-desktop-results-"));
	roots.push(container);
	const root = join(container, "output", "kastard");
	const legacyRoot = join(container, "workflow-results");
	const jobId = "11111111-1111-4111-8111-111111111111";
	const fileId = "a".repeat(64);
	const bytes = Buffer.from("remote-video");
	const job = {
		id: jobId,
		number: 2,
		createdAt: 100,
		prompt: { "4": { class_type: "SaveVideo", inputs: {} } },
		extraData: {},
		clientId: null,
		status: "completed",
		completedAt: 200,
		outputs: {
			"4": {
				videos: [
					{
						filename: "result.mp4",
						subfolder: `kastard/${jobId}/${fileId}`,
						type: "output",
						kastard_file_id: fileId,
					},
				],
			},
		},
		files: [
			{
				id: fileId,
				filename: "result.mp4",
				subfolder: "videos",
				type: "output",
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				contentType: "video/mp4",
			},
		],
	} as const;
	const legacyJob = join(legacyRoot, jobId);
	await mkdir(join(legacyJob, "files", fileId), { recursive: true });
	await Promise.all([
		writeFile(join(legacyJob, "job.json"), JSON.stringify(job)),
		writeFile(join(legacyJob, "files", fileId, "result.mp4"), bytes),
	]);

	const store = new WorkflowResultStore(root, legacyRoot);
	await store.initialize();

	expect(store.get(jobId)).toEqual(job);
	expect(await readFile(join(root, jobId, fileId, "result.mp4"), "utf8")).toBe(
		"remote-video",
	);
	expect((await readdir(join(root, jobId))).sort()).toEqual([".job.json", fileId]);
	expect(await readdir(legacyRoot)).toEqual([]);
});

test("does not overwrite an existing ComfyUI output or block startup during migration", async () => {
	const container = await mkdtemp(join(tmpdir(), "kastard-desktop-results-"));
	roots.push(container);
	const root = join(container, "output", "kastard");
	const legacyRoot = join(container, "workflow-results");
	const jobId = "11111111-1111-4111-8111-111111111111";
	const fileId = "a".repeat(64);
	const legacyJob = join(legacyRoot, jobId);
	const destination = join(root, jobId);
	const bytes = Buffer.from("x");
	const job = {
		id: jobId,
		number: 2,
		createdAt: 100,
		prompt: {},
		extraData: {},
		clientId: null,
		status: "completed",
		completedAt: 200,
		outputs: {},
		files: [
			{
				id: fileId,
				filename: "result.mp4",
				subfolder: "videos",
				type: "output",
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				contentType: "video/mp4",
			},
		],
	} as const;
	await Promise.all([
		mkdir(join(legacyJob, "files", fileId), { recursive: true }),
		mkdir(destination, { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(legacyJob, "job.json"), JSON.stringify(job)),
		writeFile(join(legacyJob, "files", fileId, "result.mp4"), bytes),
		writeFile(join(destination, "keep.txt"), "keep"),
	]);

	await expect(new WorkflowResultStore(root, legacyRoot).initialize()).resolves.toBe(
		undefined,
	);
	expect(JSON.parse(await readFile(join(legacyJob, "job.json"), "utf8"))).toEqual(job);
	expect(await readFile(join(legacyJob, "files", fileId, "result.mp4"), "utf8")).toBe(
		"x",
	);
	expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("keep");
});

test("leaves an incomplete legacy result in place without blocking startup", async () => {
	const container = await mkdtemp(join(tmpdir(), "kastard-desktop-results-"));
	roots.push(container);
	const root = join(container, "output", "kastard");
	const legacyRoot = join(container, "workflow-results");
	const jobId = "11111111-1111-4111-8111-111111111111";
	const fileId = "a".repeat(64);
	const legacyJob = join(legacyRoot, jobId);
	const job = {
		id: jobId,
		number: 2,
		createdAt: 100,
		prompt: {},
		extraData: {},
		clientId: null,
		status: "completed",
		completedAt: 200,
		outputs: {},
		files: [
			{
				id: fileId,
				filename: "missing.mp4",
				subfolder: "videos",
				type: "output",
				size: 1,
				sha256: "b".repeat(64),
				contentType: "video/mp4",
			},
		],
	} as const;
	await mkdir(legacyJob, { recursive: true });
	await writeFile(join(legacyJob, "job.json"), JSON.stringify(job));

	const store = new WorkflowResultStore(root, legacyRoot);
	await expect(store.initialize()).resolves.toBe(undefined);

	expect(store.get(jobId)).toBeNull();
	expect(JSON.parse(await readFile(join(legacyJob, "job.json"), "utf8"))).toEqual(job);
	expect(await readdir(root)).toEqual([]);
});

test("retries result collection after a transient download failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "kastard-desktop-results-"));
	roots.push(root);
	const store = new WorkflowResultStore(root);
	await store.initialize();
	const jobId = "11111111-1111-4111-8111-111111111111";
	const fileId = "a".repeat(64);
	const bytes = new TextEncoder().encode("remote-image");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	let downloads = 0;
	const context = {
		id: jobId,
		number: 2,
		createdAt: 100,
		prompt: { "4": { class_type: "SaveImage", inputs: {} } },
		extraData: {},
		clientId: null,
	};
	const requestFetch = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(input.toString());
		if (url.pathname.endsWith("/results")) {
			return Response.json({
				id: jobId,
				outputs: {
					"4": {
						images: [
							{
								filename: "result.png",
								subfolder: "images",
								type: "output",
								kastard_file_id: fileId,
							},
						],
					},
				},
				files: [
					{
						id: fileId,
						filename: "result.png",
						subfolder: "images",
						type: "output",
						size: bytes.byteLength,
						sha256,
						contentType: "image/png",
					},
				],
			});
		}
		downloads += 1;
		if (downloads === 1) throw new Error("connection reset");
		return new Response(bytes, { headers: { "Content-Type": "image/png" } });
	});

	await store.collect(
		{
			serverUrl: "https://worker.example.com",
			sessionCapability: "test-session-capability",
		},
		context,
		requestFetch as unknown as typeof fetch,
	);

	expect(downloads).toBe(2);
	expect(store.get(jobId)).toMatchObject({ id: jobId, status: "completed" });
	await store.recordCanceled(context);
	expect(store.get(jobId)).toMatchObject({ id: jobId, status: "completed" });
	expect((await readdir(root)).filter((entry) => entry.includes("staging"))).toEqual(
		[],
	);
});

test("aborts result collection without publishing a completed History job", async () => {
	const root = await mkdtemp(join(tmpdir(), "kastard-desktop-results-"));
	roots.push(root);
	const store = new WorkflowResultStore(root);
	await store.initialize();
	const controller = new AbortController();
	const requestFetch = vi.fn(
		(_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	);
	const context = {
		id: "11111111-1111-4111-8111-111111111111",
		number: 2,
		createdAt: 100,
		prompt: { "4": { class_type: "SaveImage", inputs: {} } },
		extraData: {},
		clientId: null,
	};

	const collection = store.collect(
		{
			serverUrl: "https://worker.example.com",
			sessionCapability: "test-session-capability",
		},
		context,
		requestFetch as unknown as typeof fetch,
		controller.signal,
	);
	await vi.waitFor(() => expect(requestFetch).toHaveBeenCalledOnce());
	controller.abort();

	await expect(collection).rejects.toBeDefined();
	expect(store.get(context.id)).toBeNull();
	expect((await readdir(root)).filter((entry) => entry.includes("staging"))).toEqual(
		[],
	);
});

test("keeps a History job when its metadata cannot be deleted", async () => {
	const container = await mkdtemp(join(tmpdir(), "kastard-desktop-results-"));
	roots.push(container);
	const resultRoot = join(container, "results");
	const backupRoot = join(container, "results-backup");
	const store = new WorkflowResultStore(resultRoot);
	await store.initialize();
	const context = {
		id: "11111111-1111-4111-8111-111111111111",
		number: 2,
		createdAt: 100,
		prompt: { "4": { class_type: "SaveImage", inputs: {} } },
		extraData: {},
		clientId: null,
	};
	await store.recordFailure(context, {
		code: "result_failed",
		message: "Result download failed.",
	});
	await rename(resultRoot, backupRoot);
	await writeFile(resultRoot, "not a directory");

	await expect(store.deleteHistory([context.id])).rejects.toThrow();
	expect(store.get(context.id)).toMatchObject({ id: context.id, status: "failed" });

	await rm(resultRoot);
	await rename(backupRoot, resultRoot);
	await store.deleteHistory([context.id]);
	expect(store.get(context.id)).toBeNull();
});

test("removes History metadata without deleting reusable output files", async () => {
	const root = await mkdtemp(join(tmpdir(), "kastard-desktop-results-"));
	roots.push(root);
	const jobId = "11111111-1111-4111-8111-111111111111";
	const fileId = "a".repeat(64);
	const output = join(root, jobId, fileId, "result.mp4");
	const bytes = Buffer.from("remote video");
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, bytes);
	await writeFile(
		join(root, jobId, ".job.json"),
		JSON.stringify({
			id: jobId,
			number: 2,
			createdAt: 100,
			prompt: {},
			extraData: {},
			clientId: null,
			status: "completed",
			completedAt: 200,
			outputs: {},
			files: [
				{
					id: fileId,
					filename: "result.mp4",
					subfolder: "videos",
					type: "output",
					size: bytes.byteLength,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					contentType: "video/mp4",
				},
			],
		}),
	);
	const store = new WorkflowResultStore(root);
	await store.initialize();

	await store.clearHistory();

	expect(store.get(jobId)).toBeNull();
	expect(await readFile(output, "utf8")).toBe("remote video");
	const restored = new WorkflowResultStore(root);
	await restored.initialize();
	expect(restored.get(jobId)).toBeNull();
});

test("records cancellation without replacing the terminal state", async () => {
	const root = await mkdtemp(join(tmpdir(), "kastard-workflow-canceled-"));
	try {
		const store = new WorkflowResultStore(root);
		await store.initialize();
		const context = {
			id: "11111111-1111-4111-8111-111111111111",
			number: 2,
			createdAt: 100,
			prompt: { "4": { class_type: "SaveImage", inputs: {} } },
			extraData: {},
			clientId: null,
		};

		await store.recordCanceled(context);
		expect(store.get(context.id)).toMatchObject({
			id: context.id,
			status: "canceled",
			outputs: {},
			files: [],
		});
		await store.recordFailure(context, {
			code: "execution_failed",
			message: "must not replace cancellation",
		});
		expect(store.get(context.id)?.status).toBe("canceled");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
