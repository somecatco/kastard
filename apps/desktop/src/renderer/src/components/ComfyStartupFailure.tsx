import { Trigger as DialogTrigger } from "@radix-ui/react-dialog";
import { AlertTriangleIcon, FileTextIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";
import { ComfyStartupLogsDialog } from "@/components/ComfyStartupLogsDialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { ComfyStartupFailure as StartupFailure } from "../../../shared/api";

export function ComfyStartupFailure({
	failure,
	onRetry,
}: {
	failure: StartupFailure;
	onRetry: () => void;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background px-6 py-10">
			<Dialog open={open} onOpenChange={setOpen}>
				<div className="flex max-w-md flex-col items-center gap-5 text-center">
					<AlertTriangleIcon aria-hidden="true" className="size-8 text-destructive" />
					<div className="cursor-text select-text" role="alert">
						<h2 className="text-lg font-semibold">ComfyUI failed to start</h2>
						<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
							Local ComfyUI is unavailable.
							<br />
							View the logs for error details.
						</p>
					</div>
					<div className="flex flex-wrap justify-center gap-2">
						<DialogTrigger asChild>
							<Button type="button">
								<FileTextIcon aria-hidden="true" />
								View logs
							</Button>
						</DialogTrigger>
						<Button type="button" variant="outline" onClick={onRetry}>
							<RotateCwIcon aria-hidden="true" />
							Try again
						</Button>
					</div>
				</div>
				{open ? (
					<ComfyStartupLogsDialog failure={failure} onClose={() => setOpen(false)} />
				) : null}
			</Dialog>
		</div>
	);
}
