import type { DesktopTheme } from "../../../shared/api";

function darkMedia(): MediaQueryList {
	return window.matchMedia("(prefers-color-scheme: dark)");
}

export function applyTheme(theme: DesktopTheme): void {
	document.documentElement.classList.toggle(
		"dark",
		theme === "dark" || (theme === "system" && darkMedia().matches),
	);
}

export function watchSystemTheme(onChange: () => void): () => void {
	const media = darkMedia();
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
}
