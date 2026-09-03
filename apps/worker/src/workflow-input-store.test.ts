import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowInputStore } from "./workflow-input-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("verifies, publishes, rewrites, and cleans a workflow input", async () => {
	const fixture = await createFixture();
	const jobId = randomUUID();
	const bytes = Buffer.from("immutable workflow input");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const inputId = createHash("sha256").update("source image identity").digest("hex");
	const prompt = {
		"1": {
			class_type: "LoadImage",
			inputs: { image: "source image.png [output]" },
		},
	};
	const inputs = [
		{
			id: inputId,
			name: "source image.png",
			size: bytes.byteLength,
			sha256,
			references: [
				{
					nodeId: "1",
					inputName: "image",
					value: "source image.png [output]",
				},
			],
		},
	];

	await fixture.store.upload(
		jobId,
		inputId,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	await fixture.store.upload(
		jobId,
		inputId,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	const rewritten = await fixture.store.publish(jobId, prompt, inputs);
	const reference = (rewritten["1"] as { inputs: { image: string } }).inputs.image;

	expect(prompt["1"].inputs.image).toBe("source image.png [output]");
	expect(reference).toMatch(
		new RegExp(`^kastard/${jobId}/${inputId}-source_image\\.png$`),
	);
	expect(await readFile(join(fixture.root, "input", reference))).toEqual(bytes);
	expect(await exists(join(fixture.root, ".kastard", "workflow-inputs", jobId))).toBe(
		false,
	);

	await fixture.store.cleanup(jobId);
	expect(await exists(join(fixture.root, "input", reference))).toBe(false);
});

test("accepts an incoming body reader without an async iterator", async () => {
	const fixture = await createFixture();
	const jobId = randomUUID();
	const bytes = Buffer.from("incoming Bun request body");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	let consumed = false;
	const body = {
		getReader: () => ({
			read: async () => {
				if (consumed) return { done: true as const, value: undefined };
				consumed = true;
				return { done: false as const, value: bytes };
			},
		}),
	} as unknown as ReadableStream<Uint8Array>;

	await fixture.store.upload(jobId, sha256, body, bytes.byteLength, sha256);

	expect(
		await readFile(join(fixture.root, ".kastard", "workflow-inputs", jobId, sha256)),
	).toEqual(bytes);
});

test("keeps a completed upload when the body reader cannot release its lock", async () => {
	const fixture = await createFixture();
	const jobId = randomUUID();
	const bytes = Buffer.from("incoming Bun request body");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	let consumed = false;
	const body = {
		getReader: () => ({
			read: async () => {
				if (consumed) return { done: true as const, value: undefined };
				consumed = true;
				return { done: false as const, value: bytes };
			},
			releaseLock: () => {
				throw new TypeError("releaseLock is unavailable");
			},
		}),
	} as unknown as ReadableStream<Uint8Array>;

	await fixture.store.upload(jobId, sha256, body, bytes.byteLength, sha256);

	expect(
		await readFile(join(fixture.root, ".kastard", "workflow-inputs", jobId, sha256)),
	).toEqual(bytes);
});

test("cancels an incoming body reader after an early upload failure", async () => {
	const fixture = await createFixture();
	const jobId = randomUUID();
	const bytes = Buffer.from("oversized");
	const expected = Buffer.from("small");
	const sha256 = createHash("sha256").update(expected).digest("hex");
	let canceled = false;
	let released = false;
	const body = {
		getReader: () => ({
			read: async () => ({ done: false as const, value: bytes }),
			cancel: async () => {
				canceled = true;
			},
			releaseLock: () => {
				released = true;
			},
		}),
	} as unknown as ReadableStream<Uint8Array>;

	await expect(
		fixture.store.upload(jobId, sha256, body, expected.byteLength, sha256),
	).rejects.toMatchObject({
		failure: { problems: [expect.objectContaining({ reason: "too-large" })] },
	});
	expect(canceled).toBe(true);
	expect(released).toBe(true);
});

