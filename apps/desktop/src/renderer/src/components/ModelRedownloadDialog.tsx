import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { ModelSyncTarget } from "../../../shared/api";

export function ModelRedownloadDialog({
	target,
	onOpenChange,
	onConfirm,
}: {
	target: ModelSyncTarget | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: (path: string) => void;
}): React.JSX.Element {
	return (
		<Dialog open={target !== null} onOpenChange={onOpenChange}>
			<DialogContent data-model-redownload-dialog>
				<form
					className="grid gap-5"
					onSubmit={(event) => {
						event.preventDefault();
						if (target !== null) onConfirm(target.path);
					}}
				>
					<DialogHeader>
						<DialogTitle>Force redownload model?</DialogTitle>
						<DialogDescription>
							Kastard will delete the current Worker file for{" "}
							{target?.name ?? "this model"} before downloading a new copy. If the
							download fails or is canceled, the model will remain unavailable.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" variant="destructive">
							Delete and redownload
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
