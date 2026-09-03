export function ProgressBar({
	label,
	value,
	max = 100,
	showPercentage = true,
}: {
	label: string;
	value: number;
	max?: number;
	showPercentage?: boolean;
}): React.JSX.Element {
	const percentage = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

	return (
		<div className="flex items-center gap-3">
			<div
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={max}
				aria-valuenow={value}
				className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
			>
				<div
					className="h-full rounded-full bg-primary transition-[width] duration-300"
					style={{ width: `${percentage}%` }}
				/>
			</div>
			{showPercentage ? (
				<span className="w-9 text-right text-xs tabular-nums">
					{Math.round(percentage)}%
				</span>
			) : null}
		</div>
	);
}
