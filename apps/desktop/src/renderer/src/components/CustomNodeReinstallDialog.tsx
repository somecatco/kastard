import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

export function CustomNodeReinstallDialog({
	nodeId,
	onOpenChange,
	onConfirm,
}: {
	nodeId: string | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: (nodeId: string) => void;
}): React.JSX.Element {
	return (
		<Dialog open={nodeId !== null} onOpenChange={onOpenChange}>
			<DialogContent data-custom-node-reinstall-dialog>
				<form
					className="grid gap-5"
					onSubmit={(event) => {
						event.preventDefault();
						if (nodeId !== null) onConfirm(nodeId);
					}}
				>
					<DialogHeader>
						<DialogTitle>Force reinstall custom node?</DialogTitle>
						<DialogDescription>
							Kastard will remove {nodeId ?? "this custom node"} and install it again.
							If installation fails or is canceled after removal, the node will remain
							uninstalled.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" variant="destructive">
							Force reinstall
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
