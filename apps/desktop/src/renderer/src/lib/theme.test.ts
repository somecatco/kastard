import { afterEach, describe, expect, test, vi } from "vitest";
import { applyTheme, watchSystemTheme } from "./theme";

afterEach(() => {
	document.documentElement.classList.remove("dark");
	vi.restoreAllMocks();
});

function stubMatchMedia(matches: boolean): MediaQueryList {
	const media = {
		matches,
		media: "(prefers-color-scheme: dark)",
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(() => false),
	} satisfies MediaQueryList;
	vi.spyOn(window, "matchMedia").mockReturnValue(media);
	return media;
}

describe("applyTheme", () => {
	test("applies fixed and system themes to the Kastard document root", () => {
		stubMatchMedia(false);
		applyTheme("dark");
		expect(document.documentElement).toHaveClass("dark");
		applyTheme("light");
		expect(document.documentElement).not.toHaveClass("dark");
		applyTheme("system");
		expect(document.documentElement).not.toHaveClass("dark");

		stubMatchMedia(true);
		applyTheme("system");
		expect(document.documentElement).toHaveClass("dark");
	});
});

describe("watchSystemTheme", () => {
	test("removes the system appearance listener", () => {
		const media = stubMatchMedia(false);
		const listener = vi.fn();

		const dispose = watchSystemTheme(listener);
		expect(media.addEventListener).toHaveBeenCalledWith("change", listener);

		dispose();
		expect(media.removeEventListener).toHaveBeenCalledWith("change", listener);
	});
});
