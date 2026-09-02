import type {
	BackendTarget,
	ComfyInstallState,
	ComfyReleaseOption,
	ComfySourceComponent,
	ComfyVersionCatalog,
	ComfyVersionState,
	ComfyVersionUpdate,
} from "../shared/api";
import type { ComfyRelease, ComfyReleaseCatalog } from "./comfy-release-catalog";
import { readManagerVersion, readPinnedFrontendVersion } from "./comfy-runtime";
import type { ComfySourceInstaller } from "./comfy-source-installer";
import type { ComfyVersionStore } from "./comfy-version-store";

type ComfyVersionsOptions = {
	store: ComfyVersionStore;
	catalog: ComfyReleaseCatalog;
	installer: ComfySourceInstaller;
	bundled: { frontend: ComfyRelease; backend: ComfyRelease };
	bundledBackendDirectory: string;
	bundledManagerVersion: string;
	/** The packaged Worker target, used while the bundled backend is selected. */
	bundledBackendTarget: BackendTarget;
	restartRuntime: () => Promise<unknown>;
	/** Re-projects the Worker sync state against the newly selected backend. */
	onBackendTargetChange?: () => void;
	/** Invalidates verification that used a different Manager target. */
	onManagerTargetChange?: () => void;
};

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
	private managerSwitching = false;
	private pendingManagerVersion: string | null | undefined;
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
	async resolveBackend(): Promise<{
		directory: string;
		version: string;
		sha256: string;
	} | null> {
		const version = this.options.store.get().backend;
		if (version === null) return null;
		const release = await this.installableRelease("backend", version);
		const directory = await this.installWithProgress("backend", release);
		// The refresh reads the stamp this needs, so the target it leaves behind is it.
		await this.refreshBackend();
		if (this.backendTarget === null) {
			throw new Error(`ComfyUI ${version} is not installed correctly.`);
		}
		return { directory, version, sha256: this.backendTarget.sha256 };
	}

	async resolveFrontend(): Promise<string | null> {
		const version = this.options.store.get().frontend;
		if (version === null) return null;
		return this.installWithProgress(
			"frontend",
			await this.installableRelease("frontend", version),
		);
	}

	/** The startup screen subscribes to the same state the Settings switch reports. */
	private async installWithProgress(
		component: ComfySourceComponent,
		release: ComfyRelease,
	): Promise<string> {
		const version = release.version;
		this.setInstall({ status: "installing", component, version, progress: 0 });
		try {
			return await this.options.installer.install(component, release, (progress) => {
				this.setInstall({
					status: "installing",
					component,
					version,
					progress: Math.round(progress),
				});
			});
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

	async select(update: ComfyVersionUpdate): Promise<ComfyVersionState> {
		if (update.component === "manager") return this.selectManager(update.version);
		return this.selectSource(update.component, update.version);
	}

	private async selectSource(
		component: ComfySourceComponent,
		requestedVersion: string | null,
	): Promise<ComfyVersionState> {
		const bundledVersion = this.options.bundled[component].version;
		const version =
			requestedVersion === null || requestedVersion === bundledVersion
				? null
				: requestedVersion;
		const replaced = this.options.store.get()[component];
		if (version === replaced) return this.getState();
		const generation = ++this.selectGeneration[component];

		if (version !== null) {
			try {
				await this.installWithProgress(component, this.release(component, version));
			} catch (error) {
				throw new Error(errorMessage(error), { cause: error });
			}
		}

		// A newer switch started while this one was downloading, and it owns both the
		// selection and the cleanup of whatever it replaces.
		if (generation !== this.selectGeneration[component]) return this.getState();

		await this.options.store.update(component, version);
		// After the refresh so subscribers never see the new selection paired with the
		// frontend the previous backend recommended.
		if (component === "backend") await this.refreshBackend();
		this.setInstall({ status: "idle" });
		// The replaced release stays on disk until ComfyUI has released its files, and
		// stays for good if the restart fails so the user can switch back to it.
		void this.options
			.restartRuntime()
			.then(() => this.removeReplaced(generation, component, replaced))
			.catch(() => undefined);
		return this.getState();
	}

	private async selectManager(
		requestedVersion: string | null,
	): Promise<ComfyVersionState> {
		const version = requestedVersion;
		const replaced = this.options.store.get().manager;
		if (version === replaced) return this.getState();
		if (this.managerSwitching) {
			throw new Error("A ComfyUI Manager version switch is already in progress.");
		}
		if (
			version !== null &&
			version !== this.recommendedManager &&
			version !== this.options.bundledManagerVersion &&
			!this.options.catalog.hasManager(version)
		) {
			throw new Error(`ComfyUI Manager ${version} is not a known release.`);
		}

		this.managerSwitching = true;
		this.pendingManagerVersion = version;
		try {
			try {
				await this.options.restartRuntime();
				await this.options.store.update("manager", version);
			} catch (error) {
				this.pendingManagerVersion = undefined;
				try {
					await this.options.restartRuntime();
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						"ComfyUI Manager switch and recovery failed.",
					);
				}
				throw new Error(errorMessage(error), { cause: error });
			}
			this.pendingManagerVersion = undefined;
			this.emit();
			this.options.onManagerTargetChange?.();
			return this.getState();
		} finally {
			this.pendingManagerVersion = undefined;
			this.managerSwitching = false;
		}
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

	private async refreshBackend(): Promise<void> {
		const previous = this.backendTarget;
		const previousManager = this.getManagerVersion();
		await this.readBackendTarget();
		if (
			previous?.version !== this.backendTarget?.version ||
			previous?.sha256 !== this.backendTarget?.sha256
		) {
			this.options.onBackendTargetChange?.();
		}
		if (previousManager !== this.getManagerVersion()) {
			this.options.onManagerTargetChange?.();
		}
	}

	private async readBackendTarget(): Promise<void> {
		const version = this.options.store.get().backend;
		if (version === null) {
			this.backendTarget = this.options.bundledBackendTarget;
			this.backendTargetError = undefined;
			this.recommendedFrontend = await readPinnedFrontendVersion(
				this.options.bundledBackendDirectory,
			);
			this.recommendedManager = this.options.bundledManagerVersion;
			return;
		}
		const stamp = await this.options.installer.readStamp("backend", version);
		this.backendTarget = stamp;
		this.backendTargetError =
			stamp === null ? `ComfyUI ${version} is not installed yet.` : undefined;
		this.recommendedFrontend = await readPinnedFrontendVersion(
			this.options.installer.directoryFor("backend", version),
		);
		this.recommendedManager =
			stamp === null
				? null
				: await readManagerVersion(
						this.options.installer.directoryFor("backend", version),
					);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
