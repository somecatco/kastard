import type { CustomNodeInventoryEntry } from "@kastard/common";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

export function CustomNodeRemovalDialog({
	node,
	onOpenChange,
	onConfirm,
}: {
	node: CustomNodeInventoryEntry | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: (node: CustomNodeInventoryEntry) => void;
}): React.JSX.Element {
	return (
		<Dialog open={node !== null} onOpenChange={onOpenChange}>
			<DialogContent data-custom-node-removal-dialog>
				<form
					className="grid gap-5"
					onSubmit={(event) => {
						event.preventDefault();
						if (node !== null) onConfirm(node);
					}}
				>
					<DialogHeader>
						<DialogTitle>Delete custom node from Worker?</DialogTitle>
						<DialogDescription className="select-text">
							This permanently deletes {node?.name ?? "this custom node"} from the
							Worker only. The Editor copy and sync selection are not changed. Restart
							Worker ComfyUI if it is running.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" variant="destructive">
							Delete from Worker
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
