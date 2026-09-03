import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

function DialogStory(): React.JSX.Element {
	const [open, setOpen] = useState(true);

	return (
		<>
			<Button type="button" onClick={() => setOpen(true)}>
				Open dialog
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Dialog title</DialogTitle>
						<DialogDescription>
							Describe what the user can do in this dialog.
						</DialogDescription>
					</DialogHeader>
					<p className="cursor-text select-text text-sm text-muted-foreground">
						Dialog content goes here.
					</p>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button type="button" onClick={() => setOpen(false)}>
							Continue
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

const meta = {
	title: "UI/Dialog",
	component: DialogStory,
	parameters: {
		layout: "centered",
	},
} satisfies Meta<typeof DialogStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
