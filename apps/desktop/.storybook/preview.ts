import type { Preview } from "@storybook/react-vite";
import type { DesktopTheme } from "../src/shared/api";
import "../src/renderer/src/index.css";
import { activateStoryDesktopApiMock } from "../src/renderer/src/stories/desktop-api-mock";

type PreviewEnvironment = typeof globalThis & {
	document?: {
		documentElement: {
			classList: { toggle: (token: string, force: boolean) => unknown };
		};
	};
	matchMedia?: (query: string) => { matches: boolean };
};

function desktopTheme(value: unknown): DesktopTheme {
	return value === "light" || value === "dark" ? value : "system";
}

function applyPreviewTheme(theme: DesktopTheme): void {
	const environment = globalThis as PreviewEnvironment;
	const dark =
		theme === "dark" ||
		(theme === "system" &&
			environment.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
	environment.document?.documentElement.classList.toggle("dark", dark);
}

const preview = {
	beforeEach: ({ id }) => activateStoryDesktopApiMock(id),
	globalTypes: {
		theme: {
			description: "Desktop theme",
			toolbar: {
				title: "Theme",
				icon: "circlehollow",
				items: [
					{ value: "system", title: "System" },
					{ value: "light", title: "Light" },
					{ value: "dark", title: "Dark" },
				],
				dynamicTitle: true,
			},
		},
	},
	initialGlobals: {
		theme: "system",
	},
	decorators: [
		(Story, context) => {
			applyPreviewTheme(desktopTheme(context.globals.theme));
			return Story();
		},
	],
} satisfies Preview;

export default preview;
