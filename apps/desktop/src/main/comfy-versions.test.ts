// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ComfyVersionState } from "../shared/api";
import type { ComfyRelease, ComfyReleaseCatalog } from "./comfy-release-catalog";
import type { ComfySourceInstaller } from "./comfy-source-installer";
import { ComfyVersionStore } from "./comfy-version-store";
import { ComfyVersions } from "./comfy-versions";

const temporaryDirectories: string[] = [];
const bundledBackend = {
	version: "0.33.1",
	archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.33.1.zip",
	sha256: "a".repeat(64),
};
const bundledFrontend = {
	version: "v1.52.1",
	archiveUrl:
		"https://github.com/Comfy-Org/ComfyUI_frontend/releases/download/v1.52.1/dist.zip",
};
const selectedBackend: ComfyRelease = {
	version: "0.34.0",
	archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.34.0.zip",
};
const laterBackend: ComfyRelease = {
	version: "0.35.0",
	archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.35.0.zip",
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function harness(
	options: { installFails?: boolean; managerVersions?: string[] } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "kastard-comfy-versions-test-"));
	temporaryDirectories.push(root);
	const bundledBackendDirectory = join(root, "bundled-backend");
	await mkdir(bundledBackendDirectory, { recursive: true });
	await writeFile(
		join(bundledBackendDirectory, "requirements.txt"),
		"comfyui-frontend-package==1.48.7\n",
	);
	await writeFile(
		join(bundledBackendDirectory, "manager_requirements.txt"),
		"comfyui_manager==4.2.2\n",
	);
	const store = new ComfyVersionStore(join(root, "comfy-version.json"));
	await store.initialize();

	const installed = new Map<string, string>();
	const gates = new Map<string, Promise<void>>();
	const install = vi.fn(
		async (
			component: string,
			release: ComfyRelease,
			onProgress?: (progress: number) => void,
		) => {
			if (options.installFails) throw new Error("Download failed with HTTP 500.");
			onProgress?.(50);
			await gates.get(`${component}:${release.version}`);
			const directory = join(root, component, release.version);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, "requirements.txt"),
				"comfyui-frontend-package==1.50.0\n",
			);
			await writeFile(
				join(directory, "manager_requirements.txt"),
				release.version === selectedBackend.version
					? "comfyui_manager==4.3.0\n"
					: "comfyui_manager==4.4.0\n",
			);
			installed.set(`${component}:${release.version}`, directory);
			return directory;
		},
	);
	const remove = vi.fn(async (component: string, version: string) => {
		installed.delete(`${component}:${version}`);
	});
	const installer = {
		install,
		remove,
		directoryFor: (component: string, version: string) =>
			join(root, component, version),
		isInstalled: async (component: string, version: string) =>
			installed.has(`${component}:${version}`),
		readStamp: async (component: string, version: string) =>
			installed.has(`${component}:${version}`)
				? {
						version,
						archiveUrl: selectedBackend.archiveUrl,
						sha256: "b".repeat(64),
					}
				: null,
	} as unknown as ComfySourceInstaller;

	let catalogAvailable = true;
	const managerVersions = options.managerVersions ?? ["4.4.0", "4.3.0", "4.2.2"];
	const catalog = {
		find: (component: string, version: string) => {
			if (!catalogAvailable) return null;
			if (component === "backend" && version === selectedBackend.version) {
				return selectedBackend;
			}
			if (component === "backend" && version === laterBackend.version) {
				return laterBackend;
			}
			if (component === "backend" && version === bundledBackend.version) {
				return bundledBackend;
			}
			if (component === "frontend" && version === "v1.53.0") {
				return {
					version: "v1.53.0",
					archiveUrl: "https://github.com/Comfy-Org/ComfyUI_frontend/dist.zip",
				};
			}
			return null;
		},
		list: async () => ({
			frontend: [
				{
					version: "v1.53.0",
					archiveUrl: "https://github.com/Comfy-Org/ComfyUI_frontend/dist.zip",
				},
			],
			backend: [laterBackend, selectedBackend, bundledBackend],
			manager: managerVersions,
			error: null,
		}),
		hasManager: (version: string) => managerVersions.includes(version),
	} as unknown as ComfyReleaseCatalog;

	const restarts = vi.fn(async () => null);
	let targetChanges = 0;
	let managerTargetChanges = 0;
	const versions = new ComfyVersions({
		store,
		catalog,
		installer,
		bundled: { backend: bundledBackend, frontend: bundledFrontend },
		bundledBackendDirectory,
		bundledManagerVersion: "4.2.2",
		bundledBackendTarget: bundledBackend,
		restartRuntime: restarts,
		onBackendTargetChange: () => {
			targetChanges += 1;
		},
		onManagerTargetChange: () => {
			managerTargetChanges += 1;
		},
	});
	await versions.initialize();
	return {
		versions,
		install,
		remove,
		restarts,
		root,
		targetChanges: () => targetChanges,
		managerTargetChanges: () => managerTargetChanges,
		forgetCatalog: () => {
			catalogAvailable = false;
		},
		forgetInstall: (component: string, version: string) => {
			installed.delete(`${component}:${version}`);
		},
		holdInstall: (component: string, version: string) => {
			let release = () => {};
			gates.set(
				`${component}:${version}`,
				new Promise<void>((resolve) => {
					release = () => resolve();
				}),
			);
			return () => {
				gates.delete(`${component}:${version}`);
				release();
			};
		},
	};
}

