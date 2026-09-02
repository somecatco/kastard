import { isCustomNodeManagerVersion } from "@kastard/common";
import type { ComfyComponent, ComfyVersionSelection } from "../shared/api";
import { readJsonFile, writeJsonFile } from "./json-file";

type StoredSelection = ComfyVersionSelection & { version: 2 };

const BUNDLED: ComfyVersionSelection = {
	frontend: null,
	backend: null,
	manager: null,
};

export class ComfyVersionStore {
	private selection: ComfyVersionSelection = BUNDLED;

	constructor(private readonly path: string) {}

	async initialize(): Promise<void> {
		const result = await readJsonFile(this.path);
		if (result.status === "missing") return;
		if (result.status === "invalid") throw invalidSelectionError();
		const stored = result.value;
		if (!isStoredSelection(stored)) throw invalidSelectionError();
		this.selection = {
			frontend: stored.frontend,
			backend: stored.backend,
			manager: stored.manager,
		};
	}

	get(): ComfyVersionSelection {
		return this.selection;
	}

	async update(
		component: ComfyComponent,
		version: string | null,
	): Promise<ComfyVersionSelection> {
		if (
			version !== null &&
			(component === "manager"
				? !isCustomNodeManagerVersion(version)
				: !isVersion(version))
		) {
			throw new Error(
				component === "manager"
					? "Invalid ComfyUI Manager version."
					: "Invalid ComfyUI version.",
			);
		}
		const selection: ComfyVersionSelection = {
			...this.selection,
			[component]: version,
		};
		await this.persist(selection);
		this.selection = selection;
		return selection;
	}

	private async persist(selection: ComfyVersionSelection): Promise<void> {
		const stored: StoredSelection = { version: 2, ...selection };
		await writeJsonFile(this.path, stored);
	}
}

/** Rejects anything that could escape a version directory or a release tag URL. */
export function isVersion(value: string): boolean {
	return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
}

function isStoredSelection(value: unknown): value is StoredSelection {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StoredSelection>;
	if (candidate.version !== 2) return false;
	return (
		(candidate.frontend === null ||
			(typeof candidate.frontend === "string" && isVersion(candidate.frontend))) &&
		(candidate.backend === null ||
			(typeof candidate.backend === "string" && isVersion(candidate.backend))) &&
		(candidate.manager === null || isCustomNodeManagerVersion(candidate.manager))
	);
}

function invalidSelectionError(): Error {
	return new Error("The saved ComfyUI version selection is invalid.");
}
