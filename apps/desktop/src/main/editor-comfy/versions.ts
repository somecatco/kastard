import type {
	BackendTarget,
	ComfyInstallState,
	ComfyReleaseOption,
	ComfySourceComponent,
	ComfyVersionCatalog,
	ComfyVersionState,
	ComfyVersionUpdate,
} from "../../shared/api";
import type { ComfyRelease, ComfyReleaseCatalog } from "./release-catalog";
import { readManagerVersion, readPinnedFrontendVersion } from "./runtime";
import type { ComfySourceInstaller } from "./source-installer";
import type { ComfyVersionStore } from "./version-store";

type ComfyVersionsOptions = {
	store: ComfyVersionStore;
	catalog: ComfyReleaseCatalog;
	installer: ComfySourceInstaller;
	bundled: { frontend: ComfyRelease; backend: ComfyRelease };
	bundledBackendDirectory: string;
	bundledManagerVersion: string;
	/** The packaged Worker target, used while the bundled backend is selected. */
	bundledBackendTarget: BackendTarget;
	/** Re-projects the Worker sync state against the newly selected backend. */
	onBackendTargetChange?: () => void;
	/** Invalidates verification that used a different Manager target. */
	onManagerTargetChange?: () => void;
};

export type ComfySelection =
	| { component: ComfySourceComponent; generation: number; replaced: string | null }
	| { component: "manager"; version: string | null };

/**
 * Owns which ComfyUI frontend, backend, and Manager the Editor runs. The backend and
 * Manager targets are also projected into Worker synchronization.
 */
export class ComfyVersions {
	private install: ComfyInstallState = { status: "idle" };
	/** Per component: a switch only supersedes another switch of the same component. */
	private readonly selectGeneration: Record<ComfySourceComponent, number> = {
		frontend: 0,
		backend: 0,
	};
	private pendingManagerVersion: string | null | undefined;
	private selectionWrites: Promise<unknown> = Promise.resolve();
	private backendTarget: BackendTarget | null;
	private backendTargetError: string | undefined;
	private recommendedFrontend: string | null = null;
	private recommendedManager: string | null;
	private readonly listeners = new Set<(state: ComfyVersionState) => void>();

	constructor(private readonly options: ComfyVersionsOptions) {
		this.backendTarget = options.bundledBackendTarget;
		this.recommendedManager = options.bundledManagerVersion;
	}

	async initialize(): Promise<void> {
		await this.refreshBackend();
	}

