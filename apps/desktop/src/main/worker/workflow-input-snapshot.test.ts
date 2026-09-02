// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WorkflowInputSnapshotStore } from "./workflow-input-snapshot";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("freezes referenced ComfyUI files when the workflow enters the Queue", async () => {
	const fixture = await createFixture();
	const source = join(fixture.dataDirectory, "data", "input", "reference.png");
	await writeFile(source, "original bytes");
	const prompt = {
		"1": { class_type: "LoadImage", inputs: { image: "reference.png" } },
		"2": { class_type: "LoadImage", inputs: { image: "reference.png" } },
	};

	const snapshot = await fixture.store.create(
		"11111111-1111-4111-8111-111111111111",
		prompt,
	);
	await writeFile(source, "changed bytes");

	expect(snapshot.prompt).toEqual(prompt);
	expect(snapshot.prompt).not.toBe(prompt);
	expect(snapshot.inputs).toHaveLength(1);
	expect(snapshot.inputs[0]).toMatchObject({
		name: "reference.png",
		size: Buffer.byteLength("original bytes"),
		references: [
			{ nodeId: "1", inputName: "image", value: "reference.png" },
			{ nodeId: "2", inputName: "image", value: "reference.png" },
		],
	});
	expect(await readFile(snapshot.inputs[0]?.path ?? "", "utf8")).toBe("original bytes");
});

test("preserves distinct filenames even when their bytes match", async () => {
	const fixture = await createFixture();
	const inputDirectory = join(fixture.dataDirectory, "data", "input");
	await Promise.all([
		writeFile(join(inputDirectory, "image.png"), "same bytes"),
		writeFile(join(inputDirectory, "video.mp4"), "same bytes"),
	]);

	const snapshot = await fixture.store.create("88888888-8888-4888-8888-888888888888", {
		"1": { class_type: "LoadImage", inputs: { image: "image.png" } },
		"2": { class_type: "LoadImage", inputs: { image: "video.mp4" } },
	});

	expect(snapshot.inputs.map(({ name }) => name)).toEqual(["image.png", "video.mp4"]);
	expect(new Set(snapshot.inputs.map(({ id }) => id)).size).toBe(2);
	expect(new Set(snapshot.inputs.map(({ sha256 }) => sha256)).size).toBe(1);
});

test("supports annotated ComfyUI files and rejects paths outside the data directory", async () => {
	const fixture = await createFixture();
	await writeFile(
		join(fixture.dataDirectory, "data", "output", "previous.png"),
		"output bytes",
	);

	await expect(
		fixture.store.create("22222222-2222-4222-8222-222222222222", {
			"1": {
				class_type: "LoadImage",
				inputs: { image: "previous.png [output]" },
			},
		}),
	).resolves.toMatchObject({
		inputs: [{ name: "previous.png", size: Buffer.byteLength("output bytes") }],
	});

	await writeFile(join(fixture.root, "outside.png"), "outside");
	await expect(
		fixture.store.create("33333333-3333-4333-8333-333333333333", {
			"1": { class_type: "LoadImage", inputs: { image: "../../outside.png" } },
		}),
	).rejects.toMatchObject({
		failure: {
			code: "input_failed",
			message: expect.any(String),
			problems: [expect.objectContaining({ reason: "missing" })],
		},
	});
});

test("snapshots a collected Worker output reused by a later workflow", async () => {
	const fixture = await createFixture();
	const relativePath = `kastard/11111111-1111-4111-8111-111111111111/${"a".repeat(64)}/result.mp4`;
	const output = join(fixture.dataDirectory, "data", "output", relativePath);
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, "remote video");

	const snapshot = await fixture.store.create("22222222-2222-4222-8222-222222222222", {
		"1": {
			class_type: "LoadVideo",
			inputs: { video: `${relativePath} [output]` },
		},
	});

	expect(snapshot.inputs).toMatchObject([
		{
			name: "result.mp4",
			size: Buffer.byteLength("remote video"),
			references: [
				{
					nodeId: "1",
					inputName: "video",
					value: `${relativePath} [output]`,
				},
			],
		},
	]);
});

