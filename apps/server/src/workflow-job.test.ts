import { expect, mock, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerLogStore } from "./server-log";
import { WorkflowJobExecutor } from "./workflow-job";

const inputlessPrompt = {
	"1": { class_type: "KastardTestNode", inputs: {} },
};

test("keeps a canceled job from executing when cancellation arrives before submission", async () => {
	const root = await mkdtemp(join(tmpdir(), "kastard-canceled-workflow-"));
	const jobId = randomUUID();
	const bytes = Buffer.from("workflow input");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const requestFetch = mock(() => Promise.resolve(Response.json({})));
	const executor = new WorkflowJobExecutor({
		getRootDirectory: () => root,
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		requestFetch: requestFetch as unknown as typeof fetch,
	});

	try {
		await executor.uploadInput(
			jobId,
			sha256,
			new Response(bytes).body,
			bytes.byteLength,
			sha256,
		);
		expect(await executor.cancel(jobId)).toEqual({ id: jobId, status: "canceled" });
		expect(await executor.submit(jobId, { prompt: inputlessPrompt })).toEqual({
			id: jobId,
			status: "canceled",
		});
		expect(
			await readdir(join(root, ".kastard", "workflow-inputs", jobId)).catch(() => []),
		).toEqual([]);
		expect(requestFetch).not.toHaveBeenCalled();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cancels the active internal ComfyUI workflow by its private prompt ID", async () => {
	const jobId = randomUUID();
	let internalPromptId = "";
	let cancelRequested = false;
	const requested: Array<{ path: string; method: string; body: unknown }> = [];
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			const method = init?.method ?? "GET";
			const body = init?.body === undefined ? null : JSON.parse(String(init.body));
			requested.push({ path, method, body });
			if (path === "/prompt") {
				internalPromptId = (body as { prompt_id: string }).prompt_id;
				return Response.json({ prompt_id: internalPromptId });
			}
			if (path === `/api/jobs/${internalPromptId}`) {
				return Response.json({
					id: internalPromptId,
					status: cancelRequested ? "cancelled" : "in_progress",
				});
			}
			if (path === "/queue" || path === "/interrupt") cancelRequested = true;
			return Response.json({});
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt: inputlessPrompt });
	await waitFor(() => internalPromptId.length > 0);
	expect(await executor.cancel(jobId)).toEqual({ id: jobId, status: "canceling" });
	expect(requested).toContainEqual({
		path: "/queue",
		method: "POST",
		body: { delete: [internalPromptId] },
	});
	expect(requested).toContainEqual({ path: "/interrupt", method: "POST", body: null });
	expect(internalPromptId).not.toBe(jobId);
	await waitFor(() => executor.get(jobId)?.status === "canceled");
});

test("reissues cancellation after an in-flight ComfyUI queue request settles", async () => {
	const jobId = randomUUID();
	let internalPromptId = "";
	let resolvePrompt: ((response: Response) => void) | undefined;
	let cancelRequests = 0;
	const promptResponse = new Promise<Response>((resolve) => {
		resolvePrompt = resolve;
	});
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				internalPromptId = JSON.parse(String(init?.body)).prompt_id;
				return promptResponse;
			}
			if (path === "/queue" || path === "/interrupt") {
				cancelRequests += 1;
				return Response.json({});
			}
			return Response.json({ id: internalPromptId, status: "cancelled" });
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt: inputlessPrompt });
	await waitFor(() => internalPromptId.length > 0);
	expect(await executor.cancel(jobId)).toEqual({ id: jobId, status: "canceling" });
	expect(cancelRequests).toBe(2);
	resolvePrompt?.(Response.json({ prompt_id: internalPromptId }));
	await waitFor(() => cancelRequests === 4);
	await waitFor(() => executor.get(jobId)?.status === "canceled");
});

