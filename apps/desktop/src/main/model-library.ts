import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	isModelArtifact,
	type ModelArtifact,
	type ModelLibraryEntry,
	type ModelLibraryInput,
} from "../shared/api";
import {
	normalizeModelSourceUrl,
	parseHuggingFaceSourcePath,
} from "../shared/model-source";
import { hasSupportedModelExtension } from "./model-file";

const SOURCE_HOSTS = new Set(["civit.ai", "civitai.com", "huggingface.co"]);
const SECRET_QUERY_KEY = /(?:api.?key|auth|credential|secret|signature|token)/i;
const MODEL_COLUMNS = [
	"id",
	"name",
	"source_url",
	"path",
	"sync",
	"created_at",
	"updated_at",
	"artifact_json",
] as const;

export class ModelLibrary {
	private database: DatabaseSync | null = null;

	constructor(private readonly path: string) {}

	async initialize(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const database = new DatabaseSync(this.path, { timeout: 5_000 });
		try {
			database.exec("PRAGMA foreign_keys = ON;");
			const versionRow = database.prepare("PRAGMA user_version").get() as {
				user_version: number | bigint;
			};
			const version = Number(versionRow.user_version);
			let columns = modelTableColumns(database);
			if (version === 0 && columns.size === 0) {
				createSchema(database);
				columns = modelTableColumns(database);
			} else if (version !== 2) {
				throw new Error("The Kastard database uses an unsupported schema version.");
			}
			if (!MODEL_COLUMNS.every((column) => columns.has(column))) {
				throw new Error("The Kastard database uses an unsupported schema layout.");
			}
			database.exec("PRAGMA journal_mode = WAL;");
			this.database = database;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	list(): ModelLibraryEntry[] {
		return this.getDatabase()
			.prepare(
				`SELECT id, name, source_url, path, sync, artifact_json
					 FROM models
				 ORDER BY created_at, id`,
			)
			.all()
			.map(modelFromRow);
	}

	async add(
		input: ModelLibraryInput,
		publish?: (models: readonly ModelLibraryEntry[]) => Promise<void>,
	): Promise<ModelLibraryEntry> {
		const model = { id: randomUUID(), ...normalizeInput(input, false) };
		const database = this.getDatabase();
		ensurePathAvailable(database, model.path);
		const timestamp = new Date().toISOString();
		database
			.prepare(
				`INSERT INTO models (
						id, name, source_url, path, sync, artifact_json, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				model.id,
				model.name,
				model.sourceUrl,
				model.path,
				model.sync ? 1 : 0,
				serializeArtifact(model.artifact),
				timestamp,
				timestamp,
			);
		try {
			await publish?.(this.list());
		} catch (error) {
			database.prepare("DELETE FROM models WHERE id = ?").run(model.id);
			await restorePublishedModels(publish, this.list());
			throw error;
		}
		return { ...model };
	}

	async update(
		id: string,
		input: ModelLibraryInput,
		publish?: (models: readonly ModelLibraryEntry[]) => Promise<void>,
	): Promise<ModelLibraryEntry> {
		const database = this.getDatabase();
		const previousRow = database
			.prepare(
				`SELECT id, name, source_url, path, sync, artifact_json
					 FROM models WHERE id = ?`,
			)
			.get(id);
		if (!previousRow) throw new Error("Model not found.");
		const previous = modelFromRow(previousRow);
		const normalized = normalizeInput(input, true);
		if (
			normalized.artifact === null &&
			(previous.artifact !== null || normalized.sourceUrl !== previous.sourceUrl)
		) {
			throw new Error("Select a provider model file.");
		}
		const model = { id, ...normalized };
		ensurePathAvailable(database, model.path, id);
		updateModel(database, model);
		try {
			await publish?.(this.list());
		} catch (error) {
			updateModel(database, previous);
			await restorePublishedModels(publish, this.list());
			throw error;
		}
		return { ...model };
	}

	async remove(
		id: string,
		publish?: (models: readonly ModelLibraryEntry[]) => Promise<void>,
	): Promise<ModelLibraryEntry> {
		const database = this.getDatabase();
		const previousRow = database
			.prepare(
				`DELETE FROM models
				 WHERE id = ?
					 RETURNING id, name, source_url, path, sync, artifact_json,
					           created_at, updated_at`,
			)
			.get(id);
		if (!previousRow) throw new Error("Model not found.");
		const model = modelFromRow(previousRow);
		try {
			await publish?.(this.list());
		} catch (error) {
			restoreDeletedModel(database, previousRow);
			await restorePublishedModels(publish, this.list());
			throw error;
		}
		return { ...model };
	}

	close(): void {
		this.database?.close();
		this.database = null;
	}

	private getDatabase(): DatabaseSync {
		if (this.database === null) throw new Error("The model library is unavailable.");
		return this.database;
	}
}

function createSchema(database: DatabaseSync): void {
	database.exec(`
		BEGIN IMMEDIATE;
		CREATE TABLE IF NOT EXISTS models (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			source_url TEXT NOT NULL,
			path TEXT NOT NULL UNIQUE,
			sync INTEGER NOT NULL CHECK (sync IN (0, 1)),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			artifact_json TEXT
		) STRICT;
		PRAGMA user_version = 2;
		COMMIT;
	`);
}

function modelTableColumns(database: DatabaseSync): Set<string> {
	const columns = new Set<string>();
	for (const value of database.prepare("PRAGMA table_info(models)").all()) {
		if (typeof value !== "object" || value === null) continue;
		const name = (value as { name?: unknown }).name;
		if (typeof name === "string") columns.add(name);
	}
	return columns;
}

async function restorePublishedModels(
	publish: ((models: readonly ModelLibraryEntry[]) => Promise<void>) | undefined,
	models: readonly ModelLibraryEntry[],
): Promise<void> {
	if (!publish) return;
	try {
		await publish(models);
	} catch {}
}

function updateModel(database: DatabaseSync, model: ModelLibraryEntry): void {
	database
		.prepare(
			`UPDATE models
			 SET name = ?, source_url = ?, path = ?, sync = ?, artifact_json = ?,
			     updated_at = ?
			 WHERE id = ?`,
		)
		.run(
			model.name,
			model.sourceUrl,
			model.path,
			model.sync ? 1 : 0,
			serializeArtifact(model.artifact),
			new Date().toISOString(),
			model.id,
		);
}

function restoreDeletedModel(database: DatabaseSync, value: unknown): void {
	if (typeof value !== "object" || value === null) throw invalidModelRowError();
	const row = value as {
		created_at?: unknown;
		updated_at?: unknown;
	};
	if (typeof row.created_at !== "string" || typeof row.updated_at !== "string") {
		throw invalidModelRowError();
	}
	const model = modelFromRow(value);
	database
		.prepare(
			`INSERT INTO models (
					id, name, source_url, path, sync, artifact_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			model.id,
			model.name,
			model.sourceUrl,
			model.path,
			model.sync ? 1 : 0,
			serializeArtifact(model.artifact),
			row.created_at,
			row.updated_at,
		);
}

function normalizeInput(
	input: ModelLibraryInput,
	allowUnresolved: boolean,
): ModelLibraryInput {
	const name = input.name.trim();
	if (name.length === 0 || name.length > 200) {
		throw new Error("Model name must be between 1 and 200 characters.");
	}

	const sourceUrl = normalizeSourceUrl(input.sourceUrl);
	const path = normalizeModelPath(input.path);
	const artifact = normalizeArtifact(input.artifact, sourceUrl, allowUnresolved);
	return { name, sourceUrl, path, sync: input.sync, artifact };
}

function normalizeArtifact(
	artifact: ModelArtifact | null,
	sourceUrl: string,
	allowUnresolved: boolean,
): ModelArtifact | null {
	if (artifact === null) {
		if (!allowUnresolved) throw new Error("Select a provider model file.");
		return null;
	}
	if (!isValidProviderArtifact(artifact)) {
		throw new Error("The selected model file is invalid.");
	}
	const provider = providerFromSourceUrl(sourceUrl);
	if (artifact.provider !== provider || !artifactMatchesSource(artifact, sourceUrl)) {
		throw new Error("The selected model file does not match its source URL.");
	}
	return { ...artifact };
}

function normalizeSourceUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(normalizeModelSourceUrl(value));
	} catch {
		throw new Error("Enter a supported model URL.");
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error("Model URLs must use HTTPS without embedded credentials.");
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	if (!SOURCE_HOSTS.has(host)) {
		throw new Error("Model URLs must use Hugging Face or CivitAI.");
	}
	for (const key of url.searchParams.keys()) {
		if (SECRET_QUERY_KEY.test(key)) {
			throw new Error("Model URLs cannot contain access tokens or credentials.");
		}
	}
	url.hash = "";
	return url.toString();
}

function providerFromSourceUrl(value: string): ModelArtifact["provider"] {
	const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
	return host === "huggingface.co" ? "huggingface" : "civitai";
}

function artifactMatchesSource(artifact: ModelArtifact, sourceUrl: string): boolean {
	const url = new URL(sourceUrl);
	if (artifact.provider === "huggingface") {
		const source = parseHuggingFaceSourcePath(url.pathname);
		return (
			source !== null &&
			source.modelId === artifact.modelId &&
			(source.filePath === null || source.filePath === artifact.fileId)
		);
	}
	let segments: string[];
	try {
		segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return false;
	}
	const versionId = url.searchParams.get("modelVersionId");
	const fileId = url.searchParams.get("modelFileId");
	return (
		segments[0] === "models" &&
		segments[1] === artifact.modelId &&
		(versionId === null || versionId === artifact.versionId) &&
		(fileId === null || fileId === artifact.fileId)
	);
}

function normalizeModelPath(value: string): string {
	const normalized = value
		.trim()
		.replaceAll("\\", "/")
		.replace(/^models\//i, "");
	const segments = normalized.split("/");
	if (
		segments.length < 2 ||
		segments.some(
			(segment) =>
				segment.length === 0 ||
				segment === "." ||
				segment === ".." ||
				segment.includes(":"),
		)
	) {
		throw new Error(
			"Model path must include a folder and filename, such as checkpoints/model.safetensors.",
		);
	}
	const filename = segments.at(-1) ?? "";
	if (!hasSupportedModelExtension(filename)) {
		throw new Error("Model path must end with a supported model file extension.");
	}
	return segments.join("/");
}

function ensurePathAvailable(
	database: DatabaseSync,
	path: string,
	excludeId?: string,
): void {
	const existing = excludeId
		? database
				.prepare("SELECT 1 FROM models WHERE path = ? AND id != ?")
				.get(path, excludeId)
		: database.prepare("SELECT 1 FROM models WHERE path = ?").get(path);
	if (existing) {
		throw new Error("A model with this path already exists.");
	}
}

function modelFromRow(value: unknown): ModelLibraryEntry {
	if (typeof value !== "object" || value === null) throw invalidModelRowError();
	const row = value as {
		id?: unknown;
		name?: unknown;
		source_url?: unknown;
		path?: unknown;
		sync?: unknown;
		artifact_json?: unknown;
	};
	if (
		typeof row.id !== "string" ||
		typeof row.name !== "string" ||
		typeof row.source_url !== "string" ||
		typeof row.path !== "string" ||
		(typeof row.sync !== "number" && typeof row.sync !== "bigint")
	) {
		throw invalidModelRowError();
	}
	return {
		id: row.id,
		name: row.name,
		sourceUrl: row.source_url,
		path: row.path,
		sync: Number(row.sync) === 1,
		artifact: artifactFromRow(row),
	};
}

function artifactFromRow(row: { artifact_json?: unknown }): ModelArtifact | null {
	if (row.artifact_json === null) return null;
	if (typeof row.artifact_json !== "string") throw invalidModelRowError();
	let artifact: unknown;
	try {
		artifact = JSON.parse(row.artifact_json);
	} catch {
		throw invalidModelRowError();
	}
	if (!isValidProviderArtifact(artifact)) throw invalidModelRowError();
	return artifact;
}

function serializeArtifact(artifact: ModelArtifact | null): string | null {
	return artifact === null ? null : JSON.stringify(artifact);
}

function isValidProviderArtifact(value: unknown): value is ModelArtifact {
	if (!isModelArtifact(value) || !hasSupportedModelExtension(value.fileName))
		return false;
	return value.provider === "huggingface"
		? value.fileId === value.fileName
		: /^[1-9]\d*$/.test(value.fileId);
}

function invalidModelRowError(): Error {
	return new Error("The saved Kastard model data is invalid.");
}
