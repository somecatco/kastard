import type { WorkerRuntime } from "../../../shared/api";

export function workerComputeLabel(runtime: WorkerRuntime): string {
	return runtime.computeBackend === "cpu" ? "CPU" : `CUDA ${runtime.cudaVersion}`;
}
