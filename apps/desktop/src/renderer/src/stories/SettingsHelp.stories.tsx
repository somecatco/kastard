import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { SettingsHelpMockup } from "./desktop-mockups";

const meta = {
	title: "Mockups/Settings/Help",
	component: SettingsHelpMockup,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SettingsHelpMockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole("button", { name: "Help" }));
	},
};
