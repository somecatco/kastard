import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type Unzipped, unzip } from "fflate";
import type { ComfySourceComponent } from "../shared/api";
import type { ComfyRelease } from "./comfy-release-catalog";

export type ComfySourceStamp = {
	version: string;
	archiveUrl: string;
	sha256: string;
};

type InstallerOptions = {
	rootDirectory: string;
	fetch?: typeof fetch;
};

const STAMP_NAME = ".kastard-source.json";
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Installs a user-selected ComfyUI frontend or backend into the user data directory.
 * Upstream publishes no checksum for these releases, so the hash of the downloaded
 * archive is recorded in a stamp. For a backend that stamp is what the Editor sends the
 * Worker, which keeps both sides on the same bytes.
 */
export class ComfySourceInstaller {
	private readonly requestFetch: typeof fetch;

	constructor(private readonly options: InstallerOptions) {
		this.requestFetch = options.fetch ?? fetch;
	}

	/** Clears staging copies an interrupted install left behind; they hold a full ComfyUI. */
	async initialize(): Promise<void> {
		const parent = dirname(this.options.rootDirectory);
		const prefix = `${basename(this.options.rootDirectory)}-staging-`;
		const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
			await rm(join(parent, entry.name), { recursive: true, force: true }).catch(
				() => undefined,
			);
		}
	}

	directoryFor(component: ComfySourceComponent, version: string): string {
		return join(this.options.rootDirectory, component, version);
	}

	async readStamp(
		component: ComfySourceComponent,
		version: string,
	): Promise<ComfySourceStamp | null> {
		try {
			const raw = await readFile(
				join(this.directoryFor(component, version), STAMP_NAME),
				"utf8",
			);
			const parsed: unknown = JSON.parse(raw);
			return isStamp(parsed) && parsed.version === version ? parsed : null;
		} catch {
			return null;
		}
	}

	async remove(component: ComfySourceComponent, version: string): Promise<void> {
		await rm(this.directoryFor(component, version), { recursive: true, force: true });
	}

	async isInstalled(
		component: ComfySourceComponent,
		version: string,
	): Promise<boolean> {
		if ((await this.readStamp(component, version)) === null) return false;
		return (
			(await missingEntry(this.directoryFor(component, version), component)) === null
		);
	}

	/** Resolves to the installed directory, downloading the release when it is missing. */
	async install(
		component: ComfySourceComponent,
		release: ComfyRelease,
		onProgress: (progress: number) => void = () => {},
	): Promise<string> {
		const target = this.directoryFor(component, release.version);
		if (await this.isInstalled(component, release.version)) {
			onProgress(100);
			return target;
		}

		const temporaryRoot = await mkdtemp(`${this.options.rootDirectory}-staging-`);
		const staging = join(temporaryRoot, release.version);
		try {
			const archive = await this.download(release.archiveUrl, onProgress);
			const sha256 = createHash("sha256").update(archive).digest("hex");
			await extractZip(archive, staging, component === "backend");
			// Rejecting here keeps a release Kastard cannot start from becoming the
			// stored selection.
			const missing = await missingEntry(staging, component);
			if (missing !== null) {
				throw new Error(
					`The ComfyUI ${component} archive does not contain ${missing}.`,
				);
			}
			const stamp: ComfySourceStamp = {
				version: release.version,
				archiveUrl: release.archiveUrl,
				sha256,
			};
			await writeFile(
				join(staging, STAMP_NAME),
				`${JSON.stringify(stamp, null, "\t")}\n`,
			);
			await mkdir(dirname(target), { recursive: true });
			await rm(target, { recursive: true, force: true });
			await rename(staging, target);
			onProgress(100);
			return target;
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}

	private async download(
		url: string,
		onProgress: (progress: number) => void,
	): Promise<Uint8Array> {
		const response = await this.requestFetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!response.ok || response.body === null) {
			throw new Error(`Download failed with HTTP ${response.status}.`);
		}
		const expectedLength = Number(response.headers.get("content-length"));
		const chunks: Uint8Array[] = [];
		let received = 0;
		for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
			chunks.push(chunk);
			received += chunk.byteLength;
			if (Number.isFinite(expectedLength) && expectedLength > 0) {
				onProgress(Math.min(99, (received / expectedLength) * 100));
			}
		}
		const archive = new Uint8Array(received);
		let offset = 0;
		for (const chunk of chunks) {
			archive.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return archive;
	}
}

/** Everything the runtime reads straight from a release directory. */
function requiredEntries(component: ComfySourceComponent): readonly string[] {
	return component === "backend"
		? ["main.py", "requirements.txt", "manager_requirements.txt"]
		: ["index.html"];
}

async function missingEntry(
	directory: string,
	component: ComfySourceComponent,
): Promise<string | null> {
	for (const entry of requiredEntries(component)) {
		if (!(await pathExists(join(directory, entry)))) return entry;
	}
	return null;
}

async function extractZip(
	bytes: Uint8Array,
	target: string,
	stripFirstDirectory: boolean,
): Promise<void> {
	// Asynchronous so a large release does not block the main process while it inflates.
	const entries = await new Promise<Unzipped>((resolve, reject) => {
		unzip(bytes, (error, data) => (error ? reject(error) : resolve(data)));
	});
	for (const [entry, contents] of Object.entries(entries)) {
		if (entry.endsWith("/")) continue;
		const parts = entry.split("/");
		const relative = stripFirstDirectory ? parts.slice(1).join("/") : entry;
		if (relative.length === 0) continue;
		const output = safeArchivePath(target, relative);
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, contents);
	}
}

function safeArchivePath(root: string, entry: string): string {
	if (isAbsolute(entry) || entry.split(/[\\/]/u).includes("..")) {
		throw new Error(`Unsafe archive entry: ${entry}`);
	}
	const output = resolve(root, entry);
	if (output !== root && !output.startsWith(`${resolve(root)}${sep}`)) {
		throw new Error(`Archive entry escapes the target directory: ${entry}`);
	}
	return output;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isStamp(value: unknown): value is ComfySourceStamp {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ComfySourceStamp>;
	return (
		typeof candidate.version === "string" &&
		typeof candidate.archiveUrl === "string" &&
		typeof candidate.sha256 === "string"
	);
}
