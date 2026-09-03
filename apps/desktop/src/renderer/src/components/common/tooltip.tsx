import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Tooltip as UiTooltip,
	TooltipContent as UiTooltipContent,
	TooltipTrigger as UiTooltipTrigger,
} from "@/components/ui/tooltip";
import { useCloseHoverOverlay } from "@/hooks/useCloseHoverOverlay";
import { cn } from "@/lib/utils";

const HOVER_TRANSITION_GRACE_MS = 100;

type TooltipProps = Omit<
	ComponentPropsWithoutRef<typeof UiTooltipContent>,
	"children" | "onPointerEnter" | "onPointerLeave"
> & {
	trigger: ReactElement;
	children: ReactNode;
};

export function Tooltip({
	trigger,
	children,
	className,
	side = "bottom",
	sideOffset = 8,
	...contentProps
}: TooltipProps): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [openedFromPointer, setOpenedFromPointer] = useState(false);
	const closeTimerRef = useRef<number | null>(null);

	const cancelScheduledClose = useCallback(() => {
		if (closeTimerRef.current === null) return;
		window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	}, []);
	const close = useCallback(() => {
		cancelScheduledClose();
		setOpenedFromPointer(false);
		setOpen(false);
	}, [cancelScheduledClose]);
	const scheduleClose = useCallback(() => {
		if (!openedFromPointer) return;
		cancelScheduledClose();
		closeTimerRef.current = window.setTimeout(close, HOVER_TRANSITION_GRACE_MS);
	}, [cancelScheduledClose, close, openedFromPointer]);

	useEffect(() => cancelScheduledClose, [cancelScheduledClose]);
	useCloseHoverOverlay(open, openedFromPointer, close);

	return (
		<UiTooltip
			open={open}
			onOpenChange={(nextOpen) => {
				cancelScheduledClose();
				if (!nextOpen) setOpenedFromPointer(false);
				setOpen(nextOpen);
			}}
		>
			<UiTooltipTrigger
				asChild
				onFocus={(event) => {
					if (event.currentTarget.matches(":focus-visible")) {
						cancelScheduledClose();
						setOpenedFromPointer(false);
					}
				}}
				onPointerEnter={cancelScheduledClose}
				onPointerLeave={scheduleClose}
				onPointerMove={(event) => {
					if (event.pointerType === "touch") return;
					setOpenedFromPointer(!event.currentTarget.matches(":focus-visible"));
					cancelScheduledClose();
				}}
			>
				{trigger}
			</UiTooltipTrigger>
			<UiTooltipContent
				className={cn("cursor-text select-text", className)}
				side={side}
				sideOffset={sideOffset}
				onPointerEnter={cancelScheduledClose}
				onPointerLeave={scheduleClose}
				{...contentProps}
			>
				{children}
			</UiTooltipContent>
		</UiTooltip>
	);
}
