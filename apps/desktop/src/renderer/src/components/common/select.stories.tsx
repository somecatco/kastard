import type { Meta, StoryObj } from "@storybook/react-vite";
import { Select } from "@/components/common/select";

function SelectStory({ disabled }: { disabled: boolean }): React.JSX.Element {
	return (
		<Select aria-label="Theme" defaultValue="system" disabled={disabled}>
			<option value="system">System</option>
			<option value="light">Light</option>
			<option value="dark">Dark</option>
		</Select>
	);
}

const meta = {
	title: "Common/Select",
	component: SelectStory,
	parameters: {
		layout: "centered",
	},
	args: {
		disabled: false,
	},
} satisfies Meta<typeof SelectStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
	args: {
		disabled: true,
	},
};
