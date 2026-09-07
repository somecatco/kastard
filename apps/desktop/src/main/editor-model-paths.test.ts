import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";

import { fixture, virtualModel } from "./comfy-test-fixture";

test("replaces virtual model placeholders and rejects unsafe paths", async () => {
	const paths = await fixture();
	const modelPaths = paths.modelPaths;
	await mkdir(join(paths.dataDirectory, "data", "models", "ipadapter"), {
		recursive: true,
	});
	const updatedModel = {
		...virtualModel,
		path: "diffusion_models/flux-dev.safetensors",
	};
	const customModel = {
		...virtualModel,
		path: "custom_models/example.safetensors",
	};

	await modelPaths.syncModels([]);
	expect(
		JSON.parse(
			await readFile(join(paths.dataDirectory, "editor-model-paths.json"), "utf8"),
		).kastard_local.diffusion_models,
	).toBe("unet\ndiffusion_models");
	await Promise.all([
		mkdir(join(paths.dataDirectory, "virtual-models", "base_path")),
		mkdir(join(paths.dataDirectory, "virtual-models", "is_default")),
	]);
	await modelPaths.syncModels([]);
	const reservedPathsConfig = JSON.parse(
		await readFile(join(paths.dataDirectory, "editor-model-paths.json"), "utf8"),
	);
	expect(reservedPathsConfig.kastard_virtual.base_path).toBe(
		join(paths.dataDirectory, "virtual-models"),
	);
	expect(reservedPathsConfig.kastard_virtual.is_default).toBeUndefined();
	expect(reservedPathsConfig.kastard_local.base_path).toBe(
		join(paths.dataDirectory, "data", "models"),
	);
	expect(reservedPathsConfig.kastard_local.is_default).toBe(true);
	expect(reservedPathsConfig.kastard_local.ipadapter).toBe("ipadapter");
	await modelPaths.syncModels([virtualModel]);
	await modelPaths.syncModels([updatedModel]);

	await expect(
		access(
			join(
				paths.dataDirectory,
				"virtual-models",
				"diffusion_models",
				"flux1-dev.safetensors",
			),
		),
	).rejects.toThrow();
	await expect(
		access(
			join(
				paths.dataDirectory,
				"virtual-models",
				"diffusion_models",
				"flux-dev.safetensors",
			),
		),
	).resolves.toBeUndefined();
	await modelPaths.syncModels([]);
	await expect(
		access(
			join(
				paths.dataDirectory,
				"virtual-models",
				"diffusion_models",
				"flux-dev.safetensors",
			),
		),
	).rejects.toThrow();
	await expect(
		access(join(paths.dataDirectory, "virtual-models", "diffusion_models")),
	).resolves.toBeUndefined();
	await modelPaths.syncModels([customModel]);
	await modelPaths.syncModels([]);
	await expect(
		access(join(paths.dataDirectory, "virtual-models", "custom_models")),
	).resolves.toBeUndefined();
	expect(
		JSON.parse(
			await readFile(join(paths.dataDirectory, "editor-model-paths.json"), "utf8"),
		).kastard_virtual.custom_models,
	).toBe("custom_models");
	await expect(
		modelPaths.syncModels([{ ...virtualModel, path: "../escape/model.safetensors" }]),
	).rejects.toThrow("Invalid virtual model path");
	await expect(
		modelPaths.syncModels([{ ...virtualModel, path: "base_path/model.safetensors" }]),
	).rejects.toThrow("Invalid virtual model path");
	await expect(
		modelPaths.syncModels([{ ...virtualModel, path: "is_default/model.safetensors" }]),
	).rejects.toThrow("Invalid virtual model path");
});

test("projects LLM GGUF files into the primary model directory", async () => {
	const paths = await fixture();
	const modelPaths = paths.modelPaths;

	await modelPaths.syncModels([
		{ ...virtualModel, id: "qwen", path: "LLM/Qwen3-4B-Q4_K_M.gguf" },
		{ ...virtualModel, id: "mmproj", path: "LLM/mmproj-model-f16.gguf" },
	]);

	await expect(
		access(join(paths.dataDirectory, "virtual-models", "LLM", "Qwen3-4B-Q4_K_M.gguf")),
	).resolves.toBeUndefined();
	await expect(
		access(join(paths.dataDirectory, "virtual-models", "LLM", "mmproj-model-f16.gguf")),
	).resolves.toBeUndefined();
});

test("preserves user model files while replacing generated placeholders", async () => {
	const paths = await fixture();
	const modelPaths = paths.modelPaths;
	const directory = join(paths.dataDirectory, "virtual-models", "diffusion_models");
	const userModel = join(directory, "local.safetensors");

	await modelPaths.syncModels([virtualModel]);
	await writeFile(userModel, "local model data");
	await modelPaths.syncModels([]);

	await expect(readFile(userModel, "utf8")).resolves.toBe("local model data");
	await expect(access(join(directory, "flux1-dev.safetensors"))).rejects.toThrow();
});

test("recovers user model files when an interrupted swap directory is recreated", async () => {
	const paths = await fixture();
	const modelPaths = paths.modelPaths;
	const directory = join(paths.dataDirectory, "virtual-models");
	const previous = `${directory}.previous`;
	const userModel = join(previous, "diffusion_models", "local.safetensors");

	await mkdir(dirname(userModel), { recursive: true });
	await writeFile(userModel, "local model data");
	await mkdir(directory, { recursive: true });
	await modelPaths.syncModels([]);

	await expect(
		readFile(join(directory, "diffusion_models", "local.safetensors"), "utf8"),
	).resolves.toBe("local model data");
	await expect(access(previous)).rejects.toThrow();
});

test("waits for a path replacement before allowing a process to use the paths", async () => {
	const { modelPaths, dataDirectory } = await fixture();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const occupied = modelPaths.withStablePaths(() => gate);
	const replacing = modelPaths.syncModels([virtualModel]);
	const launch = vi.fn(async () =>
		readFile(join(dataDirectory, "editor-model-paths.json"), "utf8"),
	);
	const starting = modelPaths.withStablePaths(launch);
	expect(launch).not.toHaveBeenCalled();
	release();
	await Promise.all([occupied, replacing]);
	expect(JSON.parse(await starting).kastard_virtual.diffusion_models).toBe(
		"diffusion_models",
	);
	await expect(
		access(join(dataDirectory, "virtual-models", virtualModel.path)),
	).resolves.toBeUndefined();
});
