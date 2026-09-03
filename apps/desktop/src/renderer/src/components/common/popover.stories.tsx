import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Popover, PopoverContent } from "@/components/common/popover";
import { Button } from "@/components/ui/button";
import { PopoverTrigger } from "@/components/ui/popover";

function PopoverStory(): React.JSX.Element {
	const [open, setOpen] = useState(false);

	return (
		<div className="flex items-center gap-4">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button type="button" variant="outline">
						Open popover
					</Button>
				</PopoverTrigger>
				<PopoverContent aria-label="Example popover" className="w-64">
					<div className="grid gap-3">
						<p className="cursor-text select-text text-sm text-muted-foreground">
							This popover closes when focus moves to another window.
						</p>
						<Button type="button" size="sm" onClick={() => setOpen(false)}>
							Done
						</Button>
					</div>
				</PopoverContent>
			</Popover>
			<Button type="button" variant="ghost">
				Outside action
			</Button>
		</div>
	);
}

const meta = {
	title: "Common/Popover",
	component: PopoverStory,
	parameters: {
		layout: "centered",
	},
} satisfies Meta<typeof PopoverStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
