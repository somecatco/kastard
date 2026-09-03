import { LoaderCircleIcon } from "lucide-react";
import type { FormEventHandler, ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

type AppFormDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	children?: ReactNode;
	onSubmit: FormEventHandler<HTMLFormElement>;
	submitting: boolean;
	submitLabel: string;
	submittingLabel: string;
	submitVariant?: ButtonProps["variant"];
	submitDisabled?: boolean;
	error?: string | null;
};

export function AppFormDialog({
	open,
	onOpenChange,
	title,
	description,
	children,
	onSubmit,
	submitting,
	submitLabel,
	submittingLabel,
	submitVariant = "default",
	submitDisabled = false,
	error,
}: AppFormDialogProps): React.JSX.Element {
	const changeOpen = (nextOpen: boolean): void => {
		if (!submitting) onOpenChange(nextOpen);
	};

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogContent>
				<form className="grid gap-5" onSubmit={onSubmit} noValidate>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					{children}
					{error ? (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => changeOpen(false)}
							disabled={submitting}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							variant={submitVariant}
							disabled={submitDisabled || submitting}
						>
							{submitting ? <LoaderCircleIcon className="animate-spin" /> : null}
							{submitting ? submittingLabel : submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
