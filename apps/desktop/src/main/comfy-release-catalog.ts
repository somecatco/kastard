import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ComfySourceComponent } from "../shared/api";
import { isVersion } from "./comfy-version-store";

export type ComfyRelease = {
	version: string;
	archiveUrl: string;
};

export type ComfyReleaseListing = {
	frontend: ComfyRelease[];
	backend: ComfyRelease[];
	manager: string[];
	/** Set when the live listing could not be refreshed; the lists still hold what is known. */
	error: string | null;
};

type CachedCatalog = {
	version: 2;
	fetchedAt: number;
	frontend: ComfyRelease[];
	backend: ComfyRelease[];
	manager: string[];
};

type CatalogOptions = {
	path: string;
	getBundled: () => { frontend: ComfyRelease; backend: ComfyRelease };
	fetch?: typeof fetch;
	now?: () => number;
	ttlMs?: number;
};

const BACKEND_RELEASES =
	"https://api.github.com/repos/Comfy-Org/ComfyUI/releases?per_page=50";
const FRONTEND_RELEASES =
	"https://api.github.com/repos/Comfy-Org/ComfyUI_frontend/releases?per_page=50";
const MANAGER_RELEASES = "https://pypi.org/pypi/comfyui-manager/json";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1_000;

/**
 * Lists the ComfyUI and Manager releases a user can pick from. Listings are cached on
 * disk so Settings does not repeatedly call the upstream APIs.
 */
export class ComfyReleaseCatalog {
	private cached: CachedCatalog | null = null;
	private request: Promise<ComfyReleaseListing> | null = null;
	private readonly requestFetch: typeof fetch;
	private readonly now: () => number;
	private readonly ttlMs: number;

	constructor(private readonly options: CatalogOptions) {
		this.requestFetch = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	}

	async initialize(): Promise<void> {
		try {
			const stored: unknown = JSON.parse(await readFile(this.options.path, "utf8"));
			this.cached = restoreCachedCatalog(stored);
		} catch {
			this.cached = null;
		}
	}

	find(component: ComfySourceComponent, version: string): ComfyRelease | null {
		const bundled = this.options.getBundled()[component];
		if (bundled.version === version) return bundled;
		return (
			this.cached?.[component].find((release) => release.version === version) ?? null
		);
	}

	hasManager(version: string): boolean {
		return this.cached?.manager.includes(version) ?? false;
	}

	async list(): Promise<ComfyReleaseListing> {
		const isStale =
			this.cached === null || this.now() - this.cached.fetchedAt >= this.ttlMs;
		if (!isStale) return this.listing(null);
		if (this.request !== null) return this.request;
		const request = this.refresh().finally(() => {
			if (this.request === request) this.request = null;
		});
		this.request = request;
		return request;
	}

	private async refresh(): Promise<ComfyReleaseListing> {
		const [backend, frontend, manager] = await Promise.allSettled([
			this.loadReleases(BACKEND_RELEASES, backendRelease),
			this.loadReleases(FRONTEND_RELEASES, frontendRelease),
			this.loadManagerReleases(),
		]);
		const errors = new Set<string>();
		for (const result of [backend, frontend, manager]) {
			if (result.status === "rejected") errors.add(errorMessage(result.reason));
		}
		if (
			backend.status === "fulfilled" ||
			frontend.status === "fulfilled" ||
			manager.status === "fulfilled"
		) {
			this.cached = {
				version: 2,
				// Keep partial results stale so a transient upstream failure is retried.
				fetchedAt: errors.size === 0 ? this.now() : 0,
				backend:
					backend.status === "fulfilled" ? backend.value : (this.cached?.backend ?? []),
				frontend:
					frontend.status === "fulfilled"
						? frontend.value
						: (this.cached?.frontend ?? []),
				manager:
					manager.status === "fulfilled" ? manager.value : (this.cached?.manager ?? []),
			};
			try {
				await this.persist(this.cached);
			} catch (error) {
				this.cached.fetchedAt = 0;
				errors.add(errorMessage(error));
			}
		}
		return this.listing(errors.size === 0 ? null : [...errors].join(" "));
	}

	private async loadManagerReleases(): Promise<string[]> {
		const response = await this.requestFetch(MANAGER_RELEASES, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`PyPI returned HTTP ${response.status}.`);
		const payload: unknown = await response.json();
		if (!isRecord(payload) || !isRecord(payload.releases)) {
			throw new Error("PyPI returned an invalid ComfyUI Manager release listing.");
		}
		return Object.entries(payload.releases)
			.filter(
				(entry): entry is [string, unknown[]] =>
					isStableManagerVersion(entry[0]) &&
					Array.isArray(entry[1]) &&
					entry[1].some(isAvailablePyPiFile),
			)
			.map(([version]) => version)
			.sort(compareVersionsDescending);
	}

