import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ComfyReleaseCatalog } from "./comfy-release-catalog";

const temporaryDirectories: string[] = [];
const bundled = {
	backend: {
		version: "0.33.1",
		archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.33.1.zip",
	},
	frontend: {
		version: "v1.52.1",
		archiveUrl:
			"https://github.com/Comfy-Org/ComfyUI_frontend/releases/download/v1.52.1/dist.zip",
	},
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function catalogPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kastard-comfy-catalog-test-"));
	temporaryDirectories.push(root);
	return join(root, "comfy-release-catalog.json");
}

function release(tag: string, assets: string[] = ["dist.zip"]) {
	return {
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: assets.map((name) => ({
			name,
			browser_download_url: `https://github.com/Comfy-Org/ComfyUI_frontend/releases/download/${tag}/${name}`,
		})),
	};
}

function respondWith(
	backend: unknown[],
	frontend: unknown[],
	manager: string[] = ["4.3.0", "4.2.2"],
): { fetch: typeof fetch; calls: () => number } {
	let calls = 0;
	const requestFetch = vi.fn(async (url: unknown) => {
		calls += 1;
		const stringUrl = String(url);
		const payload = stringUrl.includes("pypi.org")
			? {
					releases: Object.fromEntries(
						manager.map((version) => [version, [{ yanked: false }]]),
					),
				}
			: stringUrl.includes("ComfyUI_frontend")
				? frontend
				: backend;
		return new Response(JSON.stringify(payload), { status: 200 });
	});
	return { fetch: requestFetch as unknown as typeof fetch, calls: () => calls };
}

test("lists installable releases for both components", async () => {
	const responses = respondWith(
		[release("v0.34.0"), release("v0.33.1")],
		[release("v1.53.0"), release("v1.52.1")],
	);
	const catalog = new ComfyReleaseCatalog({
		path: await catalogPath(),
		getBundled: () => bundled,
		fetch: responses.fetch,
	});
	await catalog.initialize();

	expect(await catalog.list()).toEqual({
		backend: [
			{
				version: "0.34.0",
				archiveUrl:
					"https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.34.0.zip",
			},
			bundled.backend,
		],
		frontend: [
			{
				version: "v1.53.0",
				archiveUrl:
					"https://github.com/Comfy-Org/ComfyUI_frontend/releases/download/v1.53.0/dist.zip",
			},
			bundled.frontend,
		],
		manager: ["4.3.0", "4.2.2"],
		error: null,
	});
});

test("builds the archive URL the Worker accepts", async () => {
	const responses = respondWith([release("v0.34.0")], []);
	const catalog = new ComfyReleaseCatalog({
		path: await catalogPath(),
		getBundled: () => bundled,
		fetch: responses.fetch,
	});
	await catalog.initialize();
	await catalog.list();

	expect(catalog.find("backend", "0.34.0")).toEqual({
		version: "0.34.0",
		archiveUrl: "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.34.0.zip",
	});
});

test("skips releases Kastard cannot install", async () => {
	const responses = respondWith(
		[
			release("v0.34.0"),
			release("v0.34.0-rc1"),
			{ ...release("v0.35.0"), prerelease: true },
			{ ...release("v0.36.0"), draft: true },
		],
		[release("v1.53.0", ["source.zip"])],
	);
	const catalog = new ComfyReleaseCatalog({
		path: await catalogPath(),
		getBundled: () => bundled,
		fetch: responses.fetch,
	});
	await catalog.initialize();

	const listed = await catalog.list();

	expect(listed.backend.map((release) => release.version)).toEqual([
		"0.34.0",
		"0.33.1",
	]);
	expect(listed.frontend).toEqual([bundled.frontend]);
});

test("reuses the cached listing until it goes stale", async () => {
	const responses = respondWith([release("v0.34.0")], [release("v1.53.0")]);
	let now = 0;
	const catalog = new ComfyReleaseCatalog({
		path: await catalogPath(),
		getBundled: () => bundled,
		fetch: responses.fetch,
		now: () => now,
		ttlMs: 1_000,
	});
	await catalog.initialize();

	await catalog.list();
	now = 500;
	await catalog.list();
	expect(responses.calls()).toBe(3);

	now = 1_500;
	await catalog.list();
	expect(responses.calls()).toBe(6);
});

test("keeps offering the bundled versions when GitHub is unreachable", async () => {
	const catalog = new ComfyReleaseCatalog({
		path: await catalogPath(),
		getBundled: () => bundled,
		fetch: (async () => {
			throw new Error("Network is unreachable.");
		}) as unknown as typeof fetch,
	});
	await catalog.initialize();

	expect(await catalog.list()).toEqual({
		backend: [bundled.backend],
		frontend: [bundled.frontend],
		manager: [],
		error: "Network is unreachable.",
	});
	expect(catalog.find("backend", "0.33.1")).toEqual(bundled.backend);
});

