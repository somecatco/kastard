import { Tooltip } from "@/components/common/tooltip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { selectTextOnTripleClick } from "@/lib/text-selection";
import type { GpuSystemStatus, WorkerSystemStatus } from "../../../shared/api";

type Metric = {
	label: string;
	value: string;
	progress: number | null;
	description: string;
	path?: string;
	details: string[];
	border: string;
	fill: string;
};

const COLORS = {
	cpu: { border: "#38bdf8", fill: "rgba(56, 189, 248, 0.18)" },
	ram: { border: "#a78bfa", fill: "rgba(167, 139, 250, 0.2)" },
	gpu: { border: "#4ade80", fill: "rgba(74, 222, 128, 0.18)" },
	vram: { border: "#22d3ee", fill: "rgba(34, 211, 238, 0.18)" },
	temperature: { border: "#fb923c", fill: "rgba(251, 146, 60, 0.2)" },
	disk: { border: "#fb7185", fill: "rgba(251, 113, 133, 0.18)" },
} as const;

export function WorkerStatus({
	status,
}: {
	status?: WorkerSystemStatus | undefined;
}): React.JSX.Element {
	const coreMetrics = [cpuMetric(status), ramMetric(status)];
	const gpuStatus = (status?.gpus ?? []).flatMap(gpuMetrics);

	return (
		<TooltipProvider delayDuration={150}>
			<ul
				className="ml-3 flex min-w-0 items-center gap-0.5 font-mono text-[9px] leading-none font-semibold"
				aria-label="Worker status"
			>
				{coreMetrics.map((metric) => (
					<MetricItem key={metric.description} metric={metric} />
				))}
				{gpuStatus.length > 0 ? (
					<li className="min-w-0 overflow-hidden">
						<ul aria-label="GPU status" className="flex w-max items-center gap-0.5">
							{gpuStatus.map((metric) => (
								<MetricItem key={metric.description} metric={metric} />
							))}
						</ul>
					</li>
				) : null}
				<MetricItem metric={diskMetric(status)} />
			</ul>
		</TooltipProvider>
	);
}

function MetricItem({ metric }: { metric: Metric }): React.JSX.Element {
	return (
		<li className="w-[82px] shrink-0">
			<Tooltip
				className="max-w-72 font-sans"
				trigger={
					<div
						role="img"
						className="flex h-7 w-full cursor-default select-text items-center justify-between gap-1 border px-1.5 text-sidebar-foreground"
						style={{
							borderColor: metric.border,
							backgroundImage:
								metric.progress === null
									? undefined
									: `linear-gradient(to right, ${metric.fill} ${metric.progress}%, transparent ${metric.progress}%)`,
						}}
						aria-label={metricAriaLabel(metric)}
					>
						<span>{metric.label}</span>
						<span className="tabular-nums">{metric.value}</span>
					</div>
				}
			>
				<p>{metric.description}</p>
				{metric.path === undefined ? null : (
					// biome-ignore lint/a11y/noStaticElementInteractions: Triple-click refines native text selection rather than adding a control.
					<span
						className="block text-muted-foreground"
						onMouseDown={selectTextOnTripleClick}
					>
						{metric.path}
					</span>
				)}
				{metric.details.map((detail) => (
					<p key={detail} className="text-muted-foreground">
						{detail}
					</p>
				))}
			</Tooltip>
		</li>
	);
}

function cpuMetric(status: WorkerSystemStatus | undefined): Metric {
	const usage = status?.cpu.usagePercent ?? null;
	return {
		label: "CPU",
		value: formatPercent(usage),
		progress: usage,
		description: "CPU usage",
		details: [],
		...COLORS.cpu,
	};
}

function ramMetric(status: WorkerSystemStatus | undefined): Metric {
	const ram = status?.ram;
	return {
		label: "RAM",
		value: formatPercent(ram?.usagePercent ?? null),
		progress: ram?.usagePercent ?? null,
		description: "RAM usage",
		details: [formatUsage(ram?.usedBytes ?? null, ram?.totalBytes ?? null)],
		...COLORS.ram,
	};
}

function diskMetric(status: WorkerSystemStatus | undefined): Metric {
	const disk = status?.disk;
	return {
		label: "DISK",
		value: formatPercent(disk?.usagePercent ?? null),
		progress: disk?.usagePercent ?? null,
		description: "Disk usage",
		path: disk?.path ?? "Path unavailable",
		details: [formatUsage(disk?.usedBytes ?? null, disk?.totalBytes ?? null)],
		...COLORS.disk,
	};
}

function gpuMetrics(gpu: GpuSystemStatus): Metric[] {
	const identity = `GPU ${gpu.index} · ${gpu.name}`;
	return [
		{
			label: `GPU${gpu.index}`,
			value: formatPercent(gpu.usagePercent),
			progress: gpu.usagePercent,
			description: `GPU ${gpu.index} usage`,
			details: [identity],
			...COLORS.gpu,
		},
		{
			label: `VRAM${gpu.index}`,
			value: formatPercent(gpu.vramUsagePercent),
			progress: gpu.vramUsagePercent,
			description: `GPU ${gpu.index} VRAM usage`,
			details: [identity, formatUsage(gpu.vramUsedBytes, gpu.vramTotalBytes)],
			...COLORS.vram,
		},
		{
			label: `TEMP${gpu.index}`,
			value: formatTemperature(gpu.temperatureC),
			progress:
				gpu.temperatureC === null ? null : Math.min(100, Math.max(0, gpu.temperatureC)),
			description: `GPU ${gpu.index} temperature`,
			details: [identity],
			...COLORS.temperature,
		},
	];
}

function formatPercent(value: number | null): string {
	return value === null ? "--" : `${Math.round(value)}%`;
}

function metricAriaLabel(metric: Metric): string {
	const value = metric.value === "--" ? "Unavailable" : metric.value;
	return [
		`${metric.description}: ${value}`,
		...(metric.path === undefined ? [] : [metric.path]),
		...metric.details.filter((detail) => detail !== "-- / --"),
	].join(". ");
}

function formatTemperature(value: number | null): string {
	return value === null ? "--" : `${Math.round(value)}°C`;
}

function formatUsage(usedBytes: number | null, totalBytes: number | null): string {
	return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
}

function formatBytes(value: number | null): string {
	if (value === null) return "--";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let amount = value;
	let unit = 0;
	while (amount >= 1024 && unit < units.length - 1) {
		amount /= 1024;
		unit += 1;
	}
	return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
