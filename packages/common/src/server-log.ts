import { isRecord } from "./validation";

export type ServerLogLevel = "info" | "warning" | "error";

export type ServerLogEntry = {
	id: string;
	timestamp: string;
	level: ServerLogLevel;
	message: string;
};

export type ServerLogSnapshot = {
	logs: ServerLogEntry[];
	cursor: string;
	truncated: boolean;
};

export function isServerLogEntry(value: unknown): value is ServerLogEntry {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.timestamp === "string" &&
		(value.level === "info" || value.level === "warning" || value.level === "error") &&
		typeof value.message === "string"
	);
}

export function parseServerLogSnapshot(value: unknown): ServerLogSnapshot | null {
	return isRecord(value) &&
		Array.isArray(value.logs) &&
		value.logs.every(isServerLogEntry) &&
		typeof value.cursor === "string" &&
		typeof value.truncated === "boolean"
		? {
				logs: value.logs,
				cursor: value.cursor,
				truncated: value.truncated,
			}
		: null;
}