test("submits one inputless workflow without exposing the internal ComfyUI id", async () => {
	const jobId = randomUUID();
	const extraData = { extra_pnginfo: { workflow: { id: "workflow" } } };
	let queuedBody: unknown = null;
	const requestedPaths: string[] = [];
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const url = new URL(input.toString());
			requestedPaths.push(url.pathname);
			if (url.pathname === "/prompt") {
				queuedBody = JSON.parse(String(init?.body));
				return Response.json({
					prompt_id: (queuedBody as { prompt_id: string }).prompt_id,
					number: 0,
					node_errors: {},
				});
			}
			return Response.json({ id: url.pathname.split("/").at(-1), status: "completed" });
		}) as typeof fetch,
	});

	const submission = executor.submit(jobId, {
		prompt: inputlessPrompt,
		extra_data: extraData,
	});
	expect(executor.hasActiveJob()).toBeTrue();
	expect(await submission).toEqual({
		id: jobId,
		status: "running",
	});
	await waitFor(() => executor.get(jobId)?.status === "completed");
	expect(executor.hasActiveJob()).toBeFalse();

	expect(requestedPaths[0]).toBe("/prompt");
	expect(queuedBody).toEqual({
		prompt: inputlessPrompt,
		prompt_id: expect.any(String),
		client_id: expect.any(String),
		extra_data: extraData,
	});
	expect((queuedBody as { client_id: string }).client_id).toBe(
		(queuedBody as { prompt_id: string }).prompt_id,
	);
	expect((queuedBody as { prompt_id: string }).prompt_id).not.toBe(jobId);
	expect(executor.get(jobId)).toEqual({
		id: jobId,
		status: "completed",
	});
});

test("prepares a verified result manifest before completing a workflow", async () => {
	const root = await mkdtemp(join(tmpdir(), "kastard-workflow-result-"));
	try {
		await mkdir(join(root, "output", "images"), { recursive: true });
		await writeFile(join(root, "output", "images", "result.png"), "image-bytes");
		await writeFile(join(root, "output", "model.glb"), "model-bytes");
		await writeFile(join(root, "output", "ignored.obj"), "stale-model");
		const jobId = randomUUID();
		const executor = new WorkflowJobExecutor({
			getRootDirectory: () => root,
			getRuntimeUrl: () => "http://127.0.0.1:8188/",
			logs: new ServerLogStore(),
			pollMs: 1,
			requestFetch: (async (input, init) => {
				const path = new URL(input.toString()).pathname;
				if (path === "/prompt") {
					const promptId = JSON.parse(String(init?.body)).prompt_id;
					return Response.json({ prompt_id: promptId });
				}
				return Response.json({
					status: "completed",
					outputs: {
						"1": {
							images: [{ filename: "result.png", subfolder: "images", type: "output" }],
						},
						"2": { result: ["model.glb", "ignored.obj", { camera: "front" }] },
						"3": { text: ["ignored.obj"] },
					},
				});
			}) as typeof fetch,
		});

		await executor.submit(jobId, { prompt: inputlessPrompt });
		await waitFor(() => executor.get(jobId)?.status === "completed");
		const result = executor.getResults(jobId);
		expect(result).toMatchObject({
			id: jobId,
			files: [
				{
					filename: "result.png",
					subfolder: "images",
					type: "output",
					size: 11,
					sha256: createHash("sha256").update("image-bytes").digest("hex"),
					contentType: "image/png",
				},
				{
					filename: "model.glb",
					subfolder: "",
					type: "output",
					size: 11,
					sha256: createHash("sha256").update("model-bytes").digest("hex"),
					contentType: "application/octet-stream",
				},
			],
		});
		const fileId = result?.files.find((file) => file.filename === "result.png")?.id;
		const modelFileId = result?.files.find((file) => file.filename === "model.glb")?.id;
		expect(fileId).toBeString();
		expect(modelFileId).toBeString();
		const resultPath = executor.getResultFile(jobId, fileId ?? "")?.path ?? "";
		const modelResultPath =
			executor.getResultFile(jobId, modelFileId ?? "")?.path ?? "";
		expect(resultPath).not.toBe(join(root, "output", "images", "result.png"));
		expect(await readFile(modelResultPath, "utf8")).toBe("model-bytes");
		await writeFile(join(root, "output", "images", "result.png"), "changed");
		expect(await readFile(resultPath, "utf8")).toBe("image-bytes");
		expect(result?.outputs).toEqual({
			"1": {
				images: [
					{
						filename: "result.png",
						subfolder: "images",
						type: "output",
						kastard_file_id: fileId,
					},
				],
			},
			"2": {
				result: [
					{
						filename: "model.glb",
						subfolder: "",
						type: "output",
						mediaType: "3d",
						kastard_file_id: modelFileId,
					},
					"ignored.obj",
					{ camera: "front" },
				],
			},
			"3": { text: ["ignored.obj"] },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reconciles an accepted workflow after its queue response is lost", async () => {
	const jobId = randomUUID();
	let comfyPromptId: string | null = null;
	let reads = 0;
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				comfyPromptId = JSON.parse(String(init?.body)).prompt_id;
				throw new Error("response lost");
			}
			reads += 1;
			expect(path).toBe(`/api/jobs/${comfyPromptId}`);
			return reads === 1
				? new Response(null, { status: 404 })
				: Response.json({ status: "completed" });
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt: inputlessPrompt });
	await waitFor(() => executor.get(jobId)?.status === "completed");
	expect(reads).toBe(2);
	expect(executor.get(jobId)).toEqual({
		id: jobId,
		status: "completed",
	});
});

