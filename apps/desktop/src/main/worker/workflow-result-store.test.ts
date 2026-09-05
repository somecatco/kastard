// @vitest-environment node

import { createHash } from "node:crypto";
import * as filesystem from "node:fs/promises";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { comfyStoredJob } from "../comfy-gateway/compat";
import { WorkflowResultStore } from "./workflow-result-store";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, link: vi.fn(actual.link) };
});

const roots: string[] = [];

test("preserves saved video and temporary preview references across collection and restart", async () => {
	const data = await mkdtemp(join(tmpdir(), "kastard-results-"));
	roots.push(data);
	const root = join(data, "output", "kastard");
	const store = new WorkflowResultStore(root);
	await store.initialize();
	const id = "11111111-1111-4111-8111-111111111111";
	const files = [
		{
			id: "a".repeat(64),
			filename: "result.mp4",
			type: "output" as const,
			contentType: "video/mp4",
		},
		{
			id: "b".repeat(64),
			filename: "preview.png",
			type: "temp" as const,
			contentType: "image/png",
		},
		{
			id: "c".repeat(64),
			filename: "source.png",
			type: "input" as const,
			contentType: "image/png",
		},
	].map((file) => ({
		...file,
		subfolder: "",
		size: 6,
		sha256: createHash("sha256").update("sample").digest("hex"),
	}));
	const manifest = {
		id,
		files,
		outputs: {
			"1": {
				gifs: [
					{
						...files[0],
						kastard_file_id: files[0]?.id,
						format: "video/h264-mp4",
						frame_rate: 24,
					},
				],
			},
			"2": { images: [{ ...files[1], kastard_file_id: files[1]?.id }] },
			"3": { images: [{ ...files[2], kastard_file_id: files[2]?.id }] },
		},
	};
	const requestFetch = vi.fn(async (input: string | URL | Request) =>
		input.toString().endsWith("/results")
			? Response.json(manifest)
			: new Response("sample"),
	);
	await store.collect(
		{
			workerApiUrl: "https://worker.example.com",
			sessionCapability: "test-capability",
		},
		{ id, number: 1, createdAt: 100, prompt: {}, extraData: {}, clientId: null },
		requestFetch as typeof fetch,
	);
	const job = store.get(id);
	expect(job).not.toBeNull();
	if (job === null) throw new Error("The collected job is missing.");
	expect(comfyStoredJob(job, true)).toMatchObject({
		preview_output: { filename: "result.mp4", type: "output" },
		outputs: {
			"1": { gifs: [{ filename: "result.mp4", type: "output" }] },
			"2": { images: [{ filename: "preview.png", type: "temp" }] },
			"3": { images: [{ filename: "source.png", type: "input" }] },
		},
	});
	for (const file of files) {
		const path = join(data, file.type, "kastard", id, file.id, file.filename);
		expect(await readFile(path, "utf8")).toBe("sample");
		expect((await stat(path)).ino).toBe(
			(await stat(join(root, id, file.id, file.filename))).ino,
		);
	}
	await rm(join(data, "temp"), { recursive: true });
	const restored = new WorkflowResultStore(root);
	await restored.initialize();
	await restored.restoreNativeFiles();
	await restored.restoreNativeFiles();
	expect(restored.get(id)).toEqual(job);
	expect(
		await readFile(
			join(data, "temp", "kastard", id, files[1]?.id ?? "", "preview.png"),
			"utf8",
		),
	).toBe("sample");
	expect(requestFetch).toHaveBeenCalledTimes(4);
	const controller = new AbortController();
	const actual =
		await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	const links = vi.mocked(filesystem.link);
	const previousLinks = links.mock.calls.length;
	links.mockImplementationOnce(async (source, destination) => {
		controller.abort();
		await actual.link(source, destination);
	});
	await expect(restored.restoreNativeFiles(controller.signal)).rejects.toThrow(
		/abort/iu,
	);
	expect(links.mock.calls.length).toBe(previousLinks + 1);
	await restored.restoreNativeFiles();
	expect(restored.get(id)).toEqual(job);

	const outputs = job.outputs as Record<
		string,
		Record<string, Array<Record<string, unknown>>>
	>;
	for (const node of Object.values(outputs)) {
		for (const items of Object.values(node))
			for (const item of items) item.type = "output";
	}
	await writeFile(join(root, id, ".job.json"), JSON.stringify(job));
	const onRestoreFailure = vi.fn(async () => {});
	const existing = new WorkflowResultStore(root, undefined, onRestoreFailure);
	await existing.initialize();
	expect(existing.get(id)?.outputs).toMatchObject({
		"2": { images: [{ type: "temp" }] },
		"3": { images: [{ type: "input" }] },
	});
	const input = join(data, "input", "kastard", id, "c".repeat(64), "source.png");
	await rm(join(data, "temp"), { recursive: true });
	await rm(input);
	await writeFile(input, "another image");
	await expect(existing.restoreNativeFiles()).resolves.toBeUndefined();
	expect(onRestoreFailure).toHaveBeenCalledOnce();
	expect(existing.get(id)?.outputs).toMatchObject({
		"1": { gifs: [{ filename: "result.mp4", type: "output" }] },
		"2": { images: [{ filename: "preview.png", type: "temp" }] },
		"3": { images: [] },
	});
	expect(await readFile(input, "utf8")).toBe("another image");
	expect(await readFile(join(root, id, "c".repeat(64), "source.png"), "utf8")).toBe(
		"sample",
	);
	await rm(input);
	await existing.restoreNativeFiles();
	expect(existing.get(id)?.outputs).toMatchObject({
		"3": { images: [{ filename: "source.png", type: "input" }] },
	});
	await rm(join(root, id, "b".repeat(64), "preview.png"));
	await rm(join(data, "temp"), { recursive: true });
	await expect(existing.restoreNativeFiles()).resolves.toBeUndefined();
	expect(onRestoreFailure).toHaveBeenCalledTimes(2);
	expect(existing.get(id)?.outputs).toMatchObject({
		"1": { gifs: [{ filename: "result.mp4", type: "output" }] },
		"2": { images: [] },
		"3": { images: [{ filename: "source.png", type: "input" }] },
	});
});

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
			workerApiUrl: "https://worker.example.com",
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
			workerApiUrl: "https://worker.example.com",
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
			workerApiUrl: "https://worker.example.com",
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

