import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Switch } from "@/components/common/switch";

type SwitchStoryProps = {
	disabled: boolean;
	initialChecked: boolean;
	label?: string;
	switchPosition: "left" | "right";
};

function SwitchStory({
	disabled,
	initialChecked,
	label,
	switchPosition,
}: SwitchStoryProps): React.JSX.Element {
	const [checked, setChecked] = useState(initialChecked);

	return (
		<Switch
			aria-label="Example setting"
			checked={checked}
			disabled={disabled}
			label={label}
			onChange={(event) => setChecked(event.currentTarget.checked)}
			switchPosition={switchPosition}
		/>
	);
}

const meta = {
	title: "Common/Switch",
	component: SwitchStory,
	parameters: {
		layout: "centered",
	},
	args: {
		disabled: false,
		initialChecked: false,
		switchPosition: "right",
	},
} satisfies Meta<typeof SwitchStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
	args: {
		initialChecked: true,
	},
};

export const WithLabel: Story = {
	args: {
		label: "Example setting",
	},
};

export const WithLabelSwitchLeft: Story = {
	args: {
		label: "Example setting",
		switchPosition: "left",
	},
};

export const Disabled: Story = {
	args: {
		disabled: true,
	},
};