test("submits dynamic inputs to ComfyUI without interpreting their schema", async () => {
	const jobId = randomUUID();
	const prompt = {
		"131": {
			class_type: "ComfyMathExpression",
			inputs: { expression: "a", "values.a": ["132", 0] },
		},
		"132": { class_type: "PrimitiveFloat", inputs: { value: 10 } },
	};
	let queuedPrompt: unknown = null;
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				const body = JSON.parse(String(init?.body));
				queuedPrompt = body.prompt;
				return Response.json({ prompt_id: body.prompt_id });
			}
			return Response.json({ status: "completed" });
		}) as typeof fetch,
	});

	expect(await executor.submit(jobId, { prompt })).toEqual({
		id: jobId,
		status: "running",
	});
	await waitFor(() => executor.get(jobId)?.status === "completed");
	expect(queuedPrompt).toEqual(prompt);
});

test("reports a model missing from Worker ComfyUI validation", async () => {
	const jobId = randomUUID();
	let promptRequests = 0;
	const prompt = {
		"7": {
			class_type: "CheckpointLoaderSimple",
			inputs: { ckpt_name: "missing.safetensors" },
		},
	};
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		requestFetch: (async (_input) => {
			promptRequests += 1;
			return Response.json(
				{
					error: { message: "Prompt outputs failed validation" },
					node_errors: {
						"7": {
							class_type: "CheckpointLoaderSimple",
							errors: [
								{
									type: "value_not_in_list",
									message: "Value not in list",
									details:
										"ckpt_name: 'missing.safetensors' not in ['available.safetensors']",
									extra_info: { input_name: "ckpt_name" },
								},
							],
						},
					},
				},
				{ status: 400 },
			);
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt });
	await waitFor(() => executor.get(jobId)?.status === "failed");
	expect(executor.get(jobId)).toEqual({
		id: jobId,
		status: "failed",
		error:
			"Prompt outputs failed validation\nCheckpointLoaderSimple.ckpt_name at 7: ckpt_name: 'missing.safetensors' not in ['available.safetensors']",
		failure: {
			code: "execution_failed",
			message:
				"Prompt outputs failed validation\nCheckpointLoaderSimple.ckpt_name at 7: ckpt_name: 'missing.safetensors' not in ['available.safetensors']",
		},
	});
	expect(promptRequests).toBe(1);
});

test("reports a ComfyUI server error as an execution failure", async () => {
	const jobId = randomUUID();
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		requestFetch: (async (_input) => {
			return Response.json(
				{ error: { message: "ComfyUI is reloading" } },
				{ status: 503 },
			);
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt: inputlessPrompt });
	await waitFor(() => executor.get(jobId)?.status === "failed");
	expect(executor.get(jobId)).toEqual({
		id: jobId,
		status: "failed",
		error: "ComfyUI is reloading",
		failure: { code: "execution_failed", message: "ComfyUI is reloading" },
	});
});

test("submits a node-linked input directly to ComfyUI", async () => {
	const jobId = randomUUID();
	const prompt = {
		"1": { class_type: "ImageSource", inputs: {} },
		"2": { class_type: "LoadImage", inputs: { image: ["1", 0] } },
	};
	let queued = false;
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				queued = true;
				const body = JSON.parse(String(init?.body));
				return Response.json({ prompt_id: body.prompt_id });
			}
			return Response.json({ status: "completed" });
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt });
	await waitFor(() => executor.get(jobId)?.status === "completed");
	expect(queued).toBe(true);
});