async function settled(versions: ComfyVersions): Promise<ComfyVersionState> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	return versions.getState();
}

test("starts on the bundled versions and reports the frontend they pin", async () => {
	const { versions } = await harness();

	expect(versions.getState()).toEqual({
		selection: { frontend: null, backend: null, manager: null },
		bundled: { frontend: "v1.52.1", backend: "0.33.1", manager: "4.2.2" },
		recommendedFrontend: "v1.48.7",
		recommendedManager: "4.2.2",
		install: { status: "idle" },
	});
	expect(versions.getBackendTarget()).toEqual(bundledBackend);
});

test("points the Worker at the selected backend release", async () => {
	const { versions, restarts } = await harness();

	await versions.select({ component: "backend", version: "0.34.0" });

	expect(versions.getBackendTarget()).toEqual({
		version: "0.34.0",
		archiveUrl: selectedBackend.archiveUrl,
		sha256: "b".repeat(64),
	});
	expect((await settled(versions)).recommendedFrontend).toBe("v1.50.0");
	expect((await settled(versions)).recommendedManager).toBe("4.3.0");
	expect(restarts).toHaveBeenCalledOnce();
});

test("returns the Worker to the bundled backend when it is reselected", async () => {
	const { versions } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });

	await versions.select({ component: "backend", version: "0.33.1" });

	expect(versions.getState().selection.backend).toBeNull();
	expect(versions.getBackendTarget()).toEqual(bundledBackend);
});

test("leaves the Worker target alone when only the frontend changes", async () => {
	const { versions, restarts } = await harness();

	await versions.select({ component: "frontend", version: "v1.53.0" });

	expect(versions.getState().selection).toEqual({
		frontend: "v1.53.0",
		backend: null,
		manager: null,
	});
	expect(versions.getBackendTarget()).toEqual(bundledBackend);
	expect(restarts).toHaveBeenCalledOnce();
});

test("does not restart when the selection is unchanged", async () => {
	const { versions, restarts, install } = await harness();

	await versions.select({ component: "backend", version: "0.33.1" });

	expect(restarts).not.toHaveBeenCalled();
	expect(install).not.toHaveBeenCalled();
});

test("keeps the previous selection when the download fails", async () => {
	const { versions, restarts } = await harness({ installFails: true });
	const states: ComfyVersionState[] = [];
	versions.subscribe((state) => states.push(state));

	await expect(
		versions.select({ component: "backend", version: "0.34.0" }),
	).rejects.toThrow("Download failed with HTTP 500.");

	expect(versions.getState().selection.backend).toBeNull();
	expect(versions.getBackendTarget()).toEqual(bundledBackend);
	expect(restarts).not.toHaveBeenCalled();
	expect(states.at(-1)?.install).toEqual({ status: "idle" });
});

