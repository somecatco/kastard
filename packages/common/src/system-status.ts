import {
	isNonNegativeInteger,
	isNonNegativeNumberOrNull,
	isPercentageOrNull,
	isRecord,
} from "./validation";

export type GpuSystemStatus = {
	index: number;
	uuid: string;
	name: string;
	usagePercent: number | null;
	vramUsedBytes: number | null;
	vramTotalBytes: number | null;
	vramUsagePercent: number | null;
	temperatureC: number | null;
};

type ByteUsage = {
	usedBytes: number | null;
	totalBytes: number | null;
	usagePercent: number | null;
};

export type WorkerSystemStatus = {
	sampledAt: string;
	cpu: { usagePercent: number | null };
	ram: ByteUsage;
	disk: ByteUsage & { path: string };
	gpus: GpuSystemStatus[];
};

export function parseWorkerSystemStatus(value: unknown): WorkerSystemStatus | null {
	if (
		!isRecord(value) ||
		typeof value.sampledAt !== "string" ||
		!isRecord(value.cpu) ||
		!isPercentageOrNull(value.cpu.usagePercent) ||
		!isByteUsage(value.ram) ||
		!isRecord(value.disk) ||
		typeof value.disk.path !== "string" ||
		!isByteUsage(value.disk) ||
		!Array.isArray(value.gpus) ||
		!value.gpus.every(isGpuSystemStatus)
	) {
		return null;
	}
	return value as WorkerSystemStatus;
}

export function isWorkerSystemStatus(value: unknown): value is WorkerSystemStatus {
	return parseWorkerSystemStatus(value) !== null;
}

function isGpuSystemStatus(value: unknown): value is GpuSystemStatus {
	return (
		isRecord(value) &&
		isNonNegativeInteger(value.index) &&
		typeof value.uuid === "string" &&
		typeof value.name === "string" &&
		isPercentageOrNull(value.usagePercent) &&
		isNonNegativeNumberOrNull(value.vramUsedBytes) &&
		isNonNegativeNumberOrNull(value.vramTotalBytes) &&
		isPercentageOrNull(value.vramUsagePercent) &&
		(value.temperatureC === null ||
			(typeof value.temperatureC === "number" && Number.isFinite(value.temperatureC)))
	);
}

function isByteUsage(value: unknown): value is ByteUsage {
	return (
		isRecord(value) &&
		isNonNegativeNumberOrNull(value.usedBytes) &&
		isNonNegativeNumberOrNull(value.totalBytes) &&
		isPercentageOrNull(value.usagePercent)
	);
}