test("submits a Worker-local input without requiring a Kastard transfer", async () => {
	const jobId = randomUUID();
	let promptRequests = 0;
	const prompt = {
		"8": { class_type: "LoadImage", inputs: { image: "worker-local.png" } },
	};
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				promptRequests += 1;
				const body = JSON.parse(String(init?.body));
				expect(body.prompt).toEqual(prompt);
				return Response.json({ prompt_id: body.prompt_id });
			}
			return Response.json({ status: "completed" });
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt });
	await waitFor(() => executor.get(jobId)?.status === "completed");
	expect(promptRequests).toBe(1);
});

test("publishes verified workflow inputs before submission and reports missing uploads", async () => {
	const root = await mkdtemp(join(tmpdir(), "kastard-workflow-job-"));
	try {
		const jobId = randomUUID();
		const bytes = Buffer.from("workflow image bytes");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const prompt = {
			"8": { class_type: "LoadImage", inputs: { image: "reference.png" } },
		};
		let queuedPrompt: Record<string, unknown> | null = null;
		let promptRequests = 0;
		const executor = new WorkflowJobExecutor({
			getRootDirectory: () => root,
			getRuntimeUrl: () => "http://127.0.0.1:8188/",
			logs: new ServerLogStore(),
			pollMs: 1,
			requestFetch: (async (input, init) => {
				const path = new URL(input.toString()).pathname;
				if (path === "/prompt") {
					promptRequests += 1;
					const body = JSON.parse(String(init?.body));
					queuedPrompt = body.prompt;
					return Response.json({ prompt_id: body.prompt_id });
				}
				return Response.json({ status: "completed" });
			}) as typeof fetch,
		});
		const inputs = [
			{
				id: sha256,
				name: "reference.png",
				size: bytes.byteLength,
				sha256,
				references: [
					{
						nodeId: "8",
						inputName: "image",
						value: "reference.png",
					},
				],
			},
		];

		await executor.uploadInput(
			jobId,
			sha256,
			new Response(bytes).body,
			bytes.byteLength,
			sha256,
		);
		expect(await executor.submit(jobId, { prompt, inputs })).toEqual({
			id: jobId,
			status: "running",
		});
		await waitFor(() => executor.get(jobId)?.status === "completed");
		expect(queuedPrompt as Record<string, unknown> | null).toEqual({
			"8": {
				class_type: "LoadImage",
				inputs: {
					image: expect.stringMatching(
						new RegExp(`^kastard/${jobId}/${sha256}-reference\\.png$`),
					),
				},
			},
		});

		const missingJobId = randomUUID();
		expect(await executor.submit(missingJobId, { prompt, inputs })).toEqual({
			id: missingJobId,
			status: "failed",
			error: "Worker workflow input preparation failed.",
			failure: {
				code: "input_failed",
				message: "Worker workflow input preparation failed.",
				problems: [{ reason: "missing", name: "reference.png" }],
			},
		});
		expect(promptRequests).toBe(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retains terminal job ids while accepting only one new workflow at a time", async () => {
	let releasePrompt: (() => void) | undefined;
	const promptGate = new Promise<void>((resolve) => {
		releasePrompt = resolve;
	});
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				await promptGate;
				const body = JSON.parse(String(init?.body));
				return Response.json({ prompt_id: body.prompt_id });
			}
			return Response.json({ status: "completed" });
		}) as typeof fetch,
	});

	const firstId = randomUUID();
	expect(
		await Promise.all([
			executor.submit(firstId, { prompt: inputlessPrompt }),
			executor.submit(firstId, { prompt: inputlessPrompt }),
		]),
	).toEqual([
		{ id: firstId, status: "running" },
		{ id: firstId, status: "running" },
	]);
	await expect(
		executor.submit(randomUUID(), { prompt: inputlessPrompt }),
	).rejects.toMatchObject({
		message: "The Worker is already processing a workflow.",
		statusCode: 409,
		retryable: true,
	});
	releasePrompt?.();
	await waitFor(() => executor.get(firstId)?.status === "completed");
	expect(await executor.submit(firstId, { prompt: inputlessPrompt })).toEqual({
		id: firstId,
		status: "completed",
	});

	const secondId = randomUUID();
	expect(await executor.submit(secondId, { prompt: inputlessPrompt })).toEqual({
		id: secondId,
		status: "running",
	});
	expect(await executor.submit(firstId, { prompt: inputlessPrompt })).toEqual({
		id: firstId,
		status: "completed",
	});
	await waitFor(() => executor.get(secondId)?.status === "completed");
	expect(await executor.submit(firstId, { prompt: inputlessPrompt })).toEqual({
		id: firstId,
		status: "completed",
	});
});