test("keeps refreshed ComfyUI releases when PyPI is unavailable", async () => {
	const requestFetch = vi.fn(async (url: unknown) => {
		if (String(url).includes("pypi.org")) {
			throw new Error("PyPI is unreachable.");
		}
		return new Response(JSON.stringify([release("v0.34.0")]), { status: 200 });
	});
	const catalog = new ComfyReleaseCatalog({
		path: await catalogPath(),
		getBundled: () => bundled,
		fetch: requestFetch as unknown as typeof fetch,
	});
	await catalog.initialize();

	const listing = await catalog.list();
	const retried = await catalog.list();

	expect(listing.backend.map(({ version }) => version)).toEqual(["0.34.0", "0.33.1"]);
	expect(listing.manager).toEqual([]);
	expect(listing.error).toBe("PyPI is unreachable.");
	expect(retried.error).toBe("PyPI is unreachable.");
	expect(requestFetch).toHaveBeenCalledTimes(6);
});

test("returns a refreshed listing when persisting the cache fails", async () => {
	const path = await catalogPath();
	await mkdir(path);
	const responses = respondWith([release("v0.34.0")], [release("v1.53.0")]);
	const catalog = new ComfyReleaseCatalog({
		path,
		getBundled: () => bundled,
		fetch: responses.fetch,
	});
	await catalog.initialize();

	const listing = await catalog.list();

	expect(listing.backend.map(({ version }) => version)).toEqual(["0.34.0", "0.33.1"]);
	expect(listing.manager).toEqual(["4.3.0", "4.2.2"]);
	expect(listing.error).toMatch(/directory|rename|EISDIR|ENOTDIR/i);
	await catalog.list();
	expect(responses.calls()).toBe(6);
});

test("serves a previously cached listing after a restart", async () => {
	const path = await catalogPath();
	const responses = respondWith([release("v0.34.0")], [release("v1.53.0")]);
	const first = new ComfyReleaseCatalog({
		path,
		getBundled: () => bundled,
		fetch: responses.fetch,
		now: () => 0,
	});
	await first.initialize();
	await first.list();

	const restored = new ComfyReleaseCatalog({
		path,
		getBundled: () => bundled,
		fetch: (async () => {
			throw new Error("Network is unreachable.");
		}) as unknown as typeof fetch,
		now: () => 0,
	});
	await restored.initialize();

	expect((await restored.list()).backend.map((release) => release.version)).toEqual([
		"0.34.0",
		"0.33.1",
	]);
});

test("lists stable Manager packages from PyPI newest first", async () => {
	const responses = respondWith([], [], ["4.2.2", "4.10.0", "4.3.0b1", "invalid"]);
	const catalog = new ComfyReleaseCatalog({
		path: await catalogPath(),
		getBundled: () => bundled,
		fetch: responses.fetch,
	});
	await catalog.initialize();

	expect((await catalog.list()).manager).toEqual(["4.10.0", "4.2.2"]);
	expect(catalog.hasManager("4.10.0")).toBe(true);
	expect(catalog.hasManager("4.3.0b1")).toBe(false);
});

test("skips Manager releases without an available PyPI file", async () => {
	const responses = respondWith([], []);
	const requestFetch = vi.fn(async (url: unknown) => {
		if (!String(url).includes("pypi.org")) return responses.fetch(url as never);
		return new Response(
			JSON.stringify({
				releases: {
					"4.4.0": [],
					"4.3.0": [{ yanked: true }],
					"4.2.2": [{ yanked: false }],
				},
			}),
			{ status: 200 },
		);
	});
	const catalog = new ComfyReleaseCatalog({
		path: await catalogPath(),
		getBundled: () => bundled,
		fetch: requestFetch as unknown as typeof fetch,
	});
	await catalog.initialize();

	expect((await catalog.list()).manager).toEqual(["4.2.2"]);
});

test("discards the previous cache schema without rewriting it", async () => {
	const path = await catalogPath();
	const contents = JSON.stringify({
		version: 1,
		fetchedAt: 0,
		frontend: [],
		backend: [],
	});
	await writeFile(path, contents);
	const catalog = new ComfyReleaseCatalog({
		path,
		getBundled: () => bundled,
		fetch: (async () => {
			throw new Error("Network is unreachable.");
		}) as unknown as typeof fetch,
	});
	await catalog.initialize();

	expect(await catalog.list()).toMatchObject({
		backend: [bundled.backend],
		frontend: [bundled.frontend],
		manager: [],
	});
	expect(await readFile(path, "utf8")).toBe(contents);
});

test("discards a cached listing that could escape its install directory", async () => {
	const path = await catalogPath();
	await writeFile(
		path,
		JSON.stringify({
			version: 2,
			fetchedAt: 0,
			frontend: [],
			backend: [{ version: "../../escaped", archiveUrl: "https://github.com/x.zip" }],
			manager: [],
		}),
	);
	const catalog = new ComfyReleaseCatalog({
		path,
		getBundled: () => bundled,
		fetch: (async () => {
			throw new Error("Network is unreachable.");
		}) as unknown as typeof fetch,
	});
	await catalog.initialize();

	expect(catalog.find("backend", "../../escaped")).toBeNull();
	expect((await catalog.list()).backend).toEqual([bundled.backend]);
});
