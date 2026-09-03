import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "@/components/common/input";

const meta = {
	title: "Common/Input",
	component: Input,
	parameters: {
		layout: "centered",
	},
	args: {
		"aria-label": "Example input",
		className: "w-80",
		placeholder: "Enter value",
	},
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Filled: Story = {
	args: {
		defaultValue: "Example value",
	},
};

export const Password: Story = {
	args: {
		defaultValue: "secret-token",
		type: "password",
	},
};

export const Disabled: Story = {
	args: {
		disabled: true,
	},
};
