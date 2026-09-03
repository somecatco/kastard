import { BoxesIcon, PuzzleIcon, SettingsIcon, WorkflowIcon } from "lucide-react";
import { useCallback, useState } from "react";
import {
	ConnectionControl,
	type ConnectionPopoverId,
	ConnectionWorkerStatus,
} from "@/components/ConnectionControl";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type AppSurface = "comfy" | "models" | "custom-nodes" | "settings";

type AppHeaderProps = {
	activeSurface: AppSurface;
	onNavigate: (surface: AppSurface) => void;
	closeConnectionRequest: number;
};

const NAVIGATION_ITEMS = [
	{ id: "comfy", label: "ComfyUI", icon: WorkflowIcon },
	{ id: "models", label: "Model Library", icon: BoxesIcon },
	{ id: "custom-nodes", label: "Custom Nodes", icon: PuzzleIcon },
	{ id: "settings", label: "Settings", icon: SettingsIcon },
] as const;

export function AppHeader({
	activeSurface,
	onNavigate,
	closeConnectionRequest,
}: AppHeaderProps): React.JSX.Element {
	const [openConnectionPopovers, setOpenConnectionPopovers] = useState<
		ReadonlySet<ConnectionPopoverId>
	>(() => new Set());
	const connectionPopoverOpen = openConnectionPopovers.size > 0;
	const handleConnectionPopoverOpenChange = useCallback(
		(popover: ConnectionPopoverId, open: boolean) => {
			setOpenConnectionPopovers((current) => {
				if (current.has(popover) === open) return current;
				const next = new Set(current);
				if (open) next.add(popover);
				else next.delete(popover);
				return next;
			});
		},
		[],
	);

	return (
		<header
			data-testid="window-titlebar"
			className={cn(
				"relative grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 bg-sidebar pr-3 pl-24 text-sidebar-foreground",
				connectionPopoverOpen
					? "[-webkit-app-region:no-drag]"
					: "[-webkit-app-region:drag]",
			)}
			onPointerDownCapture={(event) => {
				if (!connectionPopoverOpen) return;
				if (
					event.target instanceof Element &&
					event.target.closest("[data-connection-control]")
				) {
					return;
				}
				setOpenConnectionPopovers(new Set());
			}}
		>
			<nav
				aria-label="Primary navigation"
				className="col-start-2 row-start-1 flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
			>
				<TooltipProvider delayDuration={150} disableHoverableContent>
					{NAVIGATION_ITEMS.map(({ id, label, icon: Icon }) => {
						const active = activeSurface === id;
						return (
							<Tooltip key={id}>
								<TooltipTrigger asChild>
									<button
										type="button"
										aria-current={active ? "page" : undefined}
										aria-label={label}
										onClick={() => onNavigate(id)}
										className={cn(
											"flex size-8 items-center justify-center rounded-full text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
											active && "bg-sidebar-accent text-sidebar-accent-foreground",
										)}
									>
										<Icon className="size-4" />
									</button>
								</TooltipTrigger>
								<TooltipContent
									className="pointer-events-none"
									side="bottom"
									sideOffset={8}
								>
									{label}
								</TooltipContent>
							</Tooltip>
						);
					})}
				</TooltipProvider>
			</nav>
			<div className="col-start-1 row-start-1 flex max-w-[calc(100%-3rem)] min-w-0 items-center overflow-hidden justify-self-start">
				<div data-connection-control className="shrink-0 [-webkit-app-region:no-drag]">
					<ConnectionControl
						openPopovers={openConnectionPopovers}
						onPopoverOpenChange={handleConnectionPopoverOpenChange}
						closeRequest={closeConnectionRequest}
					/>
				</div>
				<div className="min-w-0 overflow-hidden [-webkit-app-region:no-drag]">
					<ConnectionWorkerStatus />
				</div>
			</div>
		</header>
	);
}
