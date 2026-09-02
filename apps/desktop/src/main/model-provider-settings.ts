import type { ModelProvider, ModelProviderSettings } from "../shared/api";
import { readJsonFile, writeJsonFile } from "./json-file";

export interface EncryptionProvider {
	isAsyncEncryptionAvailable: () => Promise<boolean>;
	getSelectedStorageBackend: () => string;
	encryptStringAsync: (plaintext: string) => Promise<Buffer>;
	decryptStringAsync: (
		encrypted: Buffer,
	) => Promise<{ result: string; shouldReEncrypt: boolean }>;
}

type ModelProviderTokens = Record<ModelProvider, string | null>;

type StoredModelProviderTokens = {
	version: 1;
	encryptedCredential: string;
};

const EMPTY_TOKENS: ModelProviderTokens = {
	huggingface: null,
	civitai: null,
};

export class ModelProviderTokenStore {
	private tokens: ModelProviderTokens = { ...EMPTY_TOKENS };
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly path: string,
		private readonly encryption: EncryptionProvider,
		private readonly platform: NodeJS.Platform = process.platform,
	) {}

	async initialize(): Promise<void> {
		this.tokens = (await this.load()) ?? { ...EMPTY_TOKENS };
	}

	getSettings(): ModelProviderSettings {
		return {
			huggingface: this.tokens.huggingface !== null,
			civitai: this.tokens.civitai !== null,
		};
	}

	getToken(provider: ModelProvider): string | null {
		return this.tokens[provider];
	}

	async updateToken(provider: ModelProvider, token: string | null): Promise<void> {
		const nextToken = normalizeToken(token);
		const update = this.writeQueue.then(async () => {
			const next = { ...this.tokens, [provider]: nextToken };
			await this.save(next);
			this.tokens = next;
		});
		this.writeQueue = update.catch(() => undefined);
		await update;
	}

	private async load(): Promise<ModelProviderTokens | null> {
		const result = await readJsonFile(this.path);
		if (result.status === "missing") return null;
		if (result.status === "invalid") throw result.error;
		const stored = result.value;
		if (!isStoredModelProviderTokens(stored)) throw invalidSettingsError();
		await this.ensureEncryption();
		const decrypted = await this.encryption.decryptStringAsync(
			Buffer.from(stored.encryptedCredential, "base64"),
		);
		const tokens = parseTokens(decrypted.result);
		if (decrypted.shouldReEncrypt) await this.save(tokens);
		return tokens;
	}

	private async save(tokens: ModelProviderTokens): Promise<void> {
		await this.ensureEncryption();
		const stored: StoredModelProviderTokens = {
			version: 1,
			encryptedCredential: (
				await this.encryption.encryptStringAsync(JSON.stringify(tokens))
			).toString("base64"),
		};
		await writeJsonFile(this.path, stored);
	}

	private async ensureEncryption(): Promise<void> {
		if (!(await this.encryption.isAsyncEncryptionAvailable())) {
			throw new Error("Secure credential storage is unavailable on this computer.");
		}
		if (
			this.platform === "linux" &&
			this.encryption.getSelectedStorageBackend() === "basic_text"
		) {
			throw new Error("Secure credential storage is unavailable on this Linux system.");
		}
		const encrypted = await this.encryption.encryptStringAsync(
			"kastard-model-provider-check",
		);
		const decrypted = await this.encryption.decryptStringAsync(encrypted);
		if (decrypted.result !== "kastard-model-provider-check") {
			throw new Error("Secure credential storage could not be verified.");
		}
	}
}

function normalizeToken(token: string | null): string | null {
	if (token === null) return null;
	const normalized = token.trim();
	if (normalized.length === 0) throw new Error("Enter a provider token.");
	if (normalized.length > 8_192) throw new Error("The provider token is too long.");
	return normalized;
}

function isStoredModelProviderTokens(
	value: unknown,
): value is StoredModelProviderTokens {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StoredModelProviderTokens>;
	return (
		candidate.version === 1 &&
		typeof candidate.encryptedCredential === "string" &&
		candidate.encryptedCredential.length > 0
	);
}

function parseTokens(value: string): ModelProviderTokens {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw invalidSettingsError();
	}
	if (typeof parsed !== "object" || parsed === null) throw invalidSettingsError();
	const candidate = parsed as Partial<ModelProviderTokens>;
	if (!isToken(candidate.huggingface) || !isToken(candidate.civitai)) {
		throw invalidSettingsError();
	}
	return { huggingface: candidate.huggingface, civitai: candidate.civitai };
}

function isToken(value: unknown): value is string | null {
	return (
		value === null ||
		(typeof value === "string" &&
			value.length > 0 &&
			value.length <= 8_192 &&
			value.trim() === value)
	);
}

function invalidSettingsError(): Error {
	return new Error("The encrypted model-provider settings are invalid.");
}
