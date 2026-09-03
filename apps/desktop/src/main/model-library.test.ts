// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { ModelLibrary } from "./model-library";

const temporaryDirectories: string[] = [];
const huggingFaceArtifact = {
	provider: "huggingface" as const,
	modelId: "black-forest-labs/FLUX.1-dev",
	versionId: "3de623fc3c33e44ffbe2bad470d0f45bccf2eb21",
	versionLabel: "3de623f",
	fileId: "flux1-dev.safetensors",
	fileName: "flux1-dev.safetensors",
	sizeBytes: 23_802_932_552,
};
const civitaiArtifact = {
	provider: "civitai" as const,
	modelId: "123",
	versionId: "456",
	versionLabel: "V1",
	fileId: "789",
	fileName: "example.safetensors",
	sizeBytes: 2_132_675_584,
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function libraryFixture(): Promise<{ library: ModelLibrary; path: string }> {
	const directory = await mkdtemp(join(tmpdir(), "kastard-model-library-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "kastard.sqlite");
	const library = new ModelLibrary(path);
	await library.initialize();
	return { library, path };
}

test("persists added and updated models in the models table", async () => {
	const { library, path } = await libraryFixture();
	const added = await library.add({
		name: "FLUX.1 Dev",
		sourceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
		path: "models/diffusion_models/flux1-dev.safetensors",
		sync: true,
		artifact: huggingFaceArtifact,
	});

	expect(added.path).toBe("diffusion_models/flux1-dev.safetensors");
	await library.update(added.id, { ...added, name: "FLUX Dev", sync: false });

	library.close();
	const restored = new ModelLibrary(path);
	await restored.initialize();
	expect(restored.list()).toEqual([
		{
			...added,
			name: "FLUX Dev",
			path: "diffusion_models/flux1-dev.safetensors",
			sync: false,
		},
	]);
	restored.close();
	const database = new DatabaseSync(path);
	expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
	expect(
		database
			.prepare(
				`SELECT name, source_url, path, sync, artifact_json
				 FROM models WHERE id = ?`,
			)
			.get(added.id),
	).toEqual({
		name: "FLUX Dev",
		source_url: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
		path: "diffusion_models/flux1-dev.safetensors",
		sync: 0,
		artifact_json: JSON.stringify(huggingFaceArtifact),
	});
	database.close();
});

test.each([
	[
		"civitai:123@456",
		"https://civitai.com/models/123?modelVersionId=456",
		civitaiArtifact,
	],
	[
		"urn:air:sdxl:checkpoint:civitai:123@456",
		"https://civitai.com/models/123?modelVersionId=456",
		civitaiArtifact,
	],
	[
		"urn:air:anima:lora:civitai:599757@3226360+3108500",
		"https://civitai.com/models/599757?modelVersionId=3226360&modelFileId=3108500",
		{
			...civitaiArtifact,
			modelId: "599757",
			versionId: "3226360",
			fileId: "3108500",
		},
	],
])(
	"normalizes CivitAI AIR %s before persistence",
	async (sourceUrl, expectedSourceUrl, artifact) => {
		const { library } = await libraryFixture();
		const model = await library.add({
			name: "Example",
			sourceUrl,
			path: "checkpoints/example.safetensors",
			sync: false,
			artifact,
		});

		expect(model.sourceUrl).toBe(expectedSourceUrl);
		expect(library.list()).toEqual([model]);
	},
);

test("rejects a CivitAI artifact that does not match the selected AIR file", async () => {
	const { library } = await libraryFixture();
	await expect(
		library.add({
			name: "Wrong file",
			sourceUrl: "urn:air:anima:lora:civitai:599757@3226360+3108500",
			path: "checkpoints/wrong.safetensors",
			sync: false,
			artifact: {
				...civitaiArtifact,
				modelId: "599757",
				versionId: "3226360",
				fileId: "3108501",
			},
		}),
	).rejects.toThrow("does not match its source URL");
});

test("removes persisted models and rejects missing ids", async () => {
	const { library, path } = await libraryFixture();
	const model = await library.add({
		name: "FLUX.1 Dev",
		sourceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
		path: "diffusion_models/flux1-dev.safetensors",
		sync: true,
		artifact: huggingFaceArtifact,
	});

	await expect(library.remove(model.id)).resolves.toEqual(model);
	expect(library.list()).toEqual([]);
	await expect(library.remove(model.id)).rejects.toThrow("Model not found");

	library.close();
	const restored = new ModelLibrary(path);
	await restored.initialize();
	expect(restored.list()).toEqual([]);
	restored.close();
});

test("rolls back model mutations when publishing the catalog fails", async () => {
	const { library } = await libraryFixture();
	const input = {
		name: "FLUX.1 Dev",
		sourceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
		path: "diffusion_models/flux1-dev.safetensors",
		sync: true,
		artifact: huggingFaceArtifact,
	};
	const publishedCatalogs: string[][] = [];
	const publishFailure = async (models: readonly { name: string }[]): Promise<void> => {
		publishedCatalogs.push(models.map(({ name }) => name));
		if (publishedCatalogs.length % 2 === 1) {
			throw new Error("Virtual model projection failed.");
		}
	};

	await expect(library.add(input, publishFailure)).rejects.toThrow(
		"Virtual model projection failed.",
	);
	expect(library.list()).toEqual([]);
	expect(publishedCatalogs).toEqual([["FLUX.1 Dev"], []]);

	const model = await library.add(input);
	await expect(
		library.update(
			model.id,
			{ ...model, name: "FLUX Dev", path: "diffusion_models/flux-dev.safetensors" },
			publishFailure,
		),
	).rejects.toThrow("Virtual model projection failed.");
	expect(library.list()).toEqual([model]);
	expect(publishedCatalogs.slice(2)).toEqual([["FLUX Dev"], ["FLUX.1 Dev"]]);

	await expect(library.remove(model.id, publishFailure)).rejects.toThrow(
		"Virtual model projection failed.",
	);
	expect(library.list()).toEqual([model]);
	expect(publishedCatalogs.slice(4)).toEqual([[], ["FLUX.1 Dev"]]);
});

test("accepts Civitai URLs and rejects duplicate logical paths", async () => {
	const { library } = await libraryFixture();
	const first = await library.add({
		name: "Example",
		sourceUrl: "https://civitai.com/models/123/example",
		path: "checkpoints/example.safetensors",
		sync: false,
		artifact: civitaiArtifact,
	});

	await expect(
		library.add({
			name: "Duplicate",
			sourceUrl: "https://civit.ai/models/456/duplicate",
			path: "checkpoints/example.safetensors",
			sync: true,
			artifact: { ...civitaiArtifact, modelId: "456" },
		}),
	).rejects.toThrow("already exists");

	const second = await library.add({
		name: "Second",
		sourceUrl: "https://huggingface.co/example/second",
		path: "checkpoints/second.safetensors",
		sync: false,
		artifact: { ...huggingFaceArtifact, modelId: "example/second" },
	});
	await expect(
		library.update(second.id, {
			...second,
			path: first.path,
		}),
	).rejects.toThrow("already exists");
	await expect(
		library.update("missing-model", {
			...second,
			path: "checkpoints/missing.safetensors",
		}),
	).rejects.toThrow("Model not found");
});

test.each([
	{ ...huggingFaceArtifact, fileName: "README.md", fileId: "README.md" },
	{ ...huggingFaceArtifact, fileId: "another.safetensors" },
	{ ...civitaiArtifact, fileId: "not-a-file-id" },
])("rejects invalid provider artifact metadata", async (artifact) => {
	const { library } = await libraryFixture();
	await expect(
		library.add({
			name: "Invalid artifact",
			sourceUrl:
				artifact.provider === "huggingface"
					? "https://huggingface.co/black-forest-labs/FLUX.1-dev"
					: "https://civitai.com/models/123/example",
			path: "checkpoints/example.safetensors",
			sync: true,
			artifact,
		}),
	).rejects.toThrow("selected model file is invalid");
});

test.each([
	["http://huggingface.co/repo/model", "checkpoints/model.safetensors"],
	["https://example.com/model", "checkpoints/model.safetensors"],
	["https://huggingface.co/repo/model?token=secret", "checkpoints/model.safetensors"],
	["https://huggingface.co/repo/%zz", "checkpoints/model.safetensors"],
	["civitai:123", "checkpoints/model.safetensors"],
	["civitai:123@0", "checkpoints/model.safetensors"],
	["civitai:123@456+0", "checkpoints/model.safetensors"],
	["urn:air:sdxl:checkpoint:huggingface:123@456", "checkpoints/model.safetensors"],
	["https://huggingface.co/repo/model", "../model.safetensors"],
	["https://huggingface.co/repo/model", "checkpoints/foo:bar.safetensors"],
	["https://huggingface.co/repo/model", "checkpoints/model.txt"],
])("rejects unsafe source URL or model path", async (sourceUrl, path) => {
	const { library } = await libraryFixture();
	await expect(
		library.add({
			name: "Unsafe",
			sourceUrl,
			path,
			sync: false,
			artifact: huggingFaceArtifact,
		}),
	).rejects.toThrow();
});

test("normalizes a case-insensitive models path prefix", async () => {
	const { library } = await libraryFixture();
	const model = await library.add({
		name: "Example",
		sourceUrl: "https://huggingface.co/example/model",
		path: "Models/checkpoints/example.safetensors",
		sync: true,
		artifact: { ...huggingFaceArtifact, modelId: "example/model" },
	});

	expect(model.path).toBe("checkpoints/example.safetensors");
});

test("accepts a single-segment Hugging Face model URL", async () => {
	const { library } = await libraryFixture();
	const model = await library.add({
		name: "GPT-2",
		sourceUrl: "https://huggingface.co/gpt2",
		path: "checkpoints/gpt2.safetensors",
		sync: true,
		artifact: { ...huggingFaceArtifact, modelId: "gpt2" },
	});

	expect(model.artifact?.modelId).toBe("gpt2");
});

test("accepts a Hugging Face blob URL only for its selected file", async () => {
	const { library } = await libraryFixture();
	const artifact = {
		...huggingFaceArtifact,
		modelId: "Comfy-Org/stable-diffusion-v1-5-archive",
		versionId: "6ad2af6cc1378562b96bf2827523d20d858beef2",
		versionLabel: "6ad2af6",
		fileId: "v1-5-pruned-emaonly-fp16.safetensors",
		fileName: "v1-5-pruned-emaonly-fp16.safetensors",
		sizeBytes: 2_132_696_762,
	};
	const sourceUrl =
		"https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/blob/main/v1-5-pruned-emaonly-fp16.safetensors";

	await expect(
		library.add({
			name: "Stable Diffusion 1.5",
			sourceUrl,
			path: "checkpoints/v1-5-pruned-emaonly-fp16.safetensors",
			sync: true,
			artifact,
		}),
	).resolves.toMatchObject({ sourceUrl, artifact });
	await expect(
		library.add({
			name: "Wrong file",
			sourceUrl,
			path: "checkpoints/wrong.safetensors",
			sync: false,
			artifact: {
				...artifact,
				fileId: "wrong.safetensors",
				fileName: "wrong.safetensors",
			},
		}),
	).rejects.toThrow("does not match its source URL");
});

test.each(["blob", "resolve"])(
	"accepts a single-segment Hugging Face %s URL for its selected file",
	async (marker) => {
		const { library } = await libraryFixture();
		const artifact = {
			...huggingFaceArtifact,
			modelId: "gpt2",
			fileId: "model.safetensors",
			fileName: "model.safetensors",
		};
		const sourceUrl = `https://huggingface.co/gpt2/${marker}/main/model.safetensors`;

		await expect(
			library.add({
				name: "GPT-2",
				sourceUrl,
				path: "checkpoints/gpt2.safetensors",
				sync: true,
				artifact,
			}),
		).resolves.toMatchObject({ sourceUrl, artifact });
	},
);

test.each([0, 1])(
	"rejects version %s model data without changing its schema",
	async (version) => {
		const directory = await mkdtemp(join(tmpdir(), "kastard-model-library-old-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "kastard.sqlite");
		const database = new DatabaseSync(path);
		database.exec(`
			CREATE TABLE models (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				source_url TEXT NOT NULL,
				path TEXT NOT NULL UNIQUE,
				sync INTEGER NOT NULL CHECK (sync IN (0, 1)),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT;
			PRAGMA user_version = ${version};
		`);
		database.close();

		await expect(new ModelLibrary(path).initialize()).rejects.toThrow(
			"unsupported schema version",
		);

		const unchanged = new DatabaseSync(path);
		expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({
			user_version: version,
		});
		expect(unchanged.prepare("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "delete",
		});
		expect(
			unchanged
				.prepare("PRAGMA table_info(models)")
				.all()
				.map(({ name }) => name),
		).toEqual(["id", "name", "source_url", "path", "sync", "created_at", "updated_at"]);
		unchanged.close();
	},
);

test("rejects a version 2 database without the current model columns", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kastard-model-library-invalid-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "kastard.sqlite");
	const database = new DatabaseSync(path);
	database.exec(`
		CREATE TABLE models (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			source_url TEXT NOT NULL,
			path TEXT NOT NULL UNIQUE,
			sync INTEGER NOT NULL CHECK (sync IN (0, 1)),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		) STRICT;
		PRAGMA user_version = 2;
	`);
	database.close();

	await expect(new ModelLibrary(path).initialize()).rejects.toThrow(
		"unsupported schema layout",
	);
});

test("rejects a database from a newer schema version", async () => {
	const { library, path } = await libraryFixture();
	library.close();
	const database = new DatabaseSync(path);
	database.exec("PRAGMA user_version = 3");
	database.close();

	await expect(new ModelLibrary(path).initialize()).rejects.toThrow(
		"unsupported schema version",
	);
});
