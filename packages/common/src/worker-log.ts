import { isRecord } from "./validation";

export type WorkerLogLevel = "info" | "warning" | "error";

export type WorkerLogEntry = {
	id: string;
	timestamp: string;
	level: WorkerLogLevel;
	message: string;
};

export type WorkerLogSnapshot = {
	logs: WorkerLogEntry[];
	cursor: string;
	truncated: boolean;
};

export function isWorkerLogEntry(value: unknown): value is WorkerLogEntry {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.timestamp === "string" &&
		(value.level === "info" || value.level === "warning" || value.level === "error") &&
		typeof value.message === "string"
	);
}

export function parseWorkerLogSnapshot(value: unknown): WorkerLogSnapshot | null {
	return isRecord(value) &&
		Array.isArray(value.logs) &&
		value.logs.every(isWorkerLogEntry) &&
		typeof value.cursor === "string" &&
		typeof value.truncated === "boolean"
		? {
				logs: value.logs,
				cursor: value.cursor,
				truncated: value.truncated,
			}
		: null;
}
