import { describe, expect, test } from "bun:test";
import { parseNvidiaSmiOutput, SystemStatusMonitor } from "./system-status";

describe("NVIDIA system status", () => {
	test("parses and orders multiple GPUs", () => {
		expect(
			parseNvidiaSmiOutput(
				[
					"1, GPU-b, NVIDIA RTX 4090, 72, 12288, 24564, 68",
					"0, GPU-a, NVIDIA RTX 4090, 31, 4096, 24564, 51",
				].join("\n"),
			),
		).toEqual([
			{
				index: 0,
				uuid: "GPU-a",
				name: "NVIDIA RTX 4090",
				usagePercent: 31,
				vramUsedBytes: 4_294_967_296,
				vramTotalBytes: 25_757_220_864,
				vramUsagePercent: 16.67480866308419,
				temperatureC: 51,
			},
			{
				index: 1,
				uuid: "GPU-b",
				name: "NVIDIA RTX 4090",
				usagePercent: 72,
				vramUsedBytes: 12_884_901_888,
				vramTotalBytes: 25_757_220_864,
				vramUsagePercent: 50.02442598925256,
				temperatureC: 68,
			},
		]);
	});

	test("keeps a GPU when individual measurements are unavailable", () => {
		expect(
			parseNvidiaSmiOutput("0, GPU-a, NVIDIA A100, [Not Supported], N/A, 81920, N/A"),
		).toEqual([
			{
				index: 0,
				uuid: "GPU-a",
				name: "NVIDIA A100",
				usagePercent: null,
				vramUsedBytes: null,
				vramTotalBytes: 85_899_345_920,
				vramUsagePercent: null,
				temperatureC: null,
			},
		]);
	});
});

describe("worker system status sampling", () => {
	const gpu = {
		index: 0,
		uuid: "GPU-a",
		name: "NVIDIA RTX 4090",
		usagePercent: 72,
		vramUsedBytes: 12,
		vramTotalBytes: 24,
		vramUsagePercent: 50,
		temperatureC: 68,
	};

	test("uses cgroup CPU and memory limits and preserves GPU identity on query failure", async () => {
		let now = 0;
		let cpuUsage = 1_000_000;
		let gpuQuery = 0;
		const monitor = new SystemStatusMonitor({
			diskPath: "/workspace",
			now: () => new Date(now),
			readText: async (path) => {
				if (path.endsWith("cpu.stat")) return `usage_usec ${cpuUsage}`;
				if (path.endsWith("cpu.max")) return "200000 100000";
				if (path.endsWith("memory.current")) return "25";
				if (path.endsWith("memory.max")) return "100";
				throw new Error(`Unexpected path: ${path}`);
			},
			readDisk: async () => ({ blocks: 100n, bsize: 10n, bfree: 40n, bavail: 30n }),
			readGpus: async () => {
				gpuQuery += 1;
				if (gpuQuery > 1) throw new Error("nvidia-smi unavailable");
				return [gpu];
			},
		});

		now = 1_000;
		const first = await monitor.sampleOnce();
		expect(first.cpu.usagePercent).toBeNull();
		expect(first.ram).toEqual({
			usedBytes: 25,
			totalBytes: 100,
			usagePercent: 25,
		});
		expect(first.disk).toEqual({
			path: "/workspace",
			usedBytes: 600,
			totalBytes: 1_000,
			usagePercent: 66.66666666666666,
		});
		expect(first.gpus).toEqual([gpu]);

		now = 2_000;
		cpuUsage = 2_000_000;
		const second = await monitor.sampleOnce();
		expect(second.cpu.usagePercent).toBe(50);
		expect(second.gpus).toEqual([
			{
				...gpu,
				usagePercent: null,
				vramUsedBytes: null,
				vramTotalBytes: null,
				vramUsagePercent: null,
				temperatureC: null,
			},
		]);
	});

	test("keeps valid metrics when disk statistics cannot represent byte counts", async () => {
		const monitor = new SystemStatusMonitor({
			diskPath: "/workspace",
			now: () => new Date(1_000),
			readText: async (path) => {
				if (path.endsWith("cpu.stat")) return "usage_usec 1000000";
				if (path.endsWith("cpu.max")) return "200000 100000";
				if (path.endsWith("memory.current")) return "25";
				if (path.endsWith("memory.max")) return "100";
				throw new Error(`Unexpected path: ${path}`);
			},
			readDisk: async () => ({
				blocks: -29_315_396_784n,
				bsize: 4_096n,
				bfree: 7_659_285_344n,
				bavail: 7_659_285_344n,
			}),
			readGpus: async () => [gpu],
		});

		const status = await monitor.sampleOnce();

		expect(status.ram).toEqual({
			usedBytes: 25,
			totalBytes: 100,
			usagePercent: 25,
		});
		expect(status.disk).toEqual({
			path: "/workspace",
			usedBytes: null,
			totalBytes: null,
			usagePercent: null,
		});
		expect(status.gpus).toEqual([gpu]);
	});
});