test("rewrites references serialized inside JSON string inputs", async () => {
	const fixture = await createFixture();
	const jobId = randomUUID();
	const bytes = Buffer.from("timeline frame");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const prompt = {
		"1": {
			class_type: "MiniMaxH3Director",
			inputs: {
				timeline_data: JSON.stringify({
					clips: [{ src: "frame.png" }, { src: "frame.png" }],
				}),
			},
		},
	};
	const inputs = [
		{
			id: sha256,
			name: "frame.png",
			size: bytes.byteLength,
			sha256,
			references: [{ nodeId: "1", inputName: "timeline_data", value: "frame.png" }],
		},
	];

	await fixture.store.upload(
		jobId,
		sha256,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	const rewritten = await fixture.store.publish(jobId, prompt, inputs);
	const timeline = JSON.parse(
		(rewritten["1"] as { inputs: { timeline_data: string } }).inputs.timeline_data,
	) as { clips: { src: string }[] };

	const workerReference = `kastard/${jobId}/${sha256}-frame.png`;
	expect(timeline.clips.map(({ src }) => src)).toEqual([
		workerReference,
		workerReference,
	]);
	expect(await readFile(join(fixture.root, "input", workerReference))).toEqual(bytes);
});

test("rejects serialized references that do not match the prompt", async () => {
	const fixture = await createFixture();
	const jobId = randomUUID();
	const bytes = Buffer.from("1234");
	const sha256 = createHash("sha256").update(bytes).digest("hex");

	await fixture.store.upload(
		jobId,
		sha256,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	await expect(
		fixture.store.publish(
			jobId,
			{
				"1": {
					class_type: "CustomNode",
					inputs: { data: JSON.stringify({ ref: "other.png" }) },
				},
			},
			[
				{
					id: sha256,
					name: "frame.png",
					size: bytes.byteLength,
					sha256,
					references: [{ nodeId: "1", inputName: "data", value: "frame.png" }],
				},
			],
		),
	).rejects.toMatchObject({
		failure: {
			problems: [expect.objectContaining({ reason: "invalid-reference" })],
		},
	});
	expect(await exists(join(fixture.root, "input", "kastard", jobId))).toBe(false);
});

test("keeps unmatched JSON content byte-identical when rewriting references", async () => {
	const fixture = await createFixture();
	const jobId = randomUUID();
	const bytes = Buffer.from("1234");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const serialized =
		'{"meta":{"__proto__":true,"big":9007199254740993},"ref":"frame.png"}';

	await fixture.store.upload(
		jobId,
		sha256,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	const rewritten = await fixture.store.publish(
		jobId,
		{
			"1": { class_type: "CustomNode", inputs: { data: serialized } },
		},
		[
			{
				id: sha256,
				name: "frame.png",
				size: bytes.byteLength,
				sha256,
				references: [{ nodeId: "1", inputName: "data", value: "frame.png" }],
			},
		],
	);

	const field = (rewritten["1"] as { inputs: { data: string } }).inputs.data;
	expect(field).toBe(
		`{"meta":{"__proto__":true,"big":9007199254740993},"ref":"kastard/${jobId}/${sha256}-frame.png"}`,
	);
});

test("rewrites every leaf when raw occurrences include non-leaf tokens", async () => {
	const fixture = await createFixture();
	const jobId = randomUUID();
	const bytes = Buffer.from("1234");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const workerReference = `kastard/${jobId}/${sha256}-frame.png`;

	await fixture.store.upload(
		jobId,
		sha256,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	const inputs = [
		{
			id: sha256,
			name: "frame.png",
			size: bytes.byteLength,
			sha256,
			references: [{ nodeId: "1", inputName: "data", value: "frame.png" }],
		},
	];

	// The token appears as a JSON key too: only the value leaf may be rewritten.
	const keyed = await fixture.store.publish(
		jobId,
		{
			"1": {
				class_type: "CustomNode",
				inputs: { data: '{"frame.png":0,"src":"frame.png"}' },
			},
		},
		inputs,
	);
	expect((keyed["1"] as { inputs: { data: string } }).inputs.data).toBe(
		`{"frame.png":0,"src":"${workerReference}"}`,
	);

	// Mixed literal and escaped encodings of the same filename: both leaves rewrite.
	const mixedJobId = randomUUID();
	const mixedWorkerReference = `kastard/${mixedJobId}/${sha256}-frame.png`;
	await fixture.store.upload(
		mixedJobId,
		sha256,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	const mixed = await fixture.store.publish(
		mixedJobId,
		{
			"1": {
				class_type: "CustomNode",
				inputs: { data: '["frame.png","fram\\u0065.png"]' },
			},
		},
		inputs,
	);
	expect(JSON.parse((mixed["1"] as { inputs: { data: string } }).inputs.data)).toEqual([
		mixedWorkerReference,
		mixedWorkerReference,
	]);

	// Keyed token plus an escaped leaf: matching counts must not fool the guard.
	const sneakyJobId = randomUUID();
	const sneakyWorkerReference = `kastard/${sneakyJobId}/${sha256}-frame.png`;
	await fixture.store.upload(
		sneakyJobId,
		sha256,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	const sneaky = await fixture.store.publish(
		sneakyJobId,
		{
			"1": {
				class_type: "CustomNode",
				inputs: { data: '{"frame.png":0,"src":"fram\\u0065.png"}' },
			},
		},
		inputs,
	);
	expect((sneaky["1"] as { inputs: { data: string } }).inputs.data).toBe(
		`{"frame.png":0,"src":"${sneakyWorkerReference}"}`,
	);
});

test("preserves unmatched numbers even when key conflicts force span rewriting", async () => {
	const fixture = await createFixture();
	const jobId = randomUUID();
	const bytes = Buffer.from("1234");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const workerReference = `kastard/${jobId}/${sha256}-frame.png`;
	const serialized =
		'{"frame.png":0,"big":9007199254740993,"src":"frame.png",' +
		'"nested":"{\\"seed\\":9007199254740994,\\"ref\\":\\"frame.png\\"}"}';

	await fixture.store.upload(
		jobId,
		sha256,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	const rewritten = await fixture.store.publish(
		jobId,
		{ "1": { class_type: "CustomNode", inputs: { data: serialized } } },
		[
			{
				id: sha256,
				name: "frame.png",
				size: bytes.byteLength,
				sha256,
				references: [{ nodeId: "1", inputName: "data", value: "frame.png" }],
			},
		],
	);

	expect((rewritten["1"] as { inputs: { data: string } }).inputs.data).toBe(
		`{"frame.png":0,"big":9007199254740993,"src":"${workerReference}",` +
			`"nested":"{\\"seed\\":9007199254740994,\\"ref\\":\\"${workerReference}\\"}"}`,
	);
});

test("rejects checksum, size, and manifest mismatches without publishing bytes", async () => {
	const fixture = await createFixture({ maxFileBytes: 4, maxJobBytes: 4 });
	const jobId = randomUUID();
	const bytes = Buffer.from("1234");
	const sha256 = createHash("sha256").update(bytes).digest("hex");

	await expect(
		fixture.store.upload(jobId, sha256, new Response("nope").body, 4, sha256),
	).rejects.toMatchObject({
		failure: {
			code: "input_failed",
			message: expect.any(String),
			problems: [expect.objectContaining({ reason: "checksum-mismatch" })],
		},
	});
	await expect(
		fixture.store.upload(randomUUID(), sha256, new Response("12345").body, 5, sha256),
	).rejects.toMatchObject({
		failure: { problems: [expect.objectContaining({ reason: "too-large" })] },
	});

	await fixture.store.upload(
		jobId,
		sha256,
		new Response(bytes).body,
		bytes.byteLength,
		sha256,
	);
	const extraBytes = Buffer.from("x");
	const extraSha256 = createHash("sha256").update(extraBytes).digest("hex");
	await expect(
		fixture.store.upload(
			jobId,
			extraSha256,
			new Response(extraBytes).body,
			extraBytes.byteLength,
			extraSha256,
		),
	).rejects.toMatchObject({
		failure: { problems: [expect.objectContaining({ reason: "too-large" })] },
	});
	await expect(
		fixture.store.publish(
			jobId,
			{
				"1": { class_type: "LoadImage", inputs: { image: "different.png" } },
			},
			[
				{
					id: sha256,
					name: "source.png",
					size: bytes.byteLength,
					sha256,
					references: [
						{
							nodeId: "1",
							inputName: "image",
							value: "source.png",
						},
					],
				},
			],
		),
	).rejects.toMatchObject({
		failure: {
			problems: [expect.objectContaining({ reason: "invalid-reference" })],
		},
	});
	expect(await exists(join(fixture.root, "input", "kastard", jobId))).toBe(false);
});

test("atomically limits and reclaims staging across workflow jobs", async () => {
	const fixture = await createFixture({
		maxFileBytes: 4,
		maxJobBytes: 4,
		maxStagingBytes: 4,
	});
	const bytes = Buffer.from("123");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const jobs = [randomUUID(), randomUUID()];
	const results = await Promise.allSettled(
		jobs.map((jobId) =>
			fixture.store.upload(
				jobId,
				sha256,
				new Response(bytes).body,
				bytes.byteLength,
				sha256,
			),
		),
	);

	expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
	const accepted = results.findIndex(({ status }) => status === "fulfilled");
	const rejected = results.findIndex(({ status }) => status === "rejected");
	expect(results[rejected]).toMatchObject({
		status: "rejected",
		reason: {
			failure: { problems: [expect.objectContaining({ reason: "too-large" })] },
		},
	});

	await fixture.store.cleanup(jobs[accepted] ?? "");
	await expect(
		fixture.store.upload(
			jobs[rejected] ?? "",
			sha256,
			new Response(bytes).body,
			bytes.byteLength,
			sha256,
		),
	).resolves.toBeUndefined();
});

async function createFixture(
	limits: {
		maxFileBytes?: number;
		maxJobBytes?: number;
		maxStagingBytes?: number;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "kastard-worker-inputs-"));
	temporaryDirectories.push(root);
	return {
		root,
		store: new WorkflowInputStore({
			getRootDirectory: () => root,
			...limits,
		}),
	};
}

async function exists(path: string): Promise<boolean> {
	return (await stat(path).catch(() => null)) !== null;
}
