import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type SelectProps = ComponentProps<"select">;

export function Select({
	children,
	className,
	...props
}: SelectProps): React.JSX.Element {
	return (
		<div className="group/select relative shrink-0">
			<select
				{...props}
				className={cn(
					"block h-8 min-w-32 appearance-none rounded-full border border-input bg-background py-0 pl-4 pr-[38px] text-sm font-medium shadow-sm transition-colors group-hover/select:enabled:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
			>
				{children}
			</select>
			<ChevronDownIcon
				aria-hidden="true"
				className="pointer-events-none absolute right-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
		</div>
	);
}
