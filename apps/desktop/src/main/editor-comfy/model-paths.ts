import type { Dirent } from "node:fs";
import {
	access,
	cp,
	link,
	mkdir,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelLibraryEntry } from "../../shared/api";
import { MODEL_PATH_CATEGORIES } from "../../shared/model-path";

const RESERVED_MODEL_PATH_KEYS = new Set(["base_path", "is_default"]);
export class EditorModelPaths {
	private modelSync: Promise<void> = Promise.resolve();
	constructor(private readonly dataDirectory: string) {}
	settled(): Promise<void> {
		return this.modelSync;
	}
	syncModels(models: readonly ModelLibraryEntry[]): Promise<void> {
		const paths = models.map((model) => model.path);
		return this.withStablePaths(() => this.replaceVirtualModels(paths));
	}

	withStablePaths<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.modelSync.then(operation);
		this.modelSync = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	private async replaceVirtualModels(paths: readonly string[]): Promise<void> {
		const directory = join(this.dataDirectory, "virtual-models");
		const localDirectory = join(this.dataDirectory, "data", "models");
		const staging = `${directory}.next`;
		const previous = `${directory}.previous`;
		if (!(await pathExists(directory)) && (await pathExists(previous))) {
			await rename(previous, directory);
		}
		const categories = new Set<string>(MODEL_PATH_CATEGORIES);
		for (const modelDirectory of [directory, localDirectory]) {
			try {
				const entries = await readdir(modelDirectory, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory() && !RESERVED_MODEL_PATH_KEYS.has(entry.name)) {
						categories.add(entry.name);
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		await rm(staging, { recursive: true, force: true });
		await mkdir(staging, { recursive: true });
		await Promise.all(
			[...categories].map((category) =>
				mkdir(join(staging, category), { recursive: true }),
			),
		);
		for (const path of paths) {
			const segments = virtualModelSegments(path);
			categories.add(segments[0]);
			const target = join(staging, ...segments);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, "");
		}
		await preserveUserModelFiles(previous, staging);
		await preserveUserModelFiles(directory, staging);
		await rm(previous, { recursive: true, force: true });
		let movedCurrent = false;
		try {
			await rename(directory, previous);
			movedCurrent = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(staging, directory);
		} catch (error) {
			if (movedCurrent) {
				try {
					await rename(previous, directory);
				} catch (restoreError) {
					throw new AggregateError(
						[error, restoreError],
						"Virtual model directory replacement and recovery failed.",
					);
				}
			}
			throw error;
		}
		const virtualModelPaths: Record<string, string> = Object.create(null);
		virtualModelPaths.base_path = directory;
		for (const category of categories) virtualModelPaths[category] = category;
		const localModelPaths: Record<string, string | boolean> = Object.create(null);
		localModelPaths.base_path = localDirectory;
		localModelPaths.is_default = true;
		for (const category of categories) localModelPaths[category] = category;
		Object.assign(localModelPaths, {
			configs: "configs",
			controlnet: "controlnet\nt2i_adapter",
			diffusion_models: "unet\ndiffusion_models",
			text_encoders: "text_encoders\nclip",
		});
		await writeFile(
			join(this.dataDirectory, "editor-model-paths.json"),
			`${JSON.stringify(
				{ kastard_virtual: virtualModelPaths, kastard_local: localModelPaths },
				null,
				2,
			)}\n`,
			"utf8",
		);
		await rm(previous, { recursive: true, force: true });
	}
}

async function preserveUserModelFiles(
	source: string,
	destination: string,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(source, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await mkdir(destination, { recursive: true });
	for (const entry of entries) {
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isDirectory()) {
			await preserveUserModelFiles(sourcePath, destinationPath);
			continue;
		}
		if (entry.isSymbolicLink()) {
			await rm(destinationPath, { recursive: true, force: true });
			await cp(sourcePath, destinationPath, { verbatimSymlinks: true });
			continue;
		}
		if (entry.isFile() && (await stat(sourcePath)).size > 0) {
			await rm(destinationPath, { recursive: true, force: true });
			await link(sourcePath, destinationPath);
		}
	}
}

function virtualModelSegments(path: string): [string, ...string[]] {
	const segments = path.split("/");
	if (
		path.includes("\\") ||
		segments.length < 2 ||
		segments.some(
			(segment) =>
				segment.length === 0 ||
				segment === "." ||
				segment === ".." ||
				segment.includes(":"),
		) ||
		RESERVED_MODEL_PATH_KEYS.has(segments[0] ?? "")
	) {
		throw new Error(`Invalid virtual model path: ${path}`);
	}
	return segments as [string, ...string[]];
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
