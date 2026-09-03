import { afterEach, describe, expect, test } from "bun:test";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	fetchWithSafeRedirects,
	ModelProvisioner,
	type ModelSyncState,
	type ModelSyncTarget,
} from "./model-provisioner";
import { WorkerLogStore } from "./worker-log";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("ModelProvisioner", () => {
	test("removes abandoned model download staging on startup", async () => {
		const root = await temporaryDirectory();
		const abandoned = join(root, ".kastard", "model-downloads", "abandoned");
		await mkdir(abandoned, { recursive: true });
		await writeFile(join(abandoned, "partial-model"), "partial");

		await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
		});

		await expect(access(abandoned)).rejects.toThrow();
	});

	test("uses only credentials supplied by the Editor request", async () => {
		const root = await temporaryDirectory();
		const models = [
			target("huggingface-model", "huggingface", 5),
			target("civitai-model", "civitai", 6),
		];
		const tokens = new Map<string, string | undefined>();
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (model, token, staging) => {
				tokens.set(model.artifact.provider, token);
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(model.artifact.sizeBytes));
				return path;
			},
		});

		provisioner.sync({
			models,
			credentials: { huggingface: "request-huggingface-token" },
		});
		await waitForState(provisioner, "synced");

		expect(tokens).toEqual(
			new Map([
				["huggingface", "request-huggingface-token"],
				["civitai", undefined],
			]),
		);
	});

	test("downloads anonymously when Editor credentials are unset", async () => {
		const root = await temporaryDirectory();
		const models = [
			target("public-huggingface", "huggingface", 5),
			target("public-civitai", "civitai", 6),
		];
		const tokens: Array<string | undefined> = [];
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (model, token, staging) => {
				tokens.push(token);
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(model.artifact.sizeBytes));
				return path;
			},
		});

		provisioner.sync({ models, credentials: {} });
		await waitForState(provisioner, "synced");

		expect(tokens).toEqual([undefined, undefined]);
	});

	test.each([
		{
			token: undefined,
			expected:
				"private: CivitAI authentication is required for this model. Configure its token in Kastard Settings.",
		},
		{
			token: "private-civitai-token",
			expected:
				"private: CivitAI rejected the token configured in Kastard. Check that it is valid and can access this model.",
		},
	])(
		"reports actionable CivitAI authentication errors",
		async ({ token, expected }) => {
			const { state, logs } = await runCivitaiFailure(
				"private",
				async () => new Response("denied", { status: 401 }),
				token,
			);

			expect(state).toMatchObject({ status: "failed", error: expected });
			expect(logs.at(-1)?.message).toContain(expected);
			if (token !== undefined) {
				expect(JSON.stringify(state)).not.toContain(token);
				expect(JSON.stringify(logs)).not.toContain(token);
			}
		},
	);

	test("streams Hugging Face download progress into model state", async () => {
		const root = await temporaryDirectory();
		const runtimePython = join(root, "fake-python");
		const release = join(root, "release-download");
		await writeFile(
			runtimePython,
			`#!/usr/bin/env bun
const request = JSON.parse(await Bun.stdin.text());
console.error(JSON.stringify({ downloadedBytes: -1 }));
console.error(JSON.stringify({ downloadedBytes: 2 }));
while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(2);
const path = request.directory + "/download";
await Bun.write(path, new Uint8Array(5));
console.log(JSON.stringify({ path }));
`,
		);
		await chmod(runtimePython, 0o755);
		const logs = new WorkerLogStore({ instanceId: "worker" });
		const cursor = logs.getCursor();
		const model = target("streamed-progress", "huggingface", 5);
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython,
			logs,
		});

		provisioner.sync({ models: [model], credentials: {} });
		const downloading = await waitForDownloadedBytes(provisioner, 2);

		expect(downloading).toMatchObject({
			status: "syncing",
			completedBytes: 2,
			modelSnapshot: {
				models: [{ path: model.path, status: "downloading", downloadedBytes: 2 }],
			},
		});
		expect(logs.readAfter(cursor).logs.map(({ message }) => message)).toEqual([
			`Downloading ${model.path}.`,
			`Downloading ${model.path}: 40%.`,
		]);

		await writeFile(release, "");
		await waitForState(provisioner, "synced");
		expect(logs.readAfter(cursor).logs.map(({ message }) => message)).toEqual([
			`Downloading ${model.path}.`,
			`Downloading ${model.path}: 40%.`,
			`Downloaded ${model.path}.`,
			"1 models are ready.",
		]);
	});

	test.each(["metadata", "download"])(
		"reports CivitAI region blocks from the %s request",
		async (request) => {
			let calls = 0;
			const { state, logs } = await runCivitaiFailure("blocked", async () => {
				calls += 1;
				return request === "metadata" || calls === 2
					? Response.json(
							{
								error:
									"Access to this service is not available in your region due to legal restrictions.",
								code: "REGION_BLOCKED",
							},
							{ status: 451 },
						)
					: Response.json({
							modelId: 1,
							files: [
								{
									id: 3,
									downloadUrl: "https://civitai.com/api/download/models/3",
									hashes: {},
								},
							],
						});
			});
			const expected =
				"blocked: CivitAI access is blocked in this Worker's region due to legal restrictions. Use a Worker in a supported region.";

			expect(state).toMatchObject({ status: "failed", error: expected });
			expect(logs.at(-1)?.message).toContain(expected);
		},
	);

	test("keeps an unconfirmed CivitAI HTTP 451 generic", async () => {
		const { state } = await runCivitaiFailure(
			"unconfirmed",
			async () => new Response("denied", { status: 451 }),
		);

		expect(state).toMatchObject({
			status: "failed",
			error: "unconfirmed: CivitAI returned HTTP 451.",
		});
	});

	test.each([
		{
			token: undefined,
			expected:
				"private: Hugging Face authentication is required for this model. Configure its token in Kastard Settings.",
		},
		{
			token: "private-huggingface-token",
			expected:
				"private: Hugging Face rejected the token configured in Kastard. Check that it is valid and can access this model.",
		},
	])(
		"reports actionable Hugging Face authentication errors",
		async ({ token, expected }) => {
			const root = await temporaryDirectory();
			const runtimePython = join(root, "fake-python");
			await writeFile(
				runtimePython,
				`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ error: { status: 403, message: `denied ${token ?? "anonymous"}` } })}'\nexit 1\n`,
			);
			await chmod(runtimePython, 0o755);
			const logs = new WorkerLogStore({ instanceId: "worker" });
			const cursor = logs.getCursor();
			const provisioner = await ModelProvisioner.create({
				rootDirectory: root,
				runtimePython,
				logs,
			});

			provisioner.sync({
				models: [target("private", "huggingface", 5)],
				credentials: token === undefined ? {} : { huggingface: token },
			});
			const state = await waitForState(provisioner, "failed");

			expect(state).toMatchObject({ status: "failed", error: expected });
			if (token !== undefined) {
				expect(JSON.stringify(state)).not.toContain(token);
				expect(JSON.stringify(logs.readAfter(cursor))).not.toContain(token);
			}
		},
	);

	test("removes provider authorization before following a cross-origin redirect", async () => {
		const originalFetch = globalThis.fetch;
		const requests: Array<{ url: string; authorization: string | null }> = [];
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			requests.push({ url, authorization: headers.get("Authorization") });
			return requests.length === 1
				? new Response(null, {
						status: 302,
						headers: { Location: "https://cdn.example.com/model.safetensors" },
					})
				: new Response("model");
		}) as typeof fetch;
		try {
			const headers = new Headers({ Authorization: "Bearer provider-token" });
			const response = await fetchWithSafeRedirects(
				new URL("https://civitai.com/api/download/models/1"),
				headers,
			);
			expect(await response.text()).toBe("model");
			expect(requests).toEqual([
				{
					url: "https://civitai.com/api/download/models/1",
					authorization: "Bearer provider-token",
				},
				{
					url: "https://cdn.example.com/model.safetensors",
					authorization: null,
				},
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("does not send provider authorization to a direct cross-origin download", async () => {
		const root = await temporaryDirectory();
		const model = target("direct-download", "civitai", 5);
		const originalFetch = globalThis.fetch;
		const requests: Array<{ url: string; authorization: string | null }> = [];
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			requests.push({ url, authorization: headers.get("Authorization") });
			return requests.length === 1
				? Response.json({
						modelId: 1,
						files: [
							{
								id: 3,
								downloadUrl: "https://cdn.example.com/model.safetensors",
								hashes: {},
							},
						],
					})
				: new Response("model");
		}) as typeof fetch;
		try {
			const provisioner = await ModelProvisioner.create({
				rootDirectory: root,
				runtimePython: "/runtime/python",
				logs: new WorkerLogStore(),
			});

			provisioner.sync({
				models: [model],
				credentials: { civitai: "provider-token" },
			});
			await waitForState(provisioner, "synced");

			expect(requests).toEqual([
				{
					url: "https://civitai.com/api/v1/model-versions/2",
					authorization: "Bearer provider-token",
				},
				{
					url: "https://cdn.example.com/model.safetensors",
					authorization: null,
				},
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("reuses matching files and downloads only missing targets", async () => {
		const root = await temporaryDirectory();
		const existing = target("existing", "huggingface", 7);
		const missing = target("missing", "civitai", 11);
		await mkdir(dirname(join(root, "models", existing.path)), { recursive: true });
		await writeFile(join(root, "models", existing.path), Buffer.alloc(7, 1));
		const downloaded: string[] = [];
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (model, _token, staging, onProgress) => {
				downloaded.push(model.path);
				onProgress(model.artifact.sizeBytes);
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(model.artifact.sizeBytes, 2));
				return path;
			},
		});

		provisioner.sync({ models: [existing, missing], credentials: {} });
		const state = await waitForState(provisioner, "synced");

		expect(downloaded).toEqual([missing.path]);
		expect(state).toMatchObject({ status: "synced", models: [existing, missing] });
		expect(await readFile(join(root, "models", existing.path))).toEqual(
			Buffer.alloc(7, 1),
		);
		expect(await readFile(join(root, "models", missing.path))).toEqual(
			Buffer.alloc(11, 2),
		);
	});

	test("records model download milestones instead of every progress update", async () => {
		const root = await temporaryDirectory();
		const logs = new WorkerLogStore({ instanceId: "worker" });
		const cursor = logs.getCursor();
		const model = target("logged-progress", "civitai", 100);
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs,
			download: async (target, _token, staging, onProgress) => {
				for (let bytes = 1; bytes <= target.artifact.sizeBytes; bytes += 1) {
					onProgress(bytes);
				}
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(target.artifact.sizeBytes));
				return path;
			},
		});

		provisioner.sync({ models: [model], credentials: {} });
		await waitForState(provisioner, "synced");

		expect(logs.readAfter(cursor).logs.map(({ message }) => message)).toEqual([
			`Downloading ${model.path}.`,
			...Array.from(
				{ length: 9 },
				(_value, index) => `Downloading ${model.path}: ${(index + 1) * 10}%.`,
			),
			`Downloaded ${model.path}.`,
			"1 models are ready.",
		]);
	});

	test("verifies the recorded artifact and current Worker file without mutating sync state", async () => {
		const root = await temporaryDirectory();
		const model = target("verified", "huggingface", 7);
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (target, _token, staging) => {
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(target.artifact.sizeBytes));
				return path;
			},
		});
		provisioner.sync({ models: [model], credentials: {} });
		const synced = await waitForState(provisioner, "synced");

		expect(await provisioner.verify({ models: [model] })).toEqual({
			status: "synced",
			total: 1,
		});
		expect(
			await provisioner.verify({ models: [{ ...model, name: "Renamed model" }] }),
		).toEqual({
			status: "synced",
			total: 1,
		});
		const changedArtifact = {
			...model,
			artifact: { ...model.artifact, versionId: "b".repeat(40) },
		};
		expect(await provisioner.verify({ models: [changedArtifact] })).toMatchObject({
			status: "out-of-sync",
			problems: [{ reason: "stale", name: model.path }],
		});
		await rm(join(root, "models", model.path));
		expect(await provisioner.verify({ models: [model] })).toMatchObject({
			status: "out-of-sync",
			problems: [{ reason: "missing", name: model.path }],
		});
		expect(provisioner.getState()).toEqual(synced);
		expect(await provisioner.verify({ models: [] })).toEqual({
			status: "synced",
			total: 0,
		});
	});

	test("does not reuse a same-sized file recorded for a different artifact", async () => {
		const root = await temporaryDirectory();
		const original = target("identity", "huggingface", 7);
		const selected = target("selected", "civitai", 5);
		const changed = {
			...original,
			artifact: { ...original.artifact, versionId: "b".repeat(40) },
		};
		const downloads: string[] = [];
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (model, _token, staging) => {
				downloads.push(model.path);
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(model.artifact.sizeBytes));
				return path;
			},
		});

		provisioner.sync({ models: [original], credentials: {} });
		await waitForState(provisioner, "synced");
		provisioner.sync({ models: [selected], credentials: {} });
		await waitForState(provisioner, "synced");
		expect(
			JSON.parse(await readFile(join(root, ".kastard", "model-sync.json"), "utf8")),
		).toEqual({
			version: 2,
			models: [selected],
			identities: [original, selected],
			complete: true,
		});
		provisioner.sync({ models: [changed], credentials: {} });
		expect(await waitForState(provisioner, "failed")).toMatchObject({
			status: "failed",
			models: [],
			total: 1,
			error: expect.stringContaining(original.path),
		});
		expect(downloads).toEqual([original.path, selected.path]);
		expect(await provisioner.verify({ models: [changed] })).toMatchObject({
			status: "out-of-sync",
			problems: [{ reason: "stale", name: original.path }],
		});

		provisioner.sync({ models: [changed], credentials: {} });
		expect(provisioner.cancel()).toMatchObject({ status: "canceling" });
		await waitForState(provisioner, "canceled");
		expect(await provisioner.verify({ models: [changed] })).toMatchObject({
			status: "out-of-sync",
			problems: [{ reason: "stale", name: original.path }],
		});

		provisioner.sync({ models: [original], credentials: {} });
		await waitForState(provisioner, "synced");
		expect(downloads).toEqual([original.path, selected.path]);
	});

	test("rejects unsupported model manifest versions", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, ".kastard"), { recursive: true });
		await writeFile(
			join(root, ".kastard", "model-sync.json"),
			`${JSON.stringify({ version: 1, models: [] })}\n`,
		);

		await expect(
			ModelProvisioner.create({
				rootDirectory: root,
				runtimePython: "/runtime/python",
				logs: new WorkerLogStore(),
			}),
		).rejects.toThrow("Stored model synchronization state is invalid.");
	});

	test("uses at most four downloads globally and two per provider", async () => {
		const root = await temporaryDirectory();
		const models = [
			target("hf-small", "huggingface", 3),
			target("hf-large", "huggingface", 9),
			target("hf-medium", "huggingface", 6),
			target("civ-small", "civitai", 4),
			target("civ-large", "civitai", 10),
			target("civ-medium", "civitai", 7),
		];
		let active = 0;
		let maxActive = 0;
		const providerActive = new Map<string, number>();
		const providerMax = new Map<string, number>();
		const starts: string[] = [];
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (model, _token, staging) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				const provider = model.artifact.provider;
				const currentProvider = (providerActive.get(provider) ?? 0) + 1;
				providerActive.set(provider, currentProvider);
				providerMax.set(
					provider,
					Math.max(providerMax.get(provider) ?? 0, currentProvider),
				);
				starts.push(model.name);
				await Bun.sleep(10);
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(model.artifact.sizeBytes));
				active -= 1;
				providerActive.set(provider, currentProvider - 1);
				return path;
			},
		});

		provisioner.sync({ models, credentials: {} });
		await waitForState(provisioner, "synced");

		expect(maxActive).toBe(4);
		expect(providerMax).toEqual(
			new Map([
				["huggingface", 2],
				["civitai", 2],
			]),
		);
		expect(
			starts
				.filter((name) => name.startsWith("hf-"))
				.slice(0, 2)
				.sort(),
		).toEqual(["hf-large", "hf-medium"]);
		expect(
			starts
				.filter((name) => name.startsWith("civ-"))
				.slice(0, 2)
				.sort(),
		).toEqual(["civ-large", "civ-medium"]);
	});

	test("does not overwrite an existing mismatched target", async () => {
		const root = await temporaryDirectory();
		const model = target("conflict", "huggingface", 8);
		const destination = join(root, "models", model.path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, "wrong");
		let downloads = 0;
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async () => {
				downloads += 1;
				return destination;
			},
		});

		provisioner.sync({ models: [model], credentials: {} });
		const state = await waitForState(provisioner, "failed");
		if (state.status !== "failed") throw new Error("Expected synchronization failure.");
		expect(state.error).toContain("do not match");
		expect(downloads).toBe(0);
		expect(await readFile(destination, "utf8")).toBe("wrong");
	});

	test("keeps successful siblings when another download fails", async () => {
		const root = await temporaryDirectory();
		const failed = target("failed", "huggingface", 5);
		const successful = target("successful", "civitai", 6);
		const logs = new WorkerLogStore({ instanceId: "worker" });
		const cursor = logs.getCursor();
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs,
			download: async (model, _token, staging) => {
				if (model.name === "failed") throw new Error("provider unavailable");
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(model.artifact.sizeBytes));
				return path;
			},
		});

		provisioner.sync({ models: [failed, successful], credentials: {} });
		const state = await waitForState(provisioner, "failed");

		expect(state).toMatchObject({
			status: "failed",
			models: [successful],
			total: 2,
			error: "failed: provider unavailable",
		});
		expect(await provisioner.verify({ models: [successful] })).toEqual({
			status: "synced",
			total: 1,
		});
		expect(await provisioner.verify({ models: [failed] })).toMatchObject({
			status: "out-of-sync",
			problems: [{ reason: "missing", name: failed.path }],
		});
		expect(logs.readAfter(cursor).logs.map(({ message }) => message)).not.toContain(
			`Downloaded ${failed.path}.`,
		);
		await access(join(root, "models", successful.path));
		await expect(access(join(root, "models", failed.path))).rejects.toThrow();
		const restored = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
		});
		expect(restored.getState()).toMatchObject({
			status: "idle",
			models: [successful],
		});
		expect(await restored.verify({ models: [successful] })).toEqual({
			status: "synced",
			total: 1,
		});
	});

	test("cancels active downloads, removes staging files, and reuses completed models", async () => {
		const root = await temporaryDirectory();
		const completed = target("completed", "huggingface", 5);
		const interrupted = target("interrupted", "civitai", 7);
		let blockDownloads = true;
		const downloads: string[] = [];
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (model, _token, staging, _onProgress, signal) => {
				downloads.push(model.name);
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(model.artifact.sizeBytes));
				if (model.name === interrupted.name && blockDownloads) {
					await new Promise<void>((_resolve, reject) => {
						const abort = (): void => reject(signal.reason);
						if (signal.aborted) abort();
						else signal.addEventListener("abort", abort, { once: true });
					});
				}
				return path;
			},
		});

		provisioner.sync({ models: [completed], credentials: {} });
		await waitForState(provisioner, "synced");
		provisioner.sync({ models: [completed, interrupted], credentials: {} });
		await waitForState(provisioner, "syncing");
		expect(provisioner.cancel()).toMatchObject({ status: "canceling" });
		expect(() =>
			provisioner.sync({ models: [completed, interrupted], credentials: {} }),
		).toThrow("already synchronizing");
		const canceled = await waitForState(provisioner, "canceled");
		expect(canceled).toMatchObject({
			status: "canceled",
			models: [completed],
		});
		expect(provisioner.cancel()).toEqual(canceled);
		expect(
			await readdir(join(root, ".kastard", "model-downloads")).catch(() => []),
		).toEqual([]);
		const restored = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
		});
		expect(restored.getState()).toMatchObject({
			status: "idle",
			models: [completed],
		});

		blockDownloads = false;
		provisioner.sync({ models: [completed, interrupted], credentials: {} });
		await waitForState(provisioner, "synced");
		provisioner.sync({ models: [completed, interrupted], credentials: {} });
		await waitForState(provisioner, "synced");
		expect(downloads).toEqual(["completed", "interrupted", "interrupted"]);
	});

	test("removes the current model before force redownload and records the new file", async () => {
		const root = await temporaryDirectory();
		const model = target("redownload", "huggingface", 7);
		const destination = join(root, "models", model.path);
		let fill = 1;
		let missingBeforeRedownload = false;
		let downloadCount = 0;
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (target, _token, staging) => {
				downloadCount += 1;
				if (downloadCount === 2)
					missingBeforeRedownload = !(await pathExists(destination));
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(target.artifact.sizeBytes, fill));
				return path;
			},
		});

		provisioner.sync({ models: [model], credentials: {} });
		await waitForState(provisioner, "synced");
		fill = 2;
		const started = provisioner.redownload({ models: [model], credentials: {} });
		expect(started).toMatchObject({
			status: "checking",
			operationKind: "redownload",
			target: { models: [model] },
		});
		const state = await waitForState(provisioner, "synced");

		expect(missingBeforeRedownload).toBe(true);
		expect(await readFile(destination)).toEqual(Buffer.alloc(7, 2));
		expect(state).toMatchObject({
			status: "synced",
			operationKind: "redownload",
			modelSnapshot: {
				models: [{ path: model.path, status: "ready", downloadedBytes: 7 }],
			},
		});
		expect(
			JSON.parse(await readFile(join(root, ".kastard", "model-sync.json"), "utf8")),
		).toEqual({
			version: 2,
			models: [model],
			identities: [model],
			complete: true,
		});
	});

	test("preserves completed manifest order after force redownload", async () => {
		const root = await temporaryDirectory();
		const models = [
			target("redownload-first", "huggingface", 7),
			target("redownload-second", "civitai", 8),
		];
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (target, _token, staging) => {
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(target.artifact.sizeBytes));
				return path;
			},
		});

		provisioner.sync({ models, credentials: {} });
		await waitForState(provisioner, "synced");
		provisioner.redownload({ models: [models[0]], credentials: {} });
		await waitForState(provisioner, "synced");

		expect(
			JSON.parse(await readFile(join(root, ".kastard", "model-sync.json"), "utf8")),
		).toEqual({
			version: 2,
			models,
			identities: models,
			complete: true,
		});
		const restored = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
		});
		expect(restored.getState()).toMatchObject({ status: "idle", models });
	});

	test("leaves a force-redownload target absent when the fresh download fails", async () => {
		const root = await temporaryDirectory();
		const model = target("redownload-failure", "huggingface", 7);
		const destination = join(root, "models", model.path);
		let fail = false;
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (target, _token, staging) => {
				if (fail) throw new Error("provider unavailable");
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(target.artifact.sizeBytes));
				return path;
			},
		});

		provisioner.sync({ models: [model], credentials: {} });
		await waitForState(provisioner, "synced");
		fail = true;
		provisioner.redownload({ models: [model], credentials: {} });
		const state = await waitForState(provisioner, "failed");

		expect(await pathExists(destination)).toBe(false);
		expect(state).toMatchObject({
			status: "failed",
			operationKind: "redownload",
			models: [],
			error: "provider unavailable",
			modelSnapshot: {
				models: [
					{
						path: model.path,
						status: "not-downloaded",
						downloadedBytes: 0,
						error: "provider unavailable",
					},
				],
			},
		});
		expect(await provisioner.verify({ models: [model] })).toMatchObject({
			status: "out-of-sync",
			problems: [{ reason: "missing", name: model.path }],
		});
		expect(
			JSON.parse(await readFile(join(root, ".kastard", "model-sync.json"), "utf8")),
		).toEqual({ version: 2, models: [], identities: [], complete: false });
	});

	test("cancels only the current force redownload and leaves the model absent", async () => {
		const root = await temporaryDirectory();
		const model = target("redownload-cancel", "huggingface", 7);
		const destination = join(root, "models", model.path);
		let block = false;
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async (target, _token, staging, _onProgress, signal) => {
				const path = join(staging, "download");
				await writeFile(path, Buffer.alloc(target.artifact.sizeBytes));
				if (block) {
					await new Promise<void>((_resolve, reject) => {
						const abort = (): void => reject(signal.reason);
						if (signal.aborted) abort();
						else signal.addEventListener("abort", abort, { once: true });
					});
				}
				return path;
			},
		});

		provisioner.sync({ models: [model], credentials: {} });
		await waitForState(provisioner, "synced");
		block = true;
		const started = provisioner.redownload({ models: [model], credentials: {} });
		if (started.operationId === null) throw new Error("Expected a model operation.");
		await waitForState(provisioner, "syncing");
		expect(() => provisioner.cancel()).toThrow(
			"Force redownload cancellation requires its operation id.",
		);
		expect(() => provisioner.cancel("stale-operation")).toThrow("no longer current");
		expect(provisioner.cancel(started.operationId)).toMatchObject({
			status: "canceling",
			operationId: started.operationId,
		});
		const canceled = await waitForState(provisioner, "canceled");

		expect(canceled).toMatchObject({
			operationKind: "redownload",
			models: [],
			modelSnapshot: {
				models: [{ path: model.path, status: "not-downloaded", downloadedBytes: 0 }],
			},
		});
		expect(await pathExists(destination)).toBe(false);
	});

	test("preserves an existing model when force redownload is canceled before inspection", async () => {
		const root = await temporaryDirectory();
		const model = target("redownload-early-cancel", "huggingface", 7);
		const destination = join(root, "models", model.path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, Buffer.alloc(7));
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
		});
		await writeFile(join(root, ".kastard", "model-sync.json"), "invalid");

		const started = provisioner.redownload({ models: [model], credentials: {} });
		if (started.operationId === null) throw new Error("Expected a model operation.");
		provisioner.cancel(started.operationId);
		const canceled = await waitForState(provisioner, "canceled");

		expect(canceled).toMatchObject({
			operationKind: "redownload",
			models: [model],
			modelSnapshot: {
				models: [{ path: model.path, status: "ready", downloadedBytes: 7 }],
			},
		});
		expect(await pathExists(destination)).toBe(true);
	});

	test.each(["directory", "symlink"] as const)(
		"does not remove a non-regular %s model target",
		async (kind) => {
			const root = await temporaryDirectory();
			const model = target(`redownload-${kind}`, "huggingface", 7);
			const destination = join(root, "models", model.path);
			await mkdir(dirname(destination), { recursive: true });
			if (kind === "directory") await mkdir(destination);
			else {
				const source = join(root, "outside-model.safetensors");
				await writeFile(source, Buffer.alloc(7));
				await symlink(source, destination);
			}
			let downloads = 0;
			const provisioner = await ModelProvisioner.create({
				rootDirectory: root,
				runtimePython: "/runtime/python",
				logs: new WorkerLogStore(),
				download: async () => {
					downloads += 1;
					throw new Error("should not download");
				},
			});

			provisioner.redownload({ models: [model], credentials: {} });
			const state = await waitForState(provisioner, "failed");

			expect(downloads).toBe(0);
			expect(await pathExists(destination)).toBe(true);
			expect(state).toMatchObject({
				operationKind: "redownload",
				error: "Force redownload can remove only a regular model file.",
				modelSnapshot: {
					models: [{ path: model.path, status: "needs-redownload" }],
				},
			});
		},
	);

	test("does not remove a model through a symlinked ancestor directory", async () => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		const model = target("redownload-ancestor-symlink", "huggingface", 7);
		const outsideTarget = join(outside, "redownload-ancestor-symlink.safetensors");
		await mkdir(join(root, "models"), { recursive: true });
		await writeFile(outsideTarget, Buffer.alloc(7));
		await symlink(outside, join(root, "models", "checkpoints"));
		let downloads = 0;
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async () => {
				downloads += 1;
				throw new Error("should not download");
			},
		});

		provisioner.redownload({ models: [model], credentials: {} });
		const state = await waitForState(provisioner, "failed");

		expect(downloads).toBe(0);
		expect(await readFile(outsideTarget)).toEqual(Buffer.alloc(7));
		expect(state).toMatchObject({
			error:
				"Force redownload can remove only a model file inside the models directory.",
			modelSnapshot: {
				models: [
					{
						path: model.path,
						status: "ready",
						downloadedBytes: 7,
					},
				],
			},
		});
	});

	test("does not create a missing model through a symlinked ancestor directory", async () => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		const model = target("redownload-missing-ancestor-symlink", "huggingface", 7);
		const outsideTarget = join(
			outside,
			"redownload-missing-ancestor-symlink.safetensors",
		);
		await mkdir(join(root, "models"), { recursive: true });
		await symlink(outside, join(root, "models", "checkpoints"));
		let downloads = 0;
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
			download: async () => {
				downloads += 1;
				throw new Error("should not download");
			},
		});

		provisioner.redownload({ models: [model], credentials: {} });
		const state = await waitForState(provisioner, "failed");

		expect(downloads).toBe(0);
		expect(await pathExists(outsideTarget)).toBe(false);
		expect(state).toMatchObject({
			error:
				"Force redownload can remove only a model file inside the models directory.",
		});
	});

	test("preserves matching models when canceled during inspection", async () => {
		const root = await temporaryDirectory();
		const existing = target("existing", "huggingface", 7);
		await mkdir(dirname(join(root, "models", existing.path)), { recursive: true });
		await writeFile(join(root, "models", existing.path), Buffer.alloc(7, 1));
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs: new WorkerLogStore(),
		});

		provisioner.sync({ models: [existing], credentials: {} });
		expect(provisioner.cancel()).toMatchObject({ status: "canceling" });

		expect(await waitForState(provisioner, "canceled")).toMatchObject({
			status: "canceled",
			models: [existing],
		});
	});
});

