import { readJsonFile, writeJsonFile } from "../json-file";

type StoredComfyGatewayPort = {
	version: 1;
	port: number;
};

export class ComfyGatewayPortStore {
	private port: number | null = null;

	constructor(private readonly path: string) {}

	async initialize(): Promise<void> {
		const result = await readJsonFile(this.path);
		if (result.status === "missing") return;
		if (result.status === "invalid") throw invalidPortError();
		const stored = result.value;
		if (!isStoredComfyGatewayPort(stored)) throw invalidPortError();
		this.port = stored.port;
	}

	get(): number | null {
		return this.port;
	}

	async update(port: number): Promise<void> {
		if (!isGatewayPort(port)) throw new Error("Invalid ComfyUI Gateway port.");
		const stored: StoredComfyGatewayPort = { version: 1, port };
		await writeJsonFile(this.path, stored);
		this.port = port;
	}
}

function isStoredComfyGatewayPort(value: unknown): value is StoredComfyGatewayPort {
	return (
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		value.version === 1 &&
		"port" in value &&
		isGatewayPort(value.port)
	);
}

function isGatewayPort(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 1_024 && Number(value) <= 65_535;
}

function invalidPortError(): Error {
	return new Error("The saved ComfyUI Gateway port is invalid.");
}
