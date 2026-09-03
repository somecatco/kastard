import { EllipsisIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent } from "@/components/common/popover";
import { ProgressBar } from "@/components/common/progress-bar";
import { Button } from "@/components/ui/button";
import { PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type WorkerSyncTargetStatus = "current" | "stale" | "unknown";

export function WorkerSyncList({
	titleId,
	title,
	status,
	action,
	progressLabel,
	progressValue,
	progressMax,
	progressDetail,
	targetStatus,
	error,
	onDismissActionMenu,
	children,
	afterList,
}: {
	titleId: string;
	title: string;
	status: ReactNode;
	action: ReactNode;
	progressLabel: string;
	progressValue: number;
	progressMax: number;
	progressDetail?: ReactNode;
	targetStatus?: WorkerSyncTargetStatus | undefined;
	error: string | null;
	onDismissActionMenu: () => void;
	children: ReactNode;
	afterList?: ReactNode;
}): React.JSX.Element {
	return (
		<section
			aria-labelledby={titleId}
			className="select-text cursor-text"
			onPointerDownCapture={(event) => {
				if (
					event.target instanceof Element &&
					event.target.closest("[data-worker-sync-action]") !== null
				) {
					return;
				}
				onDismissActionMenu();
			}}
		>
			<header className="grid gap-3 p-5 pb-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 id={titleId} className="text-sm font-medium">
							{title}
						</h2>
						<p className="mt-2 text-xs text-muted-foreground" role="status">
							{status}
						</p>
					</div>
					{action}
				</div>
				<ProgressBar
					label={progressLabel}
					value={progressValue}
					max={progressMax}
					showPercentage={false}
				/>
				{progressDetail === undefined ? null : (
					<p className="text-[11px] text-muted-foreground tabular-nums">
						{progressDetail}
					</p>
				)}
				<WorkerSyncTargetNotice status={targetStatus} />
			</header>
			{error === null ? null : (
				<p className="border-y px-5 py-3 text-xs text-destructive" role="alert">
					{error}
				</p>
			)}
			<ul className={error === null ? "border-t" : ""}>{children}</ul>
			{afterList}
		</section>
	);
}

export function WorkerSyncListRow({
	ariaLabel,
	icon,
	content,
	status,
	action,
}: {
	ariaLabel?: string;
	icon: ReactNode;
	content: ReactNode;
	status: ReactNode;
	action?: ReactNode;
}): React.JSX.Element {
	const showsAction = action !== undefined && action !== null;
	return (
		<li
			aria-label={ariaLabel}
			className={cn(
				"grid items-center gap-3 border-b px-5 py-3 last:border-b-0",
				showsAction
					? "grid-cols-[auto_minmax(0,1fr)_auto_auto]"
					: "grid-cols-[auto_minmax(0,1fr)_auto]",
			)}
		>
			{icon}
			{content}
			{status}
			{action}
		</li>
	);
}

export function WorkerSyncActionMenu({
	open,
	disabled,
	busy,
	ariaLabel,
	contentClassName,
	onOpenChange,
	children,
}: {
	open: boolean;
	disabled: boolean;
	busy: boolean;
	ariaLabel: string;
	contentClassName?: string;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
}): React.JSX.Element {
	return (
		<Popover
			open={open && !disabled}
			onOpenChange={(nextOpen) => onOpenChange(nextOpen && !disabled)}
		>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-7"
					data-worker-sync-action
					disabled={disabled}
					aria-label={ariaLabel}
				>
					{busy ? <LoaderCircleIcon className="animate-spin" /> : <EllipsisIcon />}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				data-connection-control
				data-worker-sync-action
				data-worker-sync-action-menu
				align="end"
				sideOffset={4}
				className={cn("w-44 rounded-lg p-1.5", contentClassName)}
				aria-label={ariaLabel}
			>
				{children}
			</PopoverContent>
		</Popover>
	);
}

export function WorkerSyncActionMenuItem({
	icon,
	destructive = false,
	onClick,
	children,
}: {
	icon: ReactNode;
	destructive?: boolean;
	onClick: () => void;
	children: ReactNode;
}): React.JSX.Element {
	return (
		<button
			type="button"
			className={cn(
				"flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				destructive && "text-destructive hover:bg-destructive/10",
			)}
			onClick={onClick}
		>
			{icon}
			{children}
		</button>
	);
}

export function WorkerSyncCancelButton({
	description,
	canceling,
	label = "Cancel",
	className,
	onCancel,
}: {
	description: string;
	canceling: boolean;
	label?: string;
	className?: string;
	onCancel?: () => void;
}): React.JSX.Element {
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className={className}
			onClick={onCancel}
			disabled={canceling}
			aria-label={
				canceling
					? `Canceling ${description}`
					: label === "Cancel"
						? `Cancel ${description}`
						: label
			}
		>
			{canceling ? <LoaderCircleIcon className="animate-spin" /> : <XIcon />}
			{canceling ? "Canceling…" : label}
		</Button>
	);
}

export function WorkerSyncTargetNotice({
	status,
}: {
	status?: WorkerSyncTargetStatus | undefined;
}): React.JSX.Element | null {
	if (status === undefined || status === "current") return null;
	return (
		<p
			className={cn(
				"text-xs",
				status === "stale" ? "text-warning" : "text-muted-foreground",
			)}
			role="status"
		>
			{status === "stale"
				? "Worker status belongs to a previous Editor target."
				: "This Worker does not report which Editor target produced this status."}
		</p>
	);
}
