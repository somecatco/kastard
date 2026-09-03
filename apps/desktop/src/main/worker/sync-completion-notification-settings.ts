import {
	isSyncCompletionNotificationSettings,
	type SyncCompletionNotificationSettings,
} from "../../shared/api";
import { readJsonFile, writeJsonFile } from "../json-file";

type StoredSettings = SyncCompletionNotificationSettings & {
	version: 1;
};

export class SyncCompletionNotificationSettingsStore {
	private settings: SyncCompletionNotificationSettings = { enabled: true };

	constructor(private readonly path: string) {}

	async initialize(): Promise<void> {
		const result = await readJsonFile(this.path);
		if (result.status === "missing") return;
		if (result.status === "invalid") throw invalidSettingsError();
		const stored = result.value;
		if (!isStoredSettings(stored)) throw invalidSettingsError();
		this.settings = { enabled: stored.enabled };
	}

	get(): SyncCompletionNotificationSettings {
		return { ...this.settings };
	}

	async update(settings: SyncCompletionNotificationSettings): Promise<void> {
		if (!isSyncCompletionNotificationSettings(settings)) {
			throw new Error("Invalid sync completion notification settings.");
		}
		const stored: StoredSettings = { version: 1, ...settings };
		await writeJsonFile(this.path, stored);
		this.settings = { ...settings };
	}
}

function isStoredSettings(value: unknown): value is StoredSettings {
	return (
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		value.version === 1 &&
		isSyncCompletionNotificationSettings(value)
	);
}

function invalidSettingsError(): Error {
	return new Error("The saved sync completion notification settings are invalid.");
}
