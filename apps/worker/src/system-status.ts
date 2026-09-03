import type { BigIntStatsFs } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import type { GpuSystemStatus, WorkerSystemStatus } from "@kastard/common";

const SAMPLE_INTERVAL_MS = 1_000;
const NVIDIA_QUERY_TIMEOUT_MS = 5_000;
const MEBIBYTE = 1024 * 1024;

export type { GpuSystemStatus, WorkerSystemStatus } from "@kastard/common";

export type SystemStatusApi = {
	getState(): WorkerSystemStatus;
};

type CpuSample = { usageMicroseconds: number; sampledAtMilliseconds: number };
type HostCpuSample = { idleMilliseconds: number; totalMilliseconds: number };
type DiskStats = Pick<BigIntStatsFs, "bsize" | "blocks" | "bfree" | "bavail">;

type SystemStatusMonitorOptions = {
	diskPath: string;
	intervalMs?: number;
	now?: () => Date;
	readText?: (path: string) => Promise<string>;
	readDisk?: (path: string) => Promise<DiskStats>;
	readGpus?: () => Promise<GpuSystemStatus[]>;
};

export class SystemStatusMonitor implements SystemStatusApi {
	private readonly intervalMs: number;
	private readonly now: () => Date;
	private readonly readText: (path: string) => Promise<string>;
	private readonly readDisk: (path: string) => Promise<DiskStats>;
	private readonly readGpus: () => Promise<GpuSystemStatus[]>;
	private state: WorkerSystemStatus;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private previousCpu: CpuSample | null = null;
	private previousHostCpu: HostCpuSample | null = null;
	private stopped = true;

	constructor(private readonly options: SystemStatusMonitorOptions) {
		this.intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
		this.now = options.now ?? (() => new Date());
		this.readText = options.readText ?? ((path) => readFile(path, "utf8"));
		this.readDisk = options.readDisk ?? ((path) => statfs(path, { bigint: true }));
		this.readGpus = options.readGpus ?? queryNvidiaGpus;
		this.state = emptySystemStatus(options.diskPath, this.now());
	}

	getState(): WorkerSystemStatus {
		return this.state;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		void this.sample();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	async sampleOnce(): Promise<WorkerSystemStatus> {
		const sampledAt = this.now();
		const [cpu, ram, disk, gpus] = await Promise.all([
			this.sampleCpu(sampledAt),
			this.sampleRam(),
			this.sampleDisk(),
			this.readGpus().catch(() => unavailableGpus(this.state.gpus)),
		]);
		this.state = {
			sampledAt: sampledAt.toISOString(),
			cpu,
			ram,
			disk,
			gpus,
		};
		return this.state;
	}

	private async sample(): Promise<void> {
		await this.sampleOnce();
		if (this.stopped) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.sample();
		}, this.intervalMs);
	}

	private async sampleCpu(sampledAt: Date): Promise<{ usagePercent: number | null }> {
		const current = await readCgroupCpu(this.readText, sampledAt).catch(() => null);
		if (current !== null) {
			const capacity = await readCpuCapacity(this.readText).catch(() =>
				os.availableParallelism(),
			);
			const usagePercent = cpuUsagePercent(this.previousCpu, current, capacity);
			this.previousCpu = current;
			return { usagePercent };
		}
		const currentHostCpu = hostCpuSample();
		const usagePercent = hostCpuUsagePercent(this.previousHostCpu, currentHostCpu);
		this.previousHostCpu = currentHostCpu;
		return { usagePercent };
	}

	private async sampleRam(): Promise<WorkerSystemStatus["ram"]> {
		try {
			const [currentText, maximumText] = await Promise.all([
				this.readText("/sys/fs/cgroup/memory.current"),
				this.readText("/sys/fs/cgroup/memory.max"),
			]);
			const usedBytes = parseNonNegativeNumber(currentText);
			const totalBytes =
				maximumText.trim() === "max" ? null : parsePositiveNumber(maximumText);
			if (usedBytes !== null && totalBytes !== null) {
				return {
					usedBytes,
					totalBytes,
					usagePercent: percent(usedBytes, totalBytes),
				};
			}
		} catch {
			// Fall through to host memory when cgroup v2 metrics are unavailable.
		}
		const totalBytes = os.totalmem();
		const usedBytes = Math.max(0, totalBytes - os.freemem());
		return { usedBytes, totalBytes, usagePercent: percent(usedBytes, totalBytes) };
	}

	private async sampleDisk(): Promise<WorkerSystemStatus["disk"]> {
		try {
			const value = await this.readDisk(this.options.diskPath);
			const totalBytes = safeByteCount(value.blocks * value.bsize);
			const usedBytes = safeByteCount((value.blocks - value.bfree) * value.bsize);
			const availableBytes = safeByteCount(value.bavail * value.bsize);
			if (totalBytes === null || usedBytes === null || availableBytes === null) {
				return unavailableDisk(this.options.diskPath);
			}
			return {
				path: this.options.diskPath,
				usedBytes,
				totalBytes,
				usagePercent: percent(usedBytes, usedBytes + availableBytes),
			};
		} catch {
			return unavailableDisk(this.options.diskPath);
		}
	}
}