test("rejects a version that is not a known release", async () => {
	const { versions } = await harness();

	await expect(
		versions.select({ component: "backend", version: "9.9.9" }),
	).rejects.toThrow("is not a known release");
});

test("switches Manager independently and reports it as installed", async () => {
	const { versions, restarts, managerTargetChanges } = await harness();

	await versions.select({ component: "manager", version: "4.3.0" });

	expect(restarts).toHaveBeenCalledOnce();
	expect(versions.getState().selection.manager).toBe("4.3.0");
	expect(versions.getManagerVersion()).toBe("4.3.0");
	expect(managerTargetChanges()).toBe(1);
	expect((await versions.listCatalog()).manager).toEqual([
		{ version: "4.4.0", installed: false },
		{ version: "4.3.0", installed: true },
		{ version: "4.2.2", installed: false },
	]);
});

test("follows the selected backend Manager pin until an override is chosen", async () => {
	const { versions } = await harness();

	await versions.select({ component: "backend", version: "0.34.0" });
	expect(versions.getManagerVersion()).toBe("4.3.0");

	await versions.select({ component: "manager", version: "4.4.0" });
	await versions.select({ component: "backend", version: "0.33.1" });

	expect(versions.getManagerVersion()).toBe("4.4.0");
	expect(versions.getState().recommendedManager).toBe("4.2.2");
});

test("stores an explicit Manager override that equals the current backend pin", async () => {
	const { versions, restarts } = await harness();

	await versions.select({ component: "manager", version: "4.2.2" });

	expect(versions.getState().selection.manager).toBe("4.2.2");
	expect(restarts).toHaveBeenCalledOnce();
	await versions.select({ component: "backend", version: "0.34.0" });
	expect(versions.getManagerVersion()).toBe("4.2.2");
});

test("stores the current backend Manager pin when the Manager catalog is empty", async () => {
	const { versions, restarts } = await harness({ managerVersions: [] });

	await versions.select({ component: "backend", version: "0.34.0" });
	await versions.select({ component: "manager", version: "4.3.0" });

	expect(versions.getState().selection.manager).toBe("4.3.0");
	expect(restarts).toHaveBeenCalledTimes(2);
});

test("keeps an explicit Manager override while the selected backend pin is unavailable", async () => {
	const { versions, forgetInstall } = await harness();

	await versions.select({ component: "backend", version: "0.34.0" });
	forgetInstall("backend", "0.34.0");
	await versions.initialize();

	expect(versions.getState().recommendedManager).toBeNull();
	await versions.select({ component: "manager", version: "4.2.2" });
	expect(versions.getState().selection.manager).toBe("4.2.2");
});

test("resolves a followed Manager pin after installing the selected backend", async () => {
	const { versions, restarts, forgetInstall } = await harness();

	await versions.select({ component: "backend", version: "0.34.0" });
	await versions.select({ component: "manager", version: "4.2.2" });
	forgetInstall("backend", "0.34.0");
	await versions.initialize();
	expect(versions.getState().recommendedManager).toBeNull();
	restarts.mockClear();
	restarts.mockImplementationOnce(async () => {
		expect(versions.getRuntimeManagerVersion()).toBe("4.2.2");
		await versions.resolveBackend();
		expect(versions.getRuntimeManagerVersion()).toBe("4.3.0");
		return null;
	});

	await versions.select({ component: "manager", version: null });

	expect(restarts).toHaveBeenCalledOnce();
	expect(versions.getState().selection.manager).toBeNull();
	expect(versions.getManagerVersion()).toBe("4.3.0");
});

