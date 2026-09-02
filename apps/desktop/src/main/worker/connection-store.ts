import { isWorkerProvider, type WorkerProvider } from "../../shared/api";
import { readJsonFile, writeJsonFile } from "../json-file";
import { normalizeWorkerAddress } from "./tunnel";

export type ConnectionPreferences = {
	recentProvider: WorkerProvider | null;
	recentServerUrl: string | null;
	syncAfterConnect: boolean;
	systemMetricsEnabled: boolean;
};

type StoredPreferences = ConnectionPreferences & {
	version: 3;
};

export class ConnectionPreferencesStore {
	constructor(private readonly path: string) {}

	async load(): Promise<ConnectionPreferences | null> {
		const result = await readJsonFile(this.path);
		if (result.status !== "value") return null;
		const value = result.value;
		if (isStoredPreferences(value)) {
			const preferences = toPreferences(value);
			try {
				validatePreferences(preferences);
			} catch {
				return null;
			}
			return preferences;
		}
		return null;
	}

	async save(preferences: ConnectionPreferences): Promise<void> {
		validatePreferences(preferences);
		const stored: StoredPreferences = { version: 3, ...preferences };
		await writeJsonFile(this.path, stored);
	}
}

function isStoredPreferences(value: unknown): value is StoredPreferences {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StoredPreferences>;
	return (
		candidate.version === 3 &&
		(candidate.recentProvider === null || isWorkerProvider(candidate.recentProvider)) &&
		(candidate.recentServerUrl === null ||
			typeof candidate.recentServerUrl === "string") &&
		typeof candidate.syncAfterConnect === "boolean" &&
		typeof candidate.systemMetricsEnabled === "boolean"
	);
}

function toPreferences(value: StoredPreferences): ConnectionPreferences {
	return {
		recentProvider: value.recentProvider,
		recentServerUrl: value.recentServerUrl,
		syncAfterConnect: value.syncAfterConnect,
		systemMetricsEnabled: value.systemMetricsEnabled,
	};
}

function validatePreferences(preferences: ConnectionPreferences): void {
	if (
		(preferences.recentProvider === null) !==
		(preferences.recentServerUrl === null)
	) {
		throw new Error("invalid recent connection");
	}
	if (
		preferences.recentProvider !== null &&
		!isWorkerProvider(preferences.recentProvider)
	) {
		throw new Error("invalid Worker provider");
	}
	if (typeof preferences.syncAfterConnect !== "boolean") {
		throw new Error("invalid sync-after-connect setting");
	}
	if (typeof preferences.systemMetricsEnabled !== "boolean") {
		throw new Error("invalid system-metrics setting");
	}
	if (
		preferences.recentServerUrl !== null &&
		normalizeWorkerAddress(preferences.recentServerUrl) !== preferences.recentServerUrl
	) {
		throw new Error("invalid Worker address");
	}
}
