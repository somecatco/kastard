import { rm } from "node:fs/promises";
import { isWorkerProvider, type WorkerProvider } from "../../shared/api";
import { readJsonFile, writeJsonFile } from "../json-file";
import { normalizeWorkerAddress } from "./tunnel";

export type ConnectionPreferences = {
	recentProvider: WorkerProvider | null;
	recentWorkerAddress: string | null;
	syncAfterConnect: boolean;
	systemMetricsEnabled: boolean;
};

type StoredPreferences = ConnectionPreferences & {
	version: 4;
};

type LegacyStoredPreferences = Omit<ConnectionPreferences, "recentWorkerAddress"> & {
	version: 3;
	recentServerUrl: string | null;
};

export class ConnectionPreferencesStore {
	constructor(
		private readonly path: string,
		private readonly legacyPath?: string,
	) {}

	async load(): Promise<ConnectionPreferences | null> {
		const result = await readJsonFile(this.path);
		if (result.status === "value") return preferencesFromStored(result.value);
		if (result.status !== "missing" || this.legacyPath === undefined) return null;

		const legacy = await readJsonFile(this.legacyPath);
		if (legacy.status !== "value" || !isLegacyStoredPreferences(legacy.value)) {
			return null;
		}
		const preferences = preferencesFromLegacy(legacy.value);
		try {
			validatePreferences(preferences);
		} catch {
			return null;
		}
		await this.save(preferences);
		await rm(this.legacyPath, { force: true }).catch(() => undefined);
		return preferences;
	}

	async save(preferences: ConnectionPreferences): Promise<void> {
		validatePreferences(preferences);
		const stored: StoredPreferences = { version: 4, ...preferences };
		await writeJsonFile(this.path, stored);
	}
}

function isStoredPreferences(value: unknown): value is StoredPreferences {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StoredPreferences>;
	return (
		candidate.version === 4 &&
		(candidate.recentProvider === null || isWorkerProvider(candidate.recentProvider)) &&
		(candidate.recentWorkerAddress === null ||
			typeof candidate.recentWorkerAddress === "string") &&
		typeof candidate.syncAfterConnect === "boolean" &&
		typeof candidate.systemMetricsEnabled === "boolean"
	);
}

function isLegacyStoredPreferences(value: unknown): value is LegacyStoredPreferences {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<LegacyStoredPreferences>;
	return (
		candidate.version === 3 &&
		(candidate.recentProvider === null || isWorkerProvider(candidate.recentProvider)) &&
		(candidate.recentServerUrl === null ||
			typeof candidate.recentServerUrl === "string") &&
		typeof candidate.syncAfterConnect === "boolean" &&
		typeof candidate.systemMetricsEnabled === "boolean"
	);
}

function preferencesFromStored(value: unknown): ConnectionPreferences | null {
	if (!isStoredPreferences(value)) return null;
	const preferences: ConnectionPreferences = {
		recentProvider: value.recentProvider,
		recentWorkerAddress: value.recentWorkerAddress,
		syncAfterConnect: value.syncAfterConnect,
		systemMetricsEnabled: value.systemMetricsEnabled,
	};
	try {
		validatePreferences(preferences);
		return preferences;
	} catch {
		return null;
	}
}

function preferencesFromLegacy(value: LegacyStoredPreferences): ConnectionPreferences {
	return {
		recentProvider: value.recentProvider,
		recentWorkerAddress: value.recentServerUrl,
		syncAfterConnect: value.syncAfterConnect,
		systemMetricsEnabled: value.systemMetricsEnabled,
	};
}

function validatePreferences(preferences: ConnectionPreferences): void {
	if (
		(preferences.recentProvider === null) !==
		(preferences.recentWorkerAddress === null)
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
		preferences.recentWorkerAddress !== null &&
		normalizeWorkerAddress(preferences.recentWorkerAddress) !==
			preferences.recentWorkerAddress
	) {
		throw new Error("invalid Worker address");
	}
}