test("restores the previous Manager when the new runtime cannot start", async () => {
	const { versions, restarts, managerTargetChanges } = await harness();
	restarts.mockImplementationOnce(async () => {
		expect(versions.getManagerVersion()).toBe("4.2.2");
		expect(versions.getRuntimeManagerVersion()).toBe("4.3.0");
		throw new Error("Manager dependencies failed.");
	});

	await expect(
		versions.select({ component: "manager", version: "4.3.0" }),
	).rejects.toThrow("Manager dependencies failed.");

	expect(restarts).toHaveBeenCalledTimes(2);
	expect(versions.getState().selection.manager).toBeNull();
	expect(versions.getManagerVersion()).toBe("4.2.2");
	expect(versions.getRuntimeManagerVersion()).toBe("4.2.2");
	expect(managerTargetChanges()).toBe(0);

	await versions.select({ component: "manager", version: "4.4.0" });
	expect(versions.getManagerVersion()).toBe("4.4.0");
});

test("rejects a Manager version missing from the PyPI catalog", async () => {
	const { versions, restarts } = await harness();

	await expect(
		versions.select({ component: "manager", version: "9.9.9" }),
	).rejects.toThrow("is not a known release");
	expect(restarts).not.toHaveBeenCalled();
});

test("installs the selected release before the runtime starts", async () => {
	const { versions, install } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	install.mockClear();

	const resolved = await versions.resolveBackend();

	expect(resolved).toMatchObject({ version: "0.34.0", sha256: "b".repeat(64) });
	expect(install).toHaveBeenCalledWith(
		"backend",
		selectedBackend,
		expect.any(Function),
	);
});

test("resolves to the bundled sources while nothing is selected", async () => {
	const { versions } = await harness();

	await expect(versions.resolveBackend()).resolves.toBeNull();
	await expect(versions.resolveFrontend()).resolves.toBeNull();
});

test("marks the bundled and downloaded releases as installed", async () => {
	const { versions } = await harness();

	expect(await versions.listCatalog()).toEqual({
		backend: [
			{ version: "0.35.0", installed: false },
			{ version: "0.34.0", installed: false },
			{ version: "0.33.1", installed: true },
		],
		frontend: [{ version: "v1.53.0", installed: false }],
		manager: [
			{ version: "4.4.0", installed: false },
			{ version: "4.3.0", installed: false },
			{ version: "4.2.2", installed: true },
		],
		error: null,
	});

	await versions.select({ component: "backend", version: "0.34.0" });

	expect((await versions.listCatalog()).backend).toEqual([
		{ version: "0.35.0", installed: false },
		{ version: "0.34.0", installed: true },
		{ version: "0.33.1", installed: true },
	]);
});

test("removes the replaced release once ComfyUI has restarted on the new one", async () => {
	const { versions, remove } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	await settled(versions);
	expect(remove).not.toHaveBeenCalled();

	await versions.select({ component: "backend", version: "0.33.1" });
	await settled(versions);

	expect(remove).toHaveBeenCalledWith("backend", "0.34.0");
	expect((await versions.listCatalog()).backend).toEqual([
		{ version: "0.35.0", installed: false },
		{ version: "0.34.0", installed: false },
		{ version: "0.33.1", installed: true },
	]);
});

test("keeps the replaced release when ComfyUI cannot restart on the new one", async () => {
	const { versions, remove, restarts } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	await settled(versions);
	restarts.mockRejectedValueOnce(new Error("ComfyUI failed to start."));

	await versions.select({ component: "backend", version: "0.33.1" });
	await settled(versions);

	expect(remove).not.toHaveBeenCalled();
	expect((await versions.listCatalog()).backend).toEqual([
		{ version: "0.35.0", installed: false },
		{ version: "0.34.0", installed: true },
		{ version: "0.33.1", installed: true },
	]);
});

test("has nothing to remove when leaving the bundled release", async () => {
	const { versions, remove } = await harness();

	await versions.select({ component: "frontend", version: "v1.53.0" });
	await settled(versions);

	expect(remove).not.toHaveBeenCalled();
});