	subscribe(listener: (state: ComfyVersionState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getState(): ComfyVersionState {
		return {
			selection: this.options.store.get(),
			bundled: {
				frontend: this.options.bundled.frontend.version,
				backend: this.options.bundled.backend.version,
				manager: this.options.bundledManagerVersion,
			},
			recommendedFrontend: this.recommendedFrontend,
			recommendedManager: this.recommendedManager,
			install: this.install,
		};
	}

	getBackendTarget(): BackendTarget | null {
		return this.backendTarget;
	}

	getBackendTargetError(): string | undefined {
		return this.backendTargetError;
	}

	getManagerVersion(): string {
		return (
			this.options.store.get().manager ??
			this.recommendedManager ??
			this.options.bundledManagerVersion
		);
	}

	getRuntimeManagerVersion(): string {
		if (this.pendingManagerVersion === undefined) return this.getManagerVersion();
		return (
			this.pendingManagerVersion ??
			this.recommendedManager ??
			this.options.bundledManagerVersion
		);
	}

	async listCatalog(): Promise<ComfyVersionCatalog> {
		const listing = await this.options.catalog.list();
		const [frontend, backend] = await Promise.all([
			this.releaseOptions("frontend", listing.frontend),
			this.releaseOptions("backend", listing.backend),
		]);
		const effectiveManager = this.getManagerVersion();
		const managerVersions = new Set(listing.manager);
		if (this.recommendedManager !== null) {
			managerVersions.add(this.recommendedManager);
		}
		managerVersions.add(effectiveManager);
		const selectedManager = this.options.store.get().manager;
		if (selectedManager !== null) managerVersions.add(selectedManager);
		const manager = [...managerVersions].map((version) => ({
			version,
			installed: version === effectiveManager,
		}));
		return { frontend, backend, manager, error: listing.error };
	}

	/** Resolves the ComfyUI source for the runtime, installing the selection when needed. */
	async resolveBackend(signal?: AbortSignal): Promise<{
		directory: string;
		version: string;
		sha256: string;
	} | null> {
		const version = this.options.store.get().backend;
		if (version === null) return null;
		const release = await this.installableRelease("backend", version);
		const directory = await this.installWithProgress("backend", release, signal);
		signal?.throwIfAborted();
		const stamp = await this.options.installer.readStamp("backend", version);
		await this.refreshBackend(signal);
		if (stamp === null) {
			throw new Error(`ComfyUI ${version} is not installed correctly.`);
		}
		return { directory, version, sha256: stamp.sha256 };
	}

	async resolveFrontend(signal?: AbortSignal): Promise<string | null> {
		const version = this.options.store.get().frontend;
		if (version === null) return null;
		return this.installWithProgress(
			"frontend",
			await this.installableRelease("frontend", version),
			signal,
		);
	}

	/** The startup screen subscribes to the same state the Settings switch reports. */
	private async installWithProgress(
		component: ComfySourceComponent,
		release: ComfyRelease,
		signal?: AbortSignal,
	): Promise<string> {
		const version = release.version;
		this.setInstall({ status: "installing", component, version, progress: 0 });
		try {
			return await this.options.installer.install(
				component,
				release,
				(progress) => {
					if (signal?.aborted) return;
					this.setInstall({
						status: "installing",
						component,
						version,
						progress: Math.round(progress),
					});
				},
				signal,
			);
		} finally {
			// A newer switch may already be reporting its own download.
			if (
				this.install.status === "installing" &&
				this.install.component === component &&
				this.install.version === version
			) {
				this.setInstall({ status: "idle" });
			}
		}
	}

	/**
	 * Where the selected backend lives, without installing it. A selection that is not on
	 * disk reports nothing so readers fall back to the bundled release instead of failing.
	 */
	async selectedBackendDirectory(): Promise<string | null> {
		const version = this.options.store.get().backend;
		if (version === null) return null;
		return (await this.options.installer.isInstalled("backend", version))
			? this.options.installer.directoryFor("backend", version)
			: null;
	}

	async prepareSelection(
		update: ComfyVersionUpdate,
		signal?: AbortSignal,
	): Promise<ComfySelection | null> {
		signal?.throwIfAborted();
		if (update.component === "manager")
			return this.prepareManagerSelection(update.version);
		return this.prepareSourceSelection(update.component, update.version, signal);
	}

	private async prepareSourceSelection(
		component: ComfySourceComponent,
		requestedVersion: string | null,
		signal?: AbortSignal,
	): Promise<ComfySelection | null> {
		const bundledVersion = this.options.bundled[component].version;
		const version =
			requestedVersion === null || requestedVersion === bundledVersion
				? null
				: requestedVersion;
		const generation = ++this.selectGeneration[component];
		if (version !== null && version !== this.options.store.get()[component]) {
			await this.installWithProgress(
				component,
				await this.installableRelease(component, version),
				signal,
			);
		}
		return this.writeSelection(async () => {
			signal?.throwIfAborted();
			if (generation !== this.selectGeneration[component]) return null;
			const replaced = this.options.store.get()[component];
			if (version === replaced) return null;
			await this.options.store.update(component, version);
			signal?.throwIfAborted();
			if (component === "backend") await this.refreshBackend(signal);
			this.setInstall({ status: "idle" });
			return { component, generation, replaced };
		});
	}

	private writeSelection<T>(write: () => Promise<T>): Promise<T> {
		const pending = this.selectionWrites.catch(() => undefined).then(write);
		this.selectionWrites = pending;
		return pending;
	}

	private prepareManagerSelection(version: string | null): ComfySelection | null {
		if (version === this.options.store.get().manager) return null;
		if (
			version !== null &&
			version !== this.recommendedManager &&
			version !== this.options.bundledManagerVersion &&
			!this.options.catalog.hasManager(version)
		) {
			throw new Error(`ComfyUI Manager ${version} is not a known release.`);
		}
		this.pendingManagerVersion = version;
		return { component: "manager", version };
	}

	async completeSelection(
		selection: ComfySelection,
		signal?: AbortSignal,
	): Promise<ComfyVersionState> {
		if (selection.component === "manager") {
			return this.writeSelection(async () => {
				signal?.throwIfAborted();
				await this.options.store.update("manager", selection.version);
				signal?.throwIfAborted();
				this.clearPendingManager();
				this.emit();
				this.options.onManagerTargetChange?.();
				return this.getState();
			});
		}
		await this.removeReplaced(
			selection.generation,
			selection.component,
			selection.replaced,
		);
		return this.getState();
	}

	clearPendingManager(): void {
		this.pendingManagerVersion = undefined;
	}

	/** The bundled release ships with Kastard, so it never needs downloading. */
	private async releaseOptions(
		component: ComfySourceComponent,
		releases: readonly ComfyRelease[],
	): Promise<ComfyReleaseOption[]> {
		const bundledVersion = this.options.bundled[component].version;
		return Promise.all(
			releases.map(async (release) => ({
				version: release.version,
				installed:
					release.version === bundledVersion ||
					(await this.options.installer.isInstalled(component, release.version)),
			})),
		);
	}

	private async removeReplaced(
		generation: number,
		component: ComfySourceComponent,
		replaced: string | null,
	): Promise<void> {
		// A restart can settle after the user started switching again, and the release
		// being removed may be the one that switch is about to select.
		if (generation !== this.selectGeneration[component]) return;
		if (replaced === null || this.options.store.get()[component] === replaced) return;
		await this.options.installer.remove(component, replaced);
	}

	/**
	 * An installed release is described by its own stamp, so it stays startable when the
	 * release listing is unavailable.
	 */
	private async installableRelease(
		component: ComfySourceComponent,
		version: string,
	): Promise<ComfyRelease> {
		const stamp = await this.options.installer.readStamp(component, version);
		if (stamp !== null) {
			return { version: stamp.version, archiveUrl: stamp.archiveUrl };
		}
		return this.release(component, version);
	}

	private release(component: ComfySourceComponent, version: string): ComfyRelease {
		const release = this.options.catalog.find(component, version);
		if (release === null) {
			throw new Error(`ComfyUI ${component} ${version} is not a known release.`);
		}
		return release;
	}

	private async refreshBackend(signal?: AbortSignal): Promise<void> {
		const version = this.options.store.get().backend;
		const directory =
			version === null
				? this.options.bundledBackendDirectory
				: this.options.installer.directoryFor("backend", version);
		const target =
			version === null
				? this.options.bundledBackendTarget
				: await this.options.installer.readStamp("backend", version);
		const [frontend, manager] = await Promise.all([
			readPinnedFrontendVersion(directory),
			version === null
				? this.options.bundledManagerVersion
				: target === null
					? null
					: readManagerVersion(directory),
		]);
		signal?.throwIfAborted();
		if (this.options.store.get().backend !== version) return;
		const previous = this.backendTarget;
		const previousManager = this.getManagerVersion();
		this.backendTarget = target;
		this.backendTargetError =
			target === null ? `ComfyUI ${version} is not installed yet.` : undefined;
		this.recommendedFrontend = frontend;
		this.recommendedManager = manager;
		if (previous?.version !== target?.version || previous?.sha256 !== target?.sha256)
			this.options.onBackendTargetChange?.();
		if (previousManager !== this.getManagerVersion())
			this.options.onManagerTargetChange?.();
	}

	private setInstall(install: ComfyInstallState): void {
		this.install = install;
		this.emit();
	}

	private emit(): void {
		const state = this.getState();
		for (const listener of this.listeners) listener(state);
	}
}
