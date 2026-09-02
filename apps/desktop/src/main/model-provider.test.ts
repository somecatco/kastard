// @vitest-environment node

import { describe, expect, test, vi } from "vitest";
import {
	resolveModelProviderInfo,
	verifyModelProviderArtifact,
} from "./model-provider";

describe("model provider files", () => {
	test("lists public Hugging Face model files without reading a configured token", async () => {
		const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({
				modelId: "black-forest-labs/FLUX.1-dev",
				sha: "3de623fc3c33e44ffbe2bad470d0f45bccf2eb21",
				siblings: [
					{ rfilename: "README.md", size: 20 },
					{ rfilename: "diffusion_models/flux.safetensors", size: 23_802_932_552 },
				],
			}),
		);
		const getToken = vi.fn(() => "hf_example");

		await expect(
			resolveModelProviderInfo(
				"https://huggingface.co/black-forest-labs/FLUX.1-dev",
				getToken,
				request as typeof fetch,
			),
		).resolves.toEqual({
			modelName: "FLUX.1-dev",
			files: [
				{
					provider: "huggingface",
					modelId: "black-forest-labs/FLUX.1-dev",
					versionId: "3de623fc3c33e44ffbe2bad470d0f45bccf2eb21",
					versionLabel: "3de623f",
					fileId: "diffusion_models/flux.safetensors",
					fileName: "diffusion_models/flux.safetensors",
					sizeBytes: 23_802_932_552,
				},
			],
		});
		expect(request).toHaveBeenCalledOnce();
		const call = request.mock.calls[0];
		if (!call) throw new Error("Expected a provider request.");
		const [url, init] = call;
		expect(String(url)).toBe(
			"https://huggingface.co/api/models/black-forest-labs/FLUX.1-dev?blobs=true",
		);
		expect(new Headers(init?.headers).has("Authorization")).toBe(false);
		expect(init?.redirect).toBe("error");
		expect(getToken).not.toHaveBeenCalled();
	});

	test("resolves a Hugging Face blob URL at its revision and selects that file", async () => {
		const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({
				modelId: "owner/model",
				sha: "a".repeat(40),
				siblings: [
					{
						rfilename: "diffusion_models/model.safetensors",
						size: 1024,
					},
					{ rfilename: "diffusion_models/other.safetensors", size: 2048 },
				],
			}),
		);

		await expect(
			resolveModelProviderInfo(
				"https://huggingface.co/owner/model/blob/main/diffusion_models/model.safetensors",
				() => null,
				request as typeof fetch,
			),
		).resolves.toEqual({
			modelName: "model",
			files: [
				{
					provider: "huggingface",
					modelId: "owner/model",
					versionId: "a".repeat(40),
					versionLabel: "aaaaaaa",
					fileId: "diffusion_models/model.safetensors",
					fileName: "diffusion_models/model.safetensors",
					sizeBytes: 1024,
				},
			],
		});
		expect(String(request.mock.calls[0]?.[0])).toBe(
			"https://huggingface.co/api/models/owner/model/revision/main?blobs=true",
		);
	});

	test("retries an authorization failure with the configured provider token", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(
				Response.json({
					modelId: "owner/model",
					sha: "revision",
					siblings: [{ rfilename: "model.safetensors", size: 1024 }],
				}),
			);
		const getToken = vi.fn(() => "hf_example");

		await expect(
			resolveModelProviderInfo("https://huggingface.co/owner/model", getToken, request),
		).resolves.toMatchObject({ modelName: "model", files: { length: 1 } });
		expect(request).toHaveBeenCalledTimes(2);
		expect(new Headers(request.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(
			false,
		);
		expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
			"Bearer hf_example",
		);
		expect(getToken).toHaveBeenCalledWith("huggingface");
	});

	test("follows a safe canonical redirect for a single-segment Hugging Face model", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 307,
					headers: {
						location: "/api/models/openai-community/gpt2?blobs=true",
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					modelId: "openai-community/gpt2",
					sha: "revision",
					siblings: [{ rfilename: "model.safetensors", size: 1024 }],
				}),
			);

		await expect(
			resolveModelProviderInfo("https://huggingface.co/gpt2", () => null, request),
		).resolves.toEqual({
			modelName: "gpt2",
			files: [
				{
					provider: "huggingface",
					modelId: "gpt2",
					versionId: "revision",
					versionLabel: "revisio",
					fileId: "model.safetensors",
					fileName: "model.safetensors",
					sizeBytes: 1024,
				},
			],
		});
		expect(String(request.mock.calls[0]?.[0])).toBe(
			"https://huggingface.co/api/models/gpt2?blobs=true",
		);
		expect(request.mock.calls[0]?.[1]?.redirect).toBe("manual");
		expect(String(request.mock.calls[1]?.[0])).toBe(
			"https://huggingface.co/api/models/openai-community/gpt2?blobs=true",
		);
		expect(request.mock.calls[1]?.[1]?.redirect).toBe("error");
	});

	test.each(["blob", "resolve"])(
		"resolves a single-segment Hugging Face %s URL at its revision",
		async (marker) => {
			const request = vi.fn(async (_input: string | URL | Request) =>
				Response.json({
					modelId: "gpt2",
					sha: "revision",
					siblings: [
						{ rfilename: "model.fp16.safetensors", size: 1024 },
						{ rfilename: "other.safetensors", size: 2048 },
					],
				}),
			);

			await expect(
				resolveModelProviderInfo(
					`https://huggingface.co/gpt2/${marker}/main/model.fp16.safetensors`,
					() => null,
					request as typeof fetch,
				),
			).resolves.toMatchObject({
				modelName: "model.fp16",
				files: [{ modelId: "gpt2", fileId: "model.fp16.safetensors" }],
			});
			expect(String(request.mock.calls[0]?.[0])).toBe(
				"https://huggingface.co/api/models/gpt2/revision/main?blobs=true",
			);
		},
	);

	test("keeps the repository name when a direct file has no usable stem", async () => {
		const request = vi.fn(async () =>
			Response.json({
				modelId: "owner/model",
				sha: "revision",
				siblings: [{ rfilename: ".safetensors", size: 1024 }],
			}),
		);

		await expect(
			resolveModelProviderInfo(
				"https://huggingface.co/owner/model/blob/main/.safetensors",
				() => null,
				request,
			),
		).resolves.toMatchObject({
			modelName: "model",
			files: [{ fileId: ".safetensors" }],
		});
	});

	test("reports no supported files for a direct non-model file", async () => {
		const request = vi.fn(async () =>
			Response.json({
				modelId: "owner/model",
				sha: "revision",
				siblings: [{ rfilename: "config.json", size: 1024 }],
			}),
		);

		await expect(
			resolveModelProviderInfo(
				"https://huggingface.co/owner/model/blob/main/config.json",
				() => null,
				request,
			),
		).rejects.toThrow("No supported model files");
	});

	test("filters a CivitAI model page to its selected version without a token", async () => {
		const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({
				id: 1102,
				name: "Synthwave",
				modelVersions: [
					{
						id: 1144,
						name: "V2",
						files: [{ id: 196, name: "v2.ckpt", sizeKB: 100 }],
					},
					{
						id: 1292,
						name: "V3 Alpha",
						files: [
							{ id: 194, name: "v3.safetensors", sizeKB: 2_082_691 },
							{ id: 195, name: "preview.png", sizeKB: 10 },
						],
					},
				],
			}),
		);

		await expect(
			resolveModelProviderInfo(
				"https://civitai.com/models/1102/synthwave?modelVersionId=1292",
				() => null,
				request as typeof fetch,
			),
		).resolves.toEqual({
			modelName: "v3",
			files: [
				{
					provider: "civitai",
					modelId: "1102",
					versionId: "1292",
					versionLabel: "V3 Alpha",
					fileId: "194",
					fileName: "v3.safetensors",
					sizeBytes: 2_132_675_584,
				},
			],
		});
		const call = request.mock.calls[0];
		if (!call) throw new Error("Expected a provider request.");
		const [, init] = call;
		expect(new Headers(init?.headers).has("Authorization")).toBe(false);
	});

	test.each([
		"civitai:1318945@3218603",
		"urn:air:sdxl:checkpoint:civitai:1318945@3218603",
	])("resolves CivitAI AIR %s through its model version URL", async (source) => {
		const request = vi.fn(async (_input: string | URL | Request) =>
			Response.json({
				id: 1318945,
				name: "One obsession",
				modelVersions: [
					{
						id: 3218603,
						name: "v24",
						files: [
							{
								id: 3100615,
								name: "oneObsession_v24.safetensors",
								sizeKB: 6_775_430.353515625,
							},
						],
					},
				],
			}),
		);

		await expect(
			resolveModelProviderInfo(source, () => null, request as typeof fetch),
		).resolves.toEqual({
			modelName: "oneObsession v24",
			files: [
				{
					provider: "civitai",
					modelId: "1318945",
					versionId: "3218603",
					versionLabel: "v24",
					fileId: "3100615",
					fileName: "oneObsession_v24.safetensors",
					sizeBytes: 6_938_040_682,
				},
			],
		});
		expect(String(request.mock.calls[0]?.[0])).toBe(
			"https://civitai.com/api/v1/models/1318945",
		);
	});

	test("selects the file identified by a CivitAI AIR", async () => {
		const request = vi.fn(async () =>
			Response.json({
				id: 599757,
				name: "Anima LoRA",
				modelVersions: [
					{
						id: 3226360,
						name: "v1",
						files: [
							{ id: 3108500, name: "selected.safetensors", sizeKB: 100 },
							{ id: 3108501, name: "other.safetensors", sizeKB: 200 },
						],
					},
				],
			}),
		);

		await expect(
			resolveModelProviderInfo(
				"urn:air:anima:lora:civitai:599757@3226360+3108500",
				() => null,
				request,
			),
		).resolves.toMatchObject({
			modelName: "selected",
			files: [{ fileId: "3108500", fileName: "selected.safetensors" }],
		});
		await expect(
			resolveModelProviderInfo(
				"urn:air:anima:lora:civitai:599757@3226360+3108502",
				() => null,
				request,
			),
		).rejects.toThrow("No supported model files");
	});

	test("keeps the CivitAI model name when multiple supported files remain", async () => {
		const request = vi.fn(async () =>
			Response.json({
				id: 1102,
				name: "Synthwave",
				modelVersions: [
					{
						id: 1292,
						name: "V3",
						files: [
							{ id: 194, name: "v3.safetensors", sizeKB: 100 },
							{ id: 195, name: "v3-pruned.safetensors", sizeKB: 80 },
						],
					},
				],
			}),
		);

		await expect(
			resolveModelProviderInfo(
				"https://civitai.com/models/1102?modelVersionId=1292",
				() => null,
				request,
			),
		).resolves.toMatchObject({
			modelName: "Synthwave",
			files: [{ fileName: "v3.safetensors" }, { fileName: "v3-pruned.safetensors" }],
		});
	});

	test.each([
		["not-a-url", "Enter a supported"],
		["http://huggingface.co/owner/model", "must use HTTPS"],
		["https://example.com/owner/model", "must use Hugging Face or CivitAI"],
		["https://huggingface.co/datasets/owner/data", "model repository"],
		["https://huggingface.co/owner/model/tree/main", "model repository"],
		["https://huggingface.co/owner/model/blob/main", "model repository"],
		["https://huggingface.co/owner/model?token=secret", "cannot contain access tokens"],
		["https://huggingface.co/owner/%zz", "Enter a supported"],
		["https://civitai.com/images/123", "model page"],
		["https://civitai.com/models/123?modelVersionId=bad", "version is invalid"],
		["https://civitai.com/models/123?modelFileId=bad", "file is invalid"],
		["civitai:1318945", "must use HTTPS"],
		["civitai:1318945@0", "must use HTTPS"],
		["civitai:1318945@3218603+0", "must use HTTPS"],
	])("rejects unsupported source URL %s", async (sourceUrl, message) => {
		await expect(resolveModelProviderInfo(sourceUrl, () => null)).rejects.toThrow(
			message,
		);
	});

	test.each([
		[401, "requires a valid Hugging Face token"],
		[404, "model could not be found"],
		[429, "rate limit was reached"],
		[500, "could not provide model files"],
	])("maps provider HTTP %s to a safe error", async (status, message) => {
		await expect(
			resolveModelProviderInfo(
				"https://huggingface.co/owner/model",
				() => null,
				vi.fn(async () => new Response(null, { status })) as typeof fetch,
			),
		).rejects.toThrow(message);
	});

	test("rejects invalid metadata and catalogs without supported files", async () => {
		await expect(
			resolveModelProviderInfo(
				"https://huggingface.co/owner/model",
				() => null,
				vi.fn(async () => Response.json({ siblings: [] })) as typeof fetch,
			),
		).rejects.toThrow("invalid model metadata");

		await expect(
			resolveModelProviderInfo(
				"https://huggingface.co/owner/model",
				() => null,
				vi.fn(async () =>
					Response.json({
						modelId: "owner/model",
						sha: "revision",
						siblings: [{ rfilename: "README.md", size: 1 }],
					}),
				) as typeof fetch,
			),
		).rejects.toThrow("No supported model files");
	});

	test("rejects artifact metadata that differs from the current provider response", async () => {
		const request = vi.fn(async () =>
			Response.json({
				modelId: "owner/model",
				sha: "revision",
				siblings: [{ rfilename: "model.safetensors", size: 1024 }],
			}),
		);

		await expect(
			verifyModelProviderArtifact(
				"https://huggingface.co/owner/model",
				{
					provider: "huggingface",
					modelId: "owner/model",
					versionId: "revision",
					versionLabel: "revision",
					fileId: "model.safetensors",
					fileName: "model.safetensors",
					sizeBytes: 1,
				},
				() => null,
				request as typeof fetch,
			),
		).rejects.toThrow("does not match current provider metadata");
	});
});
