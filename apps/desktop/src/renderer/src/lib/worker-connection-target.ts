import type { WorkerProvider } from "../../../shared/api";

export function buildWorkerServerUrl(
	_provider: WorkerProvider,
	value: string,
): string | null {
	const trimmedValue = value.trim();
	return trimmedValue === "" ? null : trimmedValue;
}

export function connectionInputValue(
	provider: WorkerProvider | null,
	serverUrl: string | null,
): string {
	return provider === null || serverUrl === null ? "" : serverUrl;
}