export function parseNvidiaSmiOutput(output: string): GpuSystemStatus[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [
				indexValue,
				uuidValue,
				nameValue,
				usageValue,
				usedValue,
				totalValue,
				tempValue,
			] = line.split(",").map((field) => field.trim());
			const index = parseNonNegativeNumber(indexValue);
			if (
				index === null ||
				!Number.isInteger(index) ||
				uuidValue === undefined ||
				nameValue === undefined ||
				usageValue === undefined ||
				usedValue === undefined ||
				totalValue === undefined ||
				tempValue === undefined
			) {
				return null;
			}
			const vramUsedMib = parseNonNegativeNumber(usedValue);
			const vramTotalMib = parsePositiveNumber(totalValue);
			const vramUsedBytes = vramUsedMib === null ? null : vramUsedMib * MEBIBYTE;
			const vramTotalBytes = vramTotalMib === null ? null : vramTotalMib * MEBIBYTE;
			return {
				index,
				uuid: uuidValue,
				name: nameValue,
				usagePercent: boundedPercent(usageValue),
				vramUsedBytes,
				vramTotalBytes,
				vramUsagePercent:
					vramUsedBytes === null || vramTotalBytes === null
						? null
						: percent(vramUsedBytes, vramTotalBytes),
				temperatureC: parseNumber(tempValue),
			};
		})
		.filter((gpu): gpu is GpuSystemStatus => gpu !== null)
		.sort((left, right) => left.index - right.index);
}

async function queryNvidiaGpus(): Promise<GpuSystemStatus[]> {
	const process = Bun.spawn(
		[
			"nvidia-smi",
			"--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
			"--format=csv,noheader,nounits",
		],
		{ stdout: "pipe", stderr: "ignore" },
	);
	const timeout = setTimeout(() => process.kill(), NVIDIA_QUERY_TIMEOUT_MS);
	const [exitCode, output] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
	]).finally(() => clearTimeout(timeout));
	if (exitCode !== 0) throw new Error(`nvidia-smi exited with code ${exitCode}.`);
	return parseNvidiaSmiOutput(output);
}

async function readCgroupCpu(
	readText: (path: string) => Promise<string>,
	sampledAt: Date,
): Promise<CpuSample> {
	const cpuStat = await readText("/sys/fs/cgroup/cpu.stat");
	const match = /^usage_usec\s+(\d+)$/m.exec(cpuStat);
	if (match?.[1] === undefined) throw new Error("cgroup CPU usage is unavailable.");
	return {
		usageMicroseconds: Number(match[1]),
		sampledAtMilliseconds: sampledAt.getTime(),
	};
}

async function readCpuCapacity(
	readText: (path: string) => Promise<string>,
): Promise<number> {
	const [quotaValue, periodValue] = (await readText("/sys/fs/cgroup/cpu.max"))
		.trim()
		.split(/\s+/);
	if (quotaValue === "max") return os.availableParallelism();
	const quota = parsePositiveNumber(quotaValue);
	const period = parsePositiveNumber(periodValue);
	return quota === null || period === null ? os.availableParallelism() : quota / period;
}

function cpuUsagePercent(
	previous: CpuSample | null,
	current: CpuSample,
	capacity: number,
): number | null {
	if (previous === null || capacity <= 0) return null;
	const elapsedMicroseconds =
		(current.sampledAtMilliseconds - previous.sampledAtMilliseconds) * 1_000;
	const usedMicroseconds = current.usageMicroseconds - previous.usageMicroseconds;
	if (elapsedMicroseconds <= 0 || usedMicroseconds < 0) return null;
	return clamp((usedMicroseconds / elapsedMicroseconds / capacity) * 100, 0, 100);
}

function hostCpuSample(): HostCpuSample {
	const cpus = os.cpus();
	return {
		idleMilliseconds: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0),
		totalMilliseconds: cpus
			.flatMap((cpu) => Object.values(cpu.times))
			.reduce((sum, value) => sum + value, 0),
	};
}

function hostCpuUsagePercent(
	previous: HostCpuSample | null,
	current: HostCpuSample,
): number | null {
	if (previous === null) return null;
	const total = current.totalMilliseconds - previous.totalMilliseconds;
	const idle = current.idleMilliseconds - previous.idleMilliseconds;
	return total <= 0 || idle < 0 ? null : clamp(((total - idle) / total) * 100, 0, 100);
}

function emptySystemStatus(diskPath: string, now: Date): WorkerSystemStatus {
	return {
		sampledAt: now.toISOString(),
		cpu: { usagePercent: null },
		ram: { usedBytes: null, totalBytes: null, usagePercent: null },
		disk: { path: diskPath, usedBytes: null, totalBytes: null, usagePercent: null },
		gpus: [],
	};
}

function unavailableGpus(gpus: GpuSystemStatus[]): GpuSystemStatus[] {
	return gpus.map((gpu) => ({
		...gpu,
		usagePercent: null,
		vramUsedBytes: null,
		vramTotalBytes: null,
		vramUsagePercent: null,
		temperatureC: null,
	}));
}

function unavailableDisk(path: string): WorkerSystemStatus["disk"] {
	return { path, usedBytes: null, totalBytes: null, usagePercent: null };
}

function safeByteCount(value: bigint): number | null {
	return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function percent(used: number, total: number): number | null {
	return total <= 0 ? null : clamp((used / total) * 100, 0, 100);
}

function boundedPercent(value: string | undefined): number | null {
	const parsed = parseNumber(value);
	return parsed === null ? null : clamp(parsed, 0, 100);
}

function parsePositiveNumber(value: string | undefined): number | null {
	const parsed = parseNumber(value);
	return parsed !== null && parsed > 0 ? parsed : null;
}

function parseNonNegativeNumber(value: string | undefined): number | null {
	const parsed = parseNumber(value);
	return parsed !== null && parsed >= 0 ? parsed : null;
}

function parseNumber(value: string | undefined): number | null {
	if (value === undefined || value === "N/A" || value === "[Not Supported]")
		return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