test("enforces per-file, per-job, and queued snapshot limits", async () => {
	const fixture = await createFixture({
		maxFileBytes: 4,
		maxJobBytes: 6,
		maxTotalBytes: 6,
	});
	const input = join(fixture.dataDirectory, "data", "input");
	await writeFile(join(input, "large.png"), "12345");

	await expect(
		fixture.store.create("44444444-4444-4444-8444-444444444444", {
			"1": { class_type: "LoadImage", inputs: { image: "large.png" } },
		}),
	).rejects.toMatchObject({
		failure: { problems: [expect.objectContaining({ reason: "too-large" })] },
	});

	await writeFile(join(input, "small.png"), "1234");
	await fixture.store.create("55555555-5555-4555-8555-555555555555", {
		"1": { class_type: "LoadImage", inputs: { image: "small.png" } },
	});
	await expect(
		fixture.store.create("66666666-6666-4666-8666-666666666666", {
			"1": { class_type: "LoadImage", inputs: { image: "small.png" } },
		}),
	).rejects.toMatchObject({
		failure: { problems: [expect.objectContaining({ reason: "too-large" })] },
	});

	await fixture.store.cleanup("55555555-5555-4555-8555-555555555555");
	await expect(
		fixture.store.create("77777777-7777-4777-8777-777777777777", {
			"1": { class_type: "LoadImage", inputs: { image: "small.png" } },
		}),
	).resolves.toMatchObject({ inputs: [expect.objectContaining({ size: 4 })] });
});

test("snapshots workflows without local node definitions", async () => {
	const requestFetch = vi.fn();
	const fixture = await createFixture(
		{},
		{ getRuntimeUrl: () => null, requestFetch: requestFetch as typeof fetch },
	);
	const prompt = {
		"1": {
			class_type: "KastardTestNode",
			inputs: {
				text: "A remote-only workflow",
				checkpoint_name: "remote-model.safetensors",
				seed: 1,
				source: ["2", 0],
			},
		},
	};

	await expect(
		fixture.store.create("99999999-9999-4999-8999-999999999999", prompt),
	).resolves.toMatchObject({ prompt, inputs: [] });
	expect(requestFetch).not.toHaveBeenCalled();
});

test("uses cached node definitions when local ComfyUI becomes unavailable", async () => {
	let runtimeUrl: string | null = "http://127.0.0.1:8188/";
	const requestFetch = vi.fn(async () =>
		Response.json({
			LoadImage: {
				input: { required: { image: [[], { image_upload: true }] } },
			},
		}),
	);
	const fixture = await createFixture(
		{},
		{
			getRuntimeUrl: () => runtimeUrl,
			requestFetch: requestFetch as typeof fetch,
		},
	);
	await writeFile(
		join(fixture.dataDirectory, "data", "input", "cached.png"),
		"cached bytes",
	);
	const prompt = {
		"1": { class_type: "LoadImage", inputs: { image: "cached.png" } },
	};

	await fixture.store.create("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", prompt);
	runtimeUrl = null;
	await expect(
		fixture.store.create("cccccccc-cccc-4ccc-8ccc-cccccccccccc", prompt),
	).resolves.toMatchObject({
		inputs: [expect.objectContaining({ name: "cached.png" })],
	});
	expect(requestFetch).toHaveBeenCalledOnce();
});

test("collects files serialized inside JSON string inputs of any node", async () => {
	const fixture = await createFixture();
	const inputDirectory = join(fixture.dataDirectory, "data", "input");
	await Promise.all([
		writeFile(join(inputDirectory, "frame-a.png"), "frame a"),
		writeFile(join(inputDirectory, "frame-b.png"), "frame b"),
	]);

	const snapshot = await fixture.store.create("dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
		"1": {
			class_type: "MiniMaxH3Director",
			inputs: {
				timeline_data: JSON.stringify({
					clips: [
						{ src: "frame-a.png", nested: [{ ref: "frame-b.png" }] },
						{ src: "frame-a.png" },
					],
					note: "missing-file.png",
				}),
			},
		},
	});

	expect(snapshot.inputs.map(({ name }) => name).sort()).toEqual([
		"frame-a.png",
		"frame-b.png",
	]);
	const frameA = snapshot.inputs.find(({ name }) => name === "frame-a.png");
	expect(frameA?.references).toEqual([
		{ nodeId: "1", inputName: "timeline_data", value: "frame-a.png" },
	]);
});

test("collects annotated files serialized inside JSON string inputs", async () => {
	const fixture = await createFixture();
	await writeFile(
		join(fixture.dataDirectory, "data", "output", "previous.png"),
		"output bytes",
	);

	const snapshot = await fixture.store.create("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", {
		"1": {
			class_type: "CustomPreviewNode",
			inputs: { config: JSON.stringify({ image: "previous.png [output]" }) },
		},
	});

	expect(snapshot.inputs).toHaveLength(1);
	expect(snapshot.inputs[0]).toMatchObject({
		name: "previous.png",
		size: Buffer.byteLength("output bytes"),
		references: [{ nodeId: "1", inputName: "config", value: "previous.png [output]" }],
	});
});

