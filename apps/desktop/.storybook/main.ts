import { resolve } from "node:path";
import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import { mergeConfig } from "vite";

const config: StorybookConfig = {
	stories: ["../src/renderer/src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
	framework: "@storybook/react-vite",
	viteFinal: (config) =>
		mergeConfig(config, {
			resolve: {
				alias: {
					"@": resolve(import.meta.dirname, "../src/renderer/src"),
				},
			},
			plugins: [tailwindcss()],
		}),
};

export default config;