test("keeps the release the user switched back to before the cleanup settled", async () => {
	const { versions, remove, restarts } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	// Hold the restart that would retire 0.34.0 until it has been selected again.
	let releaseRestart: (() => void) | undefined;
	restarts.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				releaseRestart = () => resolve(null);
			}),
	);
	await versions.select({ component: "backend", version: "0.33.1" });
	await versions.select({ component: "backend", version: "0.34.0" });

	releaseRestart?.();
	await settled(versions);

	expect(remove).not.toHaveBeenCalled();
	expect(versions.getState().selection.backend).toBe("0.34.0");
});

test("starts an installed release when the release listing is gone", async () => {
	const { versions, install, forgetCatalog } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	await versions.select({ component: "frontend", version: "v1.53.0" });
	install.mockClear();
	forgetCatalog();

	await expect(versions.resolveBackend()).resolves.toMatchObject({
		version: "0.34.0",
	});
	await expect(versions.resolveFrontend()).resolves.toContain("v1.53.0");
});

test("reports the selected backend directory without installing it", async () => {
	const { versions, install } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	install.mockClear();

	await expect(versions.selectedBackendDirectory()).resolves.toContain("0.34.0");
	expect(install).not.toHaveBeenCalled();
});

test("re-projects the Worker target once a missing release is reinstalled", async () => {
	const { versions, targetChanges } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	const changesAfterSelect = targetChanges();

	await versions.resolveBackend();

	expect(targetChanges()).toBe(changesAfterSelect);
	expect(versions.getBackendTarget()).toMatchObject({ version: "0.34.0" });
});

test("keeps the release a newer switch is already installing", async () => {
	const { versions, remove, restarts, holdInstall } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	let releaseRestart = () => {};
	restarts.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				releaseRestart = () => resolve(null);
			}),
	);
	await versions.select({ component: "backend", version: "0.35.0" });

	// The user switches back while the first restart has not settled yet.
	const releaseInstall = holdInstall("backend", "0.34.0");
	const back = versions.select({ component: "backend", version: "0.34.0" });
	releaseRestart();
	await settled(versions);
	releaseInstall();
	await back;

	expect(remove).not.toHaveBeenCalledWith("backend", "0.34.0");
});

test("reports no selected backend directory when the release is gone from disk", async () => {
	const { versions, forgetInstall } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	forgetInstall("backend", "0.34.0");

	await expect(versions.selectedBackendDirectory()).resolves.toBeNull();
});

test("reports install progress while the runtime resolves a selection", async () => {
	const { versions, forgetInstall } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	forgetInstall("backend", "0.34.0");
	const states: ComfyVersionState[] = [];
	versions.subscribe((state) => states.push(state));

	await versions.resolveBackend();

	expect(
		states.some(
			(state) => state.install.status === "installing" && state.install.progress === 50,
		),
	).toBe(true);
	expect(versions.getState().install).toEqual({ status: "idle" });
});

test("leaves the newest selection in place when an older switch finishes late", async () => {
	const { versions, restarts, holdInstall } = await harness();
	const releaseSlowInstall = holdInstall("backend", "0.34.0");
	const slow = versions.select({ component: "backend", version: "0.34.0" });
	await settled(versions);

	await versions.select({ component: "backend", version: "0.35.0" });
	releaseSlowInstall();
	await slow;
	await settled(versions);

	expect(versions.getState().selection.backend).toBe("0.35.0");
	expect(restarts).toHaveBeenCalledTimes(1);
});

test("removes the replaced backend even when the frontend switches next", async () => {
	const { versions, remove, restarts } = await harness();
	await versions.select({ component: "backend", version: "0.34.0" });
	let releaseRestart = () => {};
	restarts.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				releaseRestart = () => resolve(null);
			}),
	);
	await versions.select({ component: "backend", version: "0.35.0" });

	// The frontend switch must not look like a newer switch to the backend cleanup.
	await versions.select({ component: "frontend", version: "v1.53.0" });
	releaseRestart();
	await settled(versions);

	expect(remove).toHaveBeenCalledWith("backend", "0.34.0");
});
