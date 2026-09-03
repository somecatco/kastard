import type { Meta, StoryObj } from "@storybook/react-vite";
import { DesktopLayoutMockup } from "./desktop-mockups";

const meta = {
	title: "Mockups/Desktop Layout",
	component: DesktopLayoutMockup,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DesktopLayoutMockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