test.each(["path conflict", "late cancellation"])(
	"preserves published results after %s",
	async (scenario) => {
		const data = await mkdtemp(join(tmpdir(), "kastard-results-"));
		roots.push(data);
		const root = join(data, "output", "kastard");
		const onRestoreFailure = vi.fn(async () => {});
		const store = new WorkflowResultStore(root, undefined, onRestoreFailure);
		await store.initialize();
		const id = "11111111-1111-4111-8111-111111111111";
		const file = {
			id: "a".repeat(64),
			filename: "preview.png",
			type: "temp",
			subfolder: "",
			contentType: "image/png",
			size: 6,
			sha256: createHash("sha256").update("sample").digest("hex"),
		};
		const native = join(data, "temp", "kastard", id, file.id, file.filename);
		const controller = new AbortController();
		if (scenario === "path conflict") {
			await mkdir(dirname(native), { recursive: true });
			await writeFile(native, "another image");
		} else {
			const actual =
				await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			vi.mocked(filesystem.link).mockImplementationOnce(async (source, destination) => {
				expect(await readFile(join(root, id, file.id, file.filename), "utf8")).toBe(
					"sample",
				);
				controller.abort();
				await actual.link(source, destination);
			});
		}
		const requestFetch = vi.fn(async (input: string | URL | Request) =>
			input.toString().endsWith("/results")
				? Response.json({
						id,
						files: [file],
						outputs: { "1": { images: [{ ...file, kastard_file_id: file.id }] } },
					})
				: new Response("sample"),
		);
		await store.collect(
			{
				workerApiUrl: "https://worker.example.com",
				sessionCapability: "test-capability",
			},
			{ id, number: 1, createdAt: 100, prompt: {}, extraData: {}, clientId: null },
			requestFetch as typeof fetch,
			controller.signal,
		);
		expect(requestFetch).toHaveBeenCalledTimes(2);
		expect(onRestoreFailure).toHaveBeenCalledTimes(
			scenario === "path conflict" ? 1 : 0,
		);
		expect(controller.signal.aborted).toBe(scenario === "late cancellation");
		expect(store.get(id)).toMatchObject({
			status: "completed",
			outputs: {
				"1": {
					images:
						scenario === "path conflict"
							? []
							: [{ filename: "preview.png", type: "temp" }],
				},
			},
		});
		expect(await readFile(native, "utf8")).toBe(
			scenario === "path conflict" ? "another image" : "sample",
		);
		expect(await readFile(join(root, id, file.id, file.filename), "utf8")).toBe(
			"sample",
		);
		expect(
			JSON.parse(await readFile(join(root, id, ".job.json"), "utf8")),
		).toMatchObject({
			outputs: { "1": { images: [{ filename: "preview.png", type: "temp" }] } },
		});
		await rm(native);
		const restarted = new WorkflowResultStore(root);
		await restarted.initialize();
		await restarted.restoreNativeFiles();
		expect(restarted.list()[0]).toMatchObject({
			status: "completed",
			outputs: { "1": { images: [{ filename: "preview.png", type: "temp" }] } },
		});
		expect(await readFile(native, "utf8")).toBe("sample");
	},
);