test("deduplicates files referenced by both upload inputs and serialized strings", async () => {
	const fixture = await createFixture();
	await writeFile(
		join(fixture.dataDirectory, "data", "input", "shared.png"),
		"shared bytes",
	);

	const snapshot = await fixture.store.create("ffffffff-ffff-4fff-8fff-ffffffffffff", {
		"1": { class_type: "LoadImage", inputs: { image: "shared.png" } },
		"2": {
			class_type: "CustomNode",
			inputs: { data: JSON.stringify({ ref: "shared.png" }) },
		},
	});

	expect(snapshot.inputs).toHaveLength(1);
	expect(snapshot.inputs[0]?.references).toEqual([
		{ nodeId: "1", inputName: "image", value: "shared.png" },
		{ nodeId: "2", inputName: "data", value: "shared.png" },
	]);
});

test("collects plain string inputs matching files and ignores non-file text", async () => {
	const fixture = await createFixture();
	await Promise.all([
		writeFile(join(fixture.dataDirectory, "data", "input", "plain.png"), "plain bytes"),
		writeFile(join(fixture.dataDirectory, "data", "input", "noext"), "no extension"),
	]);

	const snapshot = await fixture.store.create("12121212-1212-4212-8212-121212121212", {
		"1": {
			class_type: "CustomNode",
			inputs: {
				image: "plain.png",
				prompt: "a landscape without any extension",
				missing: "missing-file.png",
				extensionless: "noext",
			},
		},
	});

	expect(snapshot.inputs).toHaveLength(1);
	expect(snapshot.inputs[0]).toMatchObject({
		name: "plain.png",
		references: [{ nodeId: "1", inputName: "image", value: "plain.png" }],
	});
});

test("collects files inside link-shaped arrays of serialized JSON", async () => {
	const fixture = await createFixture();
	await writeFile(
		join(fixture.dataDirectory, "data", "input", "pair.png"),
		"pair bytes",
	);

	const snapshot = await fixture.store.create("13131313-1313-4313-8313-131313131313", {
		"1": {
			class_type: "CustomNode",
			inputs: { data: JSON.stringify({ pairs: [["pair.png", 0]] }) },
		},
	});

	expect(snapshot.inputs.map(({ name }) => name)).toEqual(["pair.png"]);
});

test("collects matching files even when node definitions are unavailable", async () => {
	const fixture = await createFixture(
		{},
		{ getRuntimeUrl: () => null, requestFetch: vi.fn() as typeof fetch },
	);
	await writeFile(
		join(fixture.dataDirectory, "data", "input", "offline.png"),
		"offline bytes",
	);

	const snapshot = await fixture.store.create("14141414-1414-4414-8414-141414141414", {
		"1": { class_type: "LoadImage", inputs: { image: "offline.png" } },
	});

	expect(snapshot.inputs.map(({ name }) => name)).toEqual(["offline.png"]);
});

test("scans nested encodings and annotations while ignoring escaping paths", async () => {
	const fixture = await createFixture();
	await Promise.all([
		writeFile(join(fixture.dataDirectory, "data", "temp", "scratch.png"), "temp bytes"),
		writeFile(join(fixture.dataDirectory, "data", "input", "inner.png"), "inner bytes"),
	]);

	const snapshot = await fixture.store.create("15151515-1515-4515-8515-151515151515", {
		"1": {
			class_type: "CustomNode",
			inputs: {
				temp_ref: "scratch.png [temp]",
				double: JSON.stringify({ inner: JSON.stringify({ src: "inner.png" }) }),
				escape: "../../outside.png",
			},
		},
	});

	expect(snapshot.inputs.map(({ name }) => name).sort()).toEqual([
		"inner.png",
		"scratch.png",
	]);
});

async function createFixture(
	limits: { maxFileBytes?: number; maxJobBytes?: number; maxTotalBytes?: number } = {},
	options: {
		getRuntimeUrl?: () => string | null;
		requestFetch?: typeof fetch;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "kastard-workflow-inputs-"));
	temporaryDirectories.push(root);
	const dataDirectory = join(root, "comfy");
	await Promise.all(
		["input", "output", "temp"].map((name) =>
			mkdir(join(dataDirectory, "data", name), { recursive: true }),
		),
	);
	const store = new WorkflowInputSnapshotStore({
		dataDirectory,
		rootDirectory: join(root, "snapshots"),
		getRuntimeUrl: options.getRuntimeUrl ?? (() => "http://127.0.0.1:8188/"),
		requestFetch:
			options.requestFetch ??
			(async () =>
				Response.json({
					LoadImage: {
						input: { required: { image: [[], { image_upload: true }] } },
					},
				})),
		...limits,
	});
	await store.initialize();
	return { root, dataDirectory, store };
}
