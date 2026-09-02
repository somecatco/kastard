import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tooltip } from "@/components/common/tooltip";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";

function TooltipStory(): React.JSX.Element {
	return (
		<TooltipProvider delayDuration={0}>
			<Tooltip
				trigger={
					<Button type="button" variant="outline">
						Hover or focus
					</Button>
				}
			>
				Tooltip content remains open while the pointer is over it.
			</Tooltip>
		</TooltipProvider>
	);
}

const meta = {
	title: "Common/Tooltip",
	component: TooltipStory,
	parameters: {
		layout: "centered",
	},
} satisfies Meta<typeof TooltipStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
