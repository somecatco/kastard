import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProgressBar } from "@/components/common/progress-bar";

const meta = {
	title: "Common/Progress Bar",
	component: ProgressBar,
	decorators: [
		(Story) => (
			<div className="w-80">
				<Story />
			</div>
		),
	],
	parameters: {
		layout: "centered",
	},
	args: {
		label: "Download progress",
		value: 48,
	},
} satisfies Meta<typeof ProgressBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
	args: {
		value: 0,
	},
};

export const Complete: Story = {
	args: {
		value: 100,
	},
};
