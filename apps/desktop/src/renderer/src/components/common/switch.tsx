import * as React from "react";

import { cn } from "@/lib/utils";

export interface SwitchProps
	extends Omit<
		React.InputHTMLAttributes<HTMLInputElement>,
		"aria-checked" | "checked" | "children" | "role" | "type"
	> {
	checked: boolean;
	label?: React.ReactNode;
	switchPosition?: "left" | "right";
}

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
	(
		{ checked, className, disabled, id, label, switchPosition = "right", ...props },
		ref,
	) => {
		const generatedId = React.useId();
		const inputId = id ?? generatedId;
		const control = (
			<span
				className={cn(
					"relative inline-flex h-5 w-9 shrink-0 items-center",
					label === undefined ? className : undefined,
				)}
			>
				<input
					{...props}
					ref={ref}
					id={inputId}
					type="checkbox"
					role="switch"
					aria-checked={checked}
					checked={checked}
					disabled={disabled}
					className="peer sr-only"
				/>
				<span
					aria-hidden="true"
					className="pointer-events-none h-5 w-9 rounded-full border border-input bg-input shadow-inner transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-background after:shadow-sm after:transition-transform peer-checked:border-primary peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:opacity-50"
				/>
			</span>
		);

		if (label === undefined) return control;
		const labelContent = <span>{label}</span>;

		return (
			<label
				htmlFor={inputId}
				className={cn(
					"inline-flex items-center gap-2 text-sm",
					disabled ? "cursor-not-allowed text-muted-foreground" : "cursor-default",
					className,
				)}
			>
				{switchPosition === "left" ? control : labelContent}
				{switchPosition === "left" ? labelContent : control}
			</label>
		);
	},
);
Switch.displayName = "Switch";

export { Switch };