test("keeps tracking a workflow across missing internal job responses", async () => {
	const jobId = randomUUID();
	let reads = 0;
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				const body = JSON.parse(String(init?.body));
				return Response.json({ prompt_id: body.prompt_id });
			}
			reads += 1;
			return reads <= 3
				? new Response(null, { status: 404 })
				: Response.json({ status: "completed" });
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt: inputlessPrompt });
	await waitFor(() => executor.get(jobId)?.status === "completed");
	expect(reads).toBe(4);
	expect(executor.get(jobId)).toEqual({
		id: jobId,
		status: "completed",
	});
});

test("fails a workflow whose internal job remains missing", async () => {
	const jobId = randomUUID();
	let reads = 0;
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				const body = JSON.parse(String(init?.body));
				return Response.json({ prompt_id: body.prompt_id });
			}
			reads += 1;
			return new Response(null, { status: 404 });
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt: inputlessPrompt });
	await waitFor(() => executor.get(jobId)?.status === "failed");
	expect(reads).toBe(60);
	expect(executor.get(jobId)).toEqual({
		id: jobId,
		status: "failed",
		error: "Worker workflow job was not found.",
		failure: {
			code: "execution_failed",
			message: "Worker workflow job was not found.",
		},
	});
});

test("fails a workflow after its ComfyUI runtime generation changes", async () => {
	const jobId = randomUUID();
	let generation = 1;
	let queued = false;
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		getRuntimeGeneration: () => generation,
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				queued = true;
				const body = JSON.parse(String(init?.body));
				return Response.json({ prompt_id: body.prompt_id });
			}
			return Response.json({ status: "in_progress" });
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt: inputlessPrompt });
	await waitFor(() => queued);
	generation = 2;
	await waitFor(() => executor.get(jobId)?.status === "failed");
	expect(executor.get(jobId)).toEqual({
		id: jobId,
		status: "failed",
		error: "Worker ComfyUI stopped before the workflow finished.",
		failure: {
			code: "execution_failed",
			message: "Worker ComfyUI stopped before the workflow finished.",
		},
	});
});

test("confirms cancellation when ComfyUI stops during an in-flight status request", async () => {
	const jobId = randomUUID();
	let generation = 1;
	let rejectStatus: ((error: Error) => void) | undefined;
	let statusRequested = false;
	const statusResponse = new Promise<Response>((_resolve, reject) => {
		rejectStatus = reject;
	});
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => "http://127.0.0.1:8188/",
		getRuntimeGeneration: () => generation,
		logs: new ServerLogStore(),
		pollMs: 1,
		requestFetch: (async (input, init) => {
			const path = new URL(input.toString()).pathname;
			if (path === "/prompt") {
				const body = JSON.parse(String(init?.body));
				return Response.json({ prompt_id: body.prompt_id });
			}
			if (path.startsWith("/api/jobs/")) {
				statusRequested = true;
				return statusResponse;
			}
			return Response.json({});
		}) as typeof fetch,
	});

	await executor.submit(jobId, { prompt: inputlessPrompt });
	await waitFor(() => statusRequested);
	expect(await executor.cancel(jobId)).toEqual({ id: jobId, status: "canceling" });
	generation = 2;
	rejectStatus?.(new Error("connection reset"));
	await waitFor(() => executor.get(jobId)?.status === "canceled");
	expect(executor.get(jobId)).toEqual({ id: jobId, status: "canceled" });
});

test("requires Worker ComfyUI to already be ready", async () => {
	const executor = new WorkflowJobExecutor({
		getRuntimeUrl: () => null,
		logs: new ServerLogStore(),
	});

	await expect(
		executor.submit(randomUUID(), { prompt: inputlessPrompt }),
	).rejects.toMatchObject({
		statusCode: 409,
		message: "Worker ComfyUI is not ready.",
		retryable: true,
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for workflow state.");
}
