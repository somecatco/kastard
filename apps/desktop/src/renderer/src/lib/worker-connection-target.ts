import type { WorkerProvider } from "../../../shared/api";

export function buildWorkerAddress(
	_provider: WorkerProvider,
	value: string,
): string | null {
	const trimmedValue = value.trim();
	return trimmedValue === "" ? null : trimmedValue;
}

export function connectionInputValue(
	provider: WorkerProvider | null,
	workerAddress: string | null,
): string {
	return provider === null || workerAddress === null ? "" : workerAddress;
}
