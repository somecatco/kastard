// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
	type EncryptionProvider,
	ModelProviderTokenStore,
} from "./model-provider-settings";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fixture(
	provider = encryptionProvider(),
	platform: NodeJS.Platform = process.platform,
) {
	const directory = await mkdtemp(join(tmpdir(), "kastard-provider-settings-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "model-provider-settings.json");
	return {
		store: new ModelProviderTokenStore(path, provider, platform),
		path,
	};
}

function encryptionProvider(): EncryptionProvider {
	return {
		isAsyncEncryptionAvailable: vi.fn(async () => true),
		getSelectedStorageBackend: vi.fn(() => "unknown"),
		encryptStringAsync: vi.fn(async (plaintext) =>
			Buffer.from(`encrypted:${plaintext}`, "utf8"),
		),
		decryptStringAsync: vi.fn(async (encrypted) => ({
			result: encrypted.toString("utf8").replace(/^encrypted:/, ""),
			shouldReEncrypt: false,
		})),
	};
}

test("stores Hugging Face and CivitAI tokens encrypted and reports only status", async () => {
	const target = await fixture();
	await target.store.initialize();
	expect(target.store.getSettings()).toEqual({ huggingface: false, civitai: false });

	await Promise.all([
		target.store.updateToken("huggingface", "hf_example-token"),
		target.store.updateToken("civitai", "civitai-example-token"),
	]);

	expect(target.store.getSettings()).toEqual({ huggingface: true, civitai: true });
	expect(target.store.getToken("huggingface")).toBe("hf_example-token");
	expect(target.store.getToken("civitai")).toBe("civitai-example-token");
	const stored = await readFile(target.path, "utf8");
	expect(stored).not.toContain("hf_example-token");
	expect(stored).not.toContain("civitai-example-token");

	const restored = new ModelProviderTokenStore(target.path, encryptionProvider());
	await restored.initialize();
	expect(restored.getSettings()).toEqual({ huggingface: true, civitai: true });

	await restored.updateToken("huggingface", null);
	expect(restored.getSettings()).toEqual({ huggingface: false, civitai: true });
});

test("rejects unsafe Linux storage and blank tokens", async () => {
	const provider = encryptionProvider();
	vi.mocked(provider.getSelectedStorageBackend).mockReturnValue("basic_text");
	const target = await fixture(provider, "linux");
	await target.store.initialize();

	await expect(target.store.updateToken("huggingface", "token")).rejects.toThrow(
		"Secure credential storage is unavailable on this Linux system",
	);
	await expect(target.store.updateToken("civitai", "  ")).rejects.toThrow(
		"Enter a provider token",
	);
});
