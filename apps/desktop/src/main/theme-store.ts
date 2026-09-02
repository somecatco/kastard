import { type DesktopTheme, isDesktopTheme } from "../shared/api";
import { readJsonFile, writeJsonFile } from "./json-file";

type StoredTheme = {
	version: 1;
	theme: DesktopTheme;
};

export class ThemeStore {
	private theme: DesktopTheme = "system";

	constructor(private readonly path: string) {}

	async initialize(): Promise<void> {
		const result = await readJsonFile(this.path);
		if (result.status === "missing") return;
		if (result.status === "invalid") throw invalidThemeError();
		const stored = result.value;
		if (!isStoredTheme(stored)) throw invalidThemeError();
		this.theme = stored.theme;
	}

	get(): DesktopTheme {
		return this.theme;
	}

	async update(theme: DesktopTheme): Promise<void> {
		if (!isDesktopTheme(theme)) throw new Error("Invalid desktop theme.");
		const stored: StoredTheme = { version: 1, theme };
		await writeJsonFile(this.path, stored);
		this.theme = theme;
	}
}

function isStoredTheme(value: unknown): value is StoredTheme {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StoredTheme>;
	return candidate.version === 1 && isDesktopTheme(candidate.theme);
}

function invalidThemeError(): Error {
	return new Error("The saved desktop theme is invalid.");
}