	private async loadReleases(
		url: string,
		toRelease: (release: GithubRelease) => ComfyRelease | null,
	): Promise<ComfyRelease[]> {
		const response = await this.requestFetch(url, {
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`GitHub returned HTTP ${response.status}.`);
		}
		const payload: unknown = await response.json();
		if (!Array.isArray(payload)) {
			throw new Error("GitHub returned an invalid release listing.");
		}
		const releases: ComfyRelease[] = [];
		for (const entry of payload) {
			if (!isGithubRelease(entry) || entry.draft || entry.prerelease) continue;
			const release = toRelease(entry);
			if (release !== null) releases.push(release);
		}
		return releases;
	}

	private async persist(catalog: CachedCatalog): Promise<void> {
		await mkdir(dirname(this.options.path), { recursive: true });
		const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(catalog)}\n`);
			await rename(temporaryPath, this.options.path);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	private listing(error: string | null): ComfyReleaseListing {
		const bundled = this.options.getBundled();
		return {
			frontend: withBundled(this.cached?.frontend ?? [], bundled.frontend),
			backend: withBundled(this.cached?.backend ?? [], bundled.backend),
			manager: [...(this.cached?.manager ?? [])],
			error,
		};
	}
}

type GithubRelease = {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	assets: { name: string; browser_download_url: string }[];
};

function backendRelease(release: GithubRelease): ComfyRelease | null {
	const version = release.tag_name.replace(/^v/u, "");
	// The Worker only accepts this exact archive URL shape.
	if (!/^\d+\.\d+\.\d+$/u.test(version)) return null;
	return {
		version,
		archiveUrl: `https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v${version}.zip`,
	};
}

function frontendRelease(release: GithubRelease): ComfyRelease | null {
	if (!isVersion(release.tag_name)) return null;
	const asset = release.assets.find((entry) => entry.name === "dist.zip");
	if (asset === undefined) return null;
	return { version: release.tag_name, archiveUrl: asset.browser_download_url };
}

/** Keeps the bundled release selectable even when GitHub is unreachable or has moved on. */
function withBundled(
	releases: readonly ComfyRelease[],
	bundled: ComfyRelease,
): ComfyRelease[] {
	if (releases.some((release) => release.version === bundled.version)) {
		return [...releases];
	}
	// GitHub lists newest first and the listing is capped, so a missing bundled
	// version is older than everything listed.
	return [...releases, bundled];
}

function isGithubRelease(value: unknown): value is GithubRelease {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<GithubRelease>;
	return (
		typeof candidate.tag_name === "string" &&
		typeof candidate.draft === "boolean" &&
		typeof candidate.prerelease === "boolean" &&
		Array.isArray(candidate.assets) &&
		candidate.assets.every(
			(asset) =>
				typeof asset === "object" &&
				asset !== null &&
				typeof asset.name === "string" &&
				typeof asset.browser_download_url === "string",
		)
	);
}

function restoreCachedCatalog(value: unknown): CachedCatalog | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as {
		version?: unknown;
		fetchedAt?: unknown;
		frontend?: unknown;
		backend?: unknown;
		manager?: unknown;
	};
	return candidate.version === 2 &&
		typeof candidate.fetchedAt === "number" &&
		isReleaseList(candidate.frontend) &&
		isReleaseList(candidate.backend) &&
		isManagerReleaseList(candidate.manager)
		? (candidate as CachedCatalog)
		: null;
}

function isReleaseList(value: unknown): value is ComfyRelease[] {
	// A cached version becomes an install directory name, so it is validated on the way
	// back in as well as on the way out.
	return (
		Array.isArray(value) &&
		value.every((entry: unknown) => {
			if (typeof entry !== "object" || entry === null) return false;
			const release = entry as Partial<ComfyRelease>;
			return (
				typeof release.version === "string" &&
				isVersion(release.version) &&
				typeof release.archiveUrl === "string" &&
				release.archiveUrl.startsWith("https://github.com/")
			);
		})
	);
}

function isManagerReleaseList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isStableManagerVersion);
}

function isStableManagerVersion(value: string): boolean {
	return /^\d+\.\d+\.\d+$/u.test(value);
}

function isAvailablePyPiFile(value: unknown): boolean {
	return isRecord(value) && value.yanked === false;
}

function compareVersionsDescending(left: string, right: string): number {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Could not load ComfyUI releases.";
}
