import { isCustomNodeName } from "@kastard/common";
import { readJsonFile, writeJsonFile } from "../json-file";

type StoredCustomNodeSync = {
	version: 1;
	nodes: Array<{ name: string; sync: boolean }>;
};

export class CustomNodeSyncStore {
	private nodes = new Map<string, boolean>();
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly path: string) {}

	async initialize(): Promise<void> {
		this.nodes = (await this.load()) ?? new Map();
	}

	async get(name: string): Promise<boolean> {
		await this.writeQueue;
		return this.nodes.get(name) ?? true;
	}

	async update(name: string, sync: boolean): Promise<void> {
		if (!isCustomNodeName(name)) throw new Error("Invalid custom-node package name.");
		const update = this.writeQueue.then(async () => {
			const next = new Map(this.nodes).set(name, sync);
			await this.save(next);
			this.nodes = next;
		});
		this.writeQueue = update.catch(() => undefined);
		await update;
	}

	async remove(name: string): Promise<boolean | undefined> {
		if (!isCustomNodeName(name)) throw new Error("Invalid custom-node package name.");
		const update = this.writeQueue.then(async () => {
			const previous = this.nodes.get(name);
			if (previous === undefined) return undefined;
			const next = new Map(this.nodes);
			next.delete(name);
			await this.save(next);
			this.nodes = next;
			return previous;
		});
		this.writeQueue = update.then(
			() => undefined,
			() => undefined,
		);
		return update;
	}

	private async load(): Promise<Map<string, boolean> | null> {
		const result = await readJsonFile(this.path);
		if (result.status === "missing") return null;
		if (result.status === "invalid") throw invalidSettingsError();
		const stored = result.value;
		if (!isStoredCustomNodeSync(stored)) throw invalidSettingsError();
		return new Map(stored.nodes.map(({ name, sync }) => [name, sync]));
	}

	private async save(nodes: ReadonlyMap<string, boolean>): Promise<void> {
		const stored: StoredCustomNodeSync = {
			version: 1,
			nodes: [...nodes]
				.map(([name, sync]) => ({ name, sync }))
				.sort((left, right) =>
					left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
				),
		};
		await writeJsonFile(this.path, stored);
	}
}

function isStoredCustomNodeSync(value: unknown): value is StoredCustomNodeSync {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StoredCustomNodeSync>;
	if (candidate.version !== 1 || !Array.isArray(candidate.nodes)) return false;
	const names = new Set<string>();
	for (const node of candidate.nodes) {
		if (
			typeof node !== "object" ||
			node === null ||
			!("name" in node) ||
			typeof node.name !== "string" ||
			!("sync" in node) ||
			typeof node.sync !== "boolean"
		) {
			return false;
		}
		if (!isCustomNodeName(node.name)) return false;
		if (names.has(node.name)) return false;
		names.add(node.name);
	}
	return true;
}

function invalidSettingsError(): Error {
	return new Error("The saved custom-node sync settings are invalid.");
}