function target(
	name: string,
	provider: "huggingface" | "civitai",
	sizeBytes: number,
): ModelSyncTarget {
	return {
		name,
		path: `checkpoints/${name}.safetensors`,
		artifact: {
			provider,
			modelId: provider === "civitai" ? "1" : "owner/repository",
			versionId: provider === "civitai" ? "2" : "a".repeat(40),
			versionLabel: "version",
			fileId: provider === "civitai" ? "3" : `${name}.safetensors`,
			fileName: `${name}.safetensors`,
			sizeBytes,
		},
	};
}

async function runCivitaiFailure(
	name: string,
	fetchImplementation: () => Promise<Response>,
	token?: string,
) {
	const root = await temporaryDirectory();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImplementation as unknown as typeof fetch;
	try {
		const logs = new WorkerLogStore({ instanceId: "worker" });
		const cursor = logs.getCursor();
		const provisioner = await ModelProvisioner.create({
			rootDirectory: root,
			runtimePython: "/runtime/python",
			logs,
		});

		provisioner.sync({
			models: [target(name, "civitai", 5)],
			credentials: token === undefined ? {} : { civitai: token },
		});
		const state = await waitForState(provisioner, "failed");
		return { state, logs: logs.readAfter(cursor).logs };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "kastard-model-test-"));
	directories.push(directory);
	return directory;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function waitForState(
	provisioner: ModelProvisioner,
	status: ModelSyncState["status"],
): Promise<ModelSyncState> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const state = provisioner.getState();
		if (state.status === status) return state;
		await Bun.sleep(2);
	}
	throw new Error(`Timed out waiting for ${status}.`);
}

async function waitForDownloadedBytes(
	provisioner: ModelProvisioner,
	downloadedBytes: number,
): Promise<ModelSyncState> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const state = provisioner.getState();
		if (state.modelSnapshot?.models[0]?.downloadedBytes === downloadedBytes)
			return state;
		await Bun.sleep(2);
	}
	throw new Error(`Timed out waiting for ${downloadedBytes} downloaded bytes.`);
}
