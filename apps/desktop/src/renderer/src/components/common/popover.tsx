import * as React from "react";
import {
	Popover as UiPopover,
	PopoverContent as UiPopoverContent,
} from "@/components/ui/popover";
import { useCloseOnWindowBlur } from "@/hooks/useCloseOnWindowBlur";

type PopoverProps = Omit<
	React.ComponentPropsWithoutRef<typeof UiPopover>,
	"open" | "onOpenChange"
> & {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

const WindowBlurCloseContext = React.createContext<
	React.MutableRefObject<boolean> | undefined
>(undefined);

export function Popover({
	open,
	onOpenChange,
	...props
}: PopoverProps): React.JSX.Element {
	const closingFromWindowBlur = React.useRef(false);

	useCloseOnWindowBlur(open, () => {
		closingFromWindowBlur.current = true;
		onOpenChange(false);
	});

	return (
		<WindowBlurCloseContext value={closingFromWindowBlur}>
			<UiPopover
				open={open}
				onOpenChange={(nextOpen) => {
					if (nextOpen) closingFromWindowBlur.current = false;
					onOpenChange(nextOpen);
				}}
				{...props}
			/>
		</WindowBlurCloseContext>
	);
}

export const PopoverContent = React.forwardRef<
	React.ElementRef<typeof UiPopoverContent>,
	React.ComponentPropsWithoutRef<typeof UiPopoverContent>
>(({ onCloseAutoFocus, ...props }, ref) => {
	const closingFromWindowBlur = React.useContext(WindowBlurCloseContext);
	if (closingFromWindowBlur === undefined) {
		throw new Error("PopoverContent must be used inside Popover.");
	}

	return (
		<UiPopoverContent
			ref={ref}
			onCloseAutoFocus={(event) => {
				if (closingFromWindowBlur.current) {
					event.preventDefault();
					closingFromWindowBlur.current = false;
				}
				onCloseAutoFocus?.(event);
			}}
			{...props}
		/>
	);
});
PopoverContent.displayName = "PopoverContent";
