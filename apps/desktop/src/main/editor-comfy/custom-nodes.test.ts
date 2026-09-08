// @vitest-environment node

import { type ChildProcess, execFileSync } from "node:child_process";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { EditorCustomNodes } from "./custom-nodes";
import { ComfyRuntime } from "./runtime";
import { createManagedPython, FakeProcess, fixture } from "./test-fixture";

function createNodes(
	options: ConstructorParameters<typeof ComfyRuntime>[0] &
		Partial<ConstructorParameters<typeof EditorCustomNodes>[0]>,
) {
	const runtime = new ComfyRuntime(options);
	const nodes = new EditorCustomNodes({
		...options,
		getRuntimeState: () => runtime.getState(),
	});
	return { runtime, nodes };
}
async function createGitHubNode(
	directory: string,
	repository = "git@github.com:Owner/local-git-node.git",
): Promise<string> {
	await mkdir(directory, { recursive: true });
	git(directory, "init", "--quiet");
	await writeFile(join(directory, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
	git(directory, "add", "__init__.py");
	commitGit(directory, "initial");
	git(directory, "remote", "add", "origin", repository);
	git(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
	return git(directory, "rev-parse", "HEAD").trim().toLowerCase();
}

async function createCnrNode(
	directory: string,
	name: string,
	version: string,
	repository?: string,
): Promise<void> {
	await mkdir(directory, { recursive: true });
	await Promise.all([
		writeFile(join(directory, ".tracking"), "__init__.py\n"),
		writeFile(
			join(directory, "pyproject.toml"),
			`[project]\nname = "${name}"\nversion = "${version}"\n${
				repository === undefined
					? ""
					: `\n[project.urls]\nRepository = "${repository}"\n`
			}`,
		),
	]);
}

async function addSubmodule(directory: string, source: string): Promise<string> {
	await createGitHubNode(directory);
	await mkdir(source, { recursive: true });
	git(source, "init", "--quiet");
	await writeFile(join(source, "dependency.py"), "clean dependency\n");
	git(source, "add", "dependency.py");
	commitGit(source, "initial dependency");
	git(
		directory,
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		source,
		"dependency",
	);
	git(directory, "add", ".gitmodules", "dependency");
	commitGit(directory, "add dependency");
	git(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
	return git(directory, "rev-parse", "HEAD").trim().toLowerCase();
}

function commitGit(directory: string, message: string): void {
	git(
		directory,
		"-c",
		"user.name=Kastard Test",
		"-c",
		"user.email=kastard@example.com",
		"commit",
		"--quiet",
		"-m",
		message,
	);
}

function git(directory: string, ...args: string[]): string {
	return execFileSync("git", ["--no-optional-locks", "-C", directory, ...args], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}

test("lists installed custom nodes and verifies GitHub repositories concurrently", async () => {
	const paths = await fixture();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	await Promise.all([
		createCnrNode(
			join(customNodes, "comfyui-kjnodes"),
			"comfyui-kjnodes",
			"1.5.0",
			"https://github.com/kijai/ComfyUI-KJNodes",
		),
		createCnrNode(
			join(customNodes, "ComfyUI-DaSiWa-Nodes"),
			"different-package",
			"0.4.12",
			"https://github.com/wrong/package",
		),
	]);
	const gitCommit = await createGitHubNode(join(customNodes, "local-git-node"));
	const secondGitNode = join(customNodes, "second-git-node");
	const secondGitCommit = await createGitHubNode(secondGitNode);
	git(
		secondGitNode,
		"remote",
		"set-url",
		"origin",
		"https://github.com/owner/second-git-node.git",
	);
	const child = new FakeProcess();
	let listRequest = 0;
	const request = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname !== "/v2/customnode/installed") {
			return new Response(null, { status: 404 });
		}
		listRequest += 1;
		if (listRequest === 2) {
			return Response.json({
				"../other-repo": { ver: "unknown", cnr_id: null },
			});
		}
		if (listRequest === 3) {
			return Response.json([{ name: "invalid" }]);
		}
		if (listRequest === 4) {
			return new Response(null, { status: 503 });
		}
		return Response.json({
			"local-git-node": {
				ver: "unknown",
				cnr_id: null,
				aux_id: "owner/local-git-node",
			},
			"second-git-node": {
				ver: "unknown",
				cnr_id: null,
				aux_id: "owner/second-git-node",
			},
			"comfyui-kjnodes": {
				ver: "1.5.0",
				cnr_id: "comfyui-kjnodes",
				aux_id: null,
			},
			"ComfyUI-DaSiWa-Nodes": {
				ver: "0.4.12",
				cnr_id: "ComfyUI-DaSiWa-Nodes",
				aux_id: null,
			},
		});
	});
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});

	await runtime.start();
	await expect(nodes.listCustomNodes()).resolves.toEqual([
		{
			name: "ComfyUI-DaSiWa-Nodes",
			version: "0.4.12",
			managerId: "ComfyUI-DaSiWa-Nodes",
		},
		{
			name: "comfyui-kjnodes",
			version: "1.5.0",
			managerId: "comfyui-kjnodes",
			repository: "https://github.com/kijai/ComfyUI-KJNodes",
		},
		{
			name: "local-git-node",
			version: gitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "second-git-node",
			version: secondGitCommit,
			managerId: null,
			repository: "https://github.com/owner/second-git-node.git",
		},
	]);
	expect(
		request.mock.calls.some(
			([input]) =>
				String(input) === "http://127.0.0.1:18188/v2/customnode/installed?mode=default",
		),
	).toBe(true);
	await expect(nodes.listCustomNodes()).rejects.toThrow(
		"ComfyUI Manager returned an invalid custom-nodes list.",
	);
	await expect(nodes.listCustomNodes()).rejects.toThrow(
		"ComfyUI Manager returned an invalid custom-nodes list.",
	);
	await expect(nodes.listCustomNodes()).rejects.toThrow(
		"ComfyUI Manager returned HTTP 503.",
	);
	await runtime.stop();
});

test("lists local custom nodes without starting ComfyUI", async () => {
	const paths = await fixture();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const cnrNode = join(customNodes, "comfyui-kjnodes");
	const gitNode = join(customNodes, "local-git-node");
	const dirtyGitNode = join(customNodes, "dirty-git-node");
	const submoduleGitNode = join(customNodes, "submodule-git-node");
	const suffixedDisabledGitNode = join(customNodes, "suffixed-git-node.disabled");
	const ignoredGitNode = join(customNodes, "ignored-git-node");
	const localOnlyGitNode = join(customNodes, "local-only-git-node");
	const manualNode = join(customNodes, "manual-node");
	const disabledNodes = join(customNodes, ".disabled");
	await Promise.all([
		mkdir(cnrNode, { recursive: true }),
		mkdir(manualNode, { recursive: true }),
		mkdir(disabledNodes, { recursive: true }),
	]);
	const gitCommit = await createGitHubNode(gitNode);
	const dirtyGitCommit = await createGitHubNode(dirtyGitNode);
	await createGitHubNode(ignoredGitNode);
	await writeFile(join(ignoredGitNode, ".gitignore"), "local-config.py\n");
	git(ignoredGitNode, "add", ".gitignore");
	commitGit(ignoredGitNode, "ignore local config");
	git(ignoredGitNode, "update-ref", "refs/remotes/origin/main", "HEAD");
	await writeFile(join(ignoredGitNode, "local-config.py"), "LOCAL_SETTING = True\n");
	const ignoredGitCommit = git(ignoredGitNode, "rev-parse", "HEAD")
		.trim()
		.toLowerCase();
	await createGitHubNode(localOnlyGitNode);
	await writeFile(join(localOnlyGitNode, "__init__.py"), "LOCAL_ONLY = True\n");
	git(localOnlyGitNode, "add", "__init__.py");
	commitGit(localOnlyGitNode, "local only");
	const localOnlyCommit = git(localOnlyGitNode, "rev-parse", "HEAD")
		.trim()
		.toLowerCase();
	const submoduleSource = join(paths.dataDirectory, "submodule-source");
	const submoduleGitCommit = await addSubmodule(submoduleGitNode, submoduleSource);
	const suffixedDisabledGitCommit = await createGitHubNode(suffixedDisabledGitNode);
	await writeFile(join(submoduleSource, "dependency.py"), "next dependency\n");
	git(submoduleSource, "add", "dependency.py");
	commitGit(submoduleSource, "update dependency");
	const divergentSubmoduleCommit = git(submoduleSource, "rev-parse", "HEAD").trim();
	git(
		join(submoduleGitNode, "dependency"),
		"fetch",
		"origin",
		divergentSubmoduleCommit,
	);
	git(
		join(submoduleGitNode, "dependency"),
		"checkout",
		"--quiet",
		"--detach",
		divergentSubmoduleCommit,
	);
	await writeFile(
		join(submoduleGitNode, "dependency", "dependency.py"),
		"local dependency change\n",
	);
	await writeFile(join(dirtyGitNode, "untracked.txt"), "local change\n");
	await Promise.all([
		writeFile(join(cnrNode, ".tracking"), "__init__.py\n"),
		writeFile(
			join(cnrNode, "pyproject.toml"),
			'[build-system]\nrequires = []\n\n[project]\nname = "comfyui-kjnodes"\nversion = "1.5.0"\n\n[project.urls]\nRepository = "https://github.com/kijai/ComfyUI-KJNodes"\n',
		),
		writeFile(join(customNodes, "manual.py"), "NODE_CLASS_MAPPINGS = {}\n"),
		writeFile(join(disabledNodes, "z-disabled.py"), "NODE_CLASS_MAPPINGS = {}\n"),
	]);
	const startProcess = vi.fn();
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		startProcess,
	});

	await expect(nodes.listCustomNodes()).resolves.toEqual([
		{
			name: "comfyui-kjnodes",
			version: "1.5.0",
			managerId: "comfyui-kjnodes",
			repository: "https://github.com/kijai/ComfyUI-KJNodes",
		},
		{
			name: "dirty-git-node",
			version: dirtyGitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
			workerSyncIssue:
				"Tracked or untracked local changes are not included in the Git commit.",
		},
		{
			name: "ignored-git-node",
			version: ignoredGitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "local-git-node",
			version: gitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "local-only-git-node",
			version: localOnlyCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "manual-node",
			version: "unknown",
			managerId: null,
			workerSyncIssue: "No Registry package or supported GitHub repository was found.",
		},
		{
			name: "manual.py",
			version: "unknown",
			managerId: null,
			workerSyncIssue: "No Registry package or supported GitHub repository was found.",
		},
		{
			name: "submodule-git-node",
			version: submoduleGitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "suffixed-git-node",
			version: suffixedDisabledGitCommit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
		{
			name: "z-disabled.py",
			version: "unknown",
			managerId: null,
			workerSyncIssue: "No Registry package or supported GitHub repository was found.",
		},
	]);
	await expect(nodes.getManagerVersion()).resolves.toBe("4.2.2");
	expect(startProcess).not.toHaveBeenCalled();
	expect(runtime.getState()).toEqual({ status: "idle" });
});

test("installs a GitHub custom node with the active ComfyUI Manager", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const repository = "https://github.com/owner/local-git-node.git";
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	let installed = false;
	let releaseInstall: (() => void) | undefined;
	const installGate = new Promise<void>((resolve) => {
		releaseInstall = resolve;
	});
	let installStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		installStarted = resolve;
	});
	let installInvocation:
		| { command: string; args: string[]; env: NodeJS.ProcessEnv }
		| undefined;
	vi.stubEnv("KASTARD_PRIVATE_TOKEN", "not-for-custom-nodes");
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") {
			return Response.json(
				installed ? { "local-git-node": { ver: "unknown", cnr_id: null } } : {},
			);
		}
		return new Response(null, { status: 404 });
	});
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_202,
		fetch: request as typeof fetch,
		runCommand: async (command, args, options) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			installInvocation = { command, args, env: options.env };
			installStarted?.();
			await installGate;
			await createGitHubNode(join(customNodes, "local-git-node"));
			installed = true;
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	const installation = nodes.installCustomNode(repository);
	await started;
	releaseInstall?.();

	const result = await installation;
	expect(result).toMatchObject({
		node: {
			name: "local-git-node",
			managerId: null,
			repository,
		},
		nodes: [
			{
				name: "local-git-node",
				managerId: null,
				repository,
			},
		],
		restartRequired: true,
	});
	expect(installInvocation).toEqual({
		command: join(paths.dataDirectory, "environment", "bin", "python"),
		args: [
			"-m",
			"cm_cli",
			"install",
			repository,
			"--mode",
			"cache",
			"--user-directory",
			join(paths.dataDirectory, "data", "user", "__manager"),
			"--exit-on-fail",
		],
		env: expect.objectContaining({
			COMFYUI_PATH: join(paths.resourcesDirectory, "backend"),
			COMFYUI_FOLDERS_BASE_PATH: join(paths.dataDirectory, "data"),
			GIT_TERMINAL_PROMPT: "0",
			PIP_NO_INPUT: "1",
		}),
	});
	expect(installInvocation?.env.KASTARD_PRIVATE_TOKEN).toBeUndefined();
	expect(
		await readFile(
			join(paths.dataDirectory, "data", "user", "__manager", "extra_model_paths.yaml"),
			"utf8",
		),
	).toContain(`base_path: ${JSON.stringify(join(paths.dataDirectory, "data"))}`);
	await expect(nodes.installCustomNode(repository)).rejects.toThrow(
		"local-git-node already uses this GitHub repository.",
	);
	await runtime.stop();
});

test("resolves registered versions by exact GitHub repository", async () => {
	const paths = await fixture();
	const repository = "https://github.com/owner/registered-node.git";
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === "/nodes/search") {
			return Response.json({
				nodes: [
					{
						id: "different-node",
						repository: "https://github.com/another/registered-node",
						latest_version: { version: "9.9.9" },
					},
					{
						id: "registered-node",
						repository: "https://github.com/Owner/Registered-Node",
						latest_version: { version: "1.2.3" },
					},
				],
			});
		}
		if (url.pathname === "/nodes/registered-node/versions") {
			return Response.json([
				{ version: "1.2.3", status: "active" },
				{ version: "1.2.2", status: "pending" },
				{ version: "1.2.2", status: "pending" },
				{ version: "1.0.0", status: "banned" },
			]);
		}
		return new Response(null, { status: 404 });
	});
	const { nodes } = createNodes({
		...paths,
		registryApiUrl: "https://registry.example.com",
		fetch: request as typeof fetch,
	});

	await expect(nodes.resolveCustomNodeInstallOptions(repository)).resolves.toEqual({
		managerId: "registered-node",
		latestVersion: "1.2.3",
		versions: ["1.2.3", "1.2.2"],
	});
	const searchUrl = new URL(String(request.mock.calls[0]?.[0]));
	expect(searchUrl.searchParams.get("repository_url_search")).toBe(repository);
	const versionsUrl = new URL(String(request.mock.calls[1]?.[0]));
	expect(versionsUrl.searchParams.getAll("statuses")).toEqual([
		"NodeVersionStatusActive",
		"NodeVersionStatusPending",
	]);
});

test("does not treat a fuzzy Registry search result as a registered repository", async () => {
	const paths = await fixture();
	const request = vi.fn(
		async (): Promise<Response> =>
			Response.json({
				nodes: [
					{
						id: "similar-node",
						repository: "https://github.com/another/similar-node",
						latest_version: { version: "1.0.0" },
					},
				],
			}),
	);
	const { nodes } = createNodes({
		...paths,
		registryApiUrl: "https://registry.example.com",
		fetch: request as typeof fetch,
	});

	await expect(
		nodes.resolveCustomNodeInstallOptions("https://github.com/owner/similar-node.git"),
	).resolves.toBeNull();
	expect(request).toHaveBeenCalledTimes(1);
});

test.each([
	{ selectedVersion: "1.2.2", packageSpec: "registered-node@1.2.2" },
	{ selectedVersion: "nightly", packageSpec: "registered-node@nightly" },
])(
	"revalidates and installs a registered custom node as $packageSpec",
	async ({ selectedVersion, packageSpec }) => {
		const paths = await fixture();
		const child = new FakeProcess();
		const repository = "https://github.com/owner/registered-node.git";
		const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
		let installed = false;
		let installedCommit = "";
		let invokedPackageSpec: string | undefined;
		const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				return Response.json(
					installed
						? {
								"registered-node": {
									ver:
										selectedVersion === "nightly" ? installedCommit : selectedVersion,
									cnr_id: "registered-node",
								},
							}
						: {},
				);
			}
			if (url.pathname === "/nodes/search") {
				return Response.json({
					nodes: [
						{
							id: "registered-node",
							repository,
							latest_version: { version: "1.2.3" },
						},
					],
				});
			}
			if (url.pathname === "/nodes/registered-node/versions") {
				return Response.json([{ version: "1.2.3" }, { version: "1.2.2" }]);
			}
			return new Response(null, { status: 404 });
		});
		const { runtime, nodes } = createNodes({
			...paths,
			platform: "darwin",
			arch: "arm64",
			allocatePort: async () => 18_204,
			registryApiUrl: "https://registry.example.com",
			fetch: request as typeof fetch,
			runCommand: async (_command, args) => {
				await createManagedPython(args);
				if (args[0] !== "-m" || args[1] !== "cm_cli") return;
				invokedPackageSpec = args[3];
				if (selectedVersion === "nightly") {
					installedCommit = await createGitHubNode(
						join(customNodes, "registered-node"),
						repository,
					);
				} else {
					await createCnrNode(
						join(customNodes, "registered-node"),
						"registered-node",
						selectedVersion,
						repository,
					);
				}
				installed = true;
			},
			startProcess: () => child as unknown as ChildProcess,
			retryMs: 1,
		});
		await runtime.start();

		const result = await nodes.installCustomNode(repository, selectedVersion);

		expect(invokedPackageSpec).toBe(packageSpec);
		expect(result.node).toMatchObject({
			name: "registered-node",
			version: selectedVersion === "nightly" ? installedCommit : selectedVersion,
			repository,
		});
		if (selectedVersion === "nightly") expect(result.node.managerId).toBeNull();
		await runtime.stop();
	},
);

test("retains an early dependency failure without trashing the installed custom node", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const repository = "https://github.com/owner/registered-node.git";
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const installedNode = join(customNodes, "registered-node");
	const trashItem = vi.fn(async () => undefined);
	let installed = false;
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") {
			return Response.json(
				installed
					? { "registered-node": { ver: "1.2.3", cnr_id: "registered-node" } }
					: {},
			);
		}
		return new Response(null, { status: 404 });
	});
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_203,
		fetch: request as typeof fetch,
		runCommand: async (_command, args, options) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			await createCnrNode(installedNode, "registered-node", "1.2.3", repository);
			installed = true;
			options.onOutput(
				"[ComfyUI-Manager] Installation failed:\nFailed to execute install script: registered-node@1.2.3\nERROR: An error occurred while installing registered-node\n",
			);
			options.onOutput("x".repeat(20_000));
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(nodes.installCustomNode(repository)).rejects.toThrow(
		"ComfyUI Manager reported installation errors. ERROR: An error occurred while installing registered-node",
	);
	expect(trashItem).not.toHaveBeenCalled();
	await expect(access(installedNode)).resolves.toBeUndefined();
	await runtime.stop();
});

test("moves only the matching incomplete Manager installation to Trash", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const repository = "https://github.com/owner/incomplete-node.git";
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const incompleteNode = join(customNodes, "incomplete-node");
	const unrelatedNode = join(customNodes, "unrelated-node");
	const trashItem = vi.fn(async () => undefined);
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") return Response.json({});
		return new Response(null, { status: 404 });
	});
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_203,
		fetch: request as typeof fetch,
		runCommand: async (_command, args, options) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			await Promise.all([
				createCnrNode(incompleteNode, "incomplete-node", "1.0.0", repository),
				mkdir(unrelatedNode, { recursive: true }),
			]);
			options.onOutput("[ FAIL ] requirements installation failed\n");
			throw new Error("python exited with code 1. Full dependency traceback.");
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(nodes.installCustomNode(repository)).rejects.toThrow(
		"ComfyUI Manager reported installation errors. [ FAIL ] requirements installation failed",
	);
	expect(trashItem).toHaveBeenCalledWith(incompleteNode);
	expect(trashItem).not.toHaveBeenCalledWith(unrelatedNode);
	await runtime.stop();
});

test("rejects an unrelated directory reported after a failed installation", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const unrelatedNode = join(customNodes, "unrelated-node");
	const trashItem = vi.fn(async () => undefined);
	let installed = false;
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") {
			return Response.json(
				installed ? { "unrelated-node": { ver: "unknown", cnr_id: null } } : {},
			);
		}
		return new Response(null, { status: 404 });
	});
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_203,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			await mkdir(unrelatedNode, { recursive: true });
			installed = true;
			throw new Error("python exited with code 1");
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(
		nodes.installCustomNode("https://github.com/owner/requested-node.git"),
	).rejects.toThrow("ComfyUI Manager could not install the custom node.");
	expect(trashItem).not.toHaveBeenCalled();
	await expect(access(unrelatedNode)).resolves.toBeUndefined();
	await runtime.stop();
});

test("cancels an active custom-node installation when cancellation is requested", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	let installStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		installStarted = resolve;
	});
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") return Response.json({});
		return new Response(null, { status: 404 });
	});
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		fetch: request as typeof fetch,
		runCommand: async (_command, args, options) => {
			await createManagedPython(args);
			if (args[0] !== "-m" || args[1] !== "cm_cli") return;
			installStarted?.();
			await new Promise<void>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
			});
		},
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	const installation = nodes.installCustomNode(
		"https://github.com/owner/canceled-node.git",
	);
	await started;
	await nodes.cancelInstallation();
	await runtime.stop();
	await expect(installation).rejects.toThrow("Custom-node installation was canceled.");
	expect(child.signalCode).toBe("SIGTERM");
});

test("times out an unresponsive Manager inventory during installation", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
			}
			return new Response(null, { status: 404 });
		},
	);
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		customNodeInventoryTimeoutMs: 5,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	await expect(
		nodes.installCustomNode("https://github.com/owner/timeout-node.git"),
	).rejects.toThrow(
		"ComfyUI Manager did not return the custom-node inventory in time.",
	);
	await runtime.stop();
});

test("maps a stalled Manager inventory body to the timeout error", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				return {
					ok: true,
					json: () =>
						new Promise((_resolve, reject) => {
							init?.signal?.addEventListener(
								"abort",
								() => reject(new Error("aborted")),
								{ once: true },
							);
						}),
				} as Response;
			}
			return new Response(null, { status: 404 });
		},
	);
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		customNodeInventoryTimeoutMs: 5,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	await expect(
		nodes.installCustomNode("https://github.com/owner/stalled-body-node.git"),
	).rejects.toThrow(
		"ComfyUI Manager did not return the custom-node inventory in time.",
	);
	await runtime.stop();
});

test("cancels an unresponsive Manager inventory when cancellation is requested", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	let inventoryStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		inventoryStarted = resolve;
	});
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				inventoryStarted?.();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
			}
			return new Response(null, { status: 404 });
		},
	);
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	const installation = nodes.installCustomNode(
		"https://github.com/owner/canceled-node.git",
	);
	await started;
	await nodes.cancelInstallation();
	await runtime.stop();
	await expect(installation).rejects.toThrow("Custom-node installation was canceled.");
});

test("cancels a Registry version lookup when cancellation is requested", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	let lookupStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		lookupStarted = resolve;
	});
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") return Response.json({});
			if (url.pathname === "/nodes/search") {
				lookupStarted?.();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
			}
			return new Response(null, { status: 404 });
		},
	);
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_204,
		registryApiUrl: "https://registry.example.com",
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
	});
	await runtime.start();

	const installation = nodes.installCustomNode(
		"https://github.com/owner/canceled-node.git",
		"1.0.0",
	);
	await started;
	await nodes.cancelInstallation();
	await runtime.stop();
	await expect(installation).rejects.toThrow("Custom-node installation was canceled.");
});

test("uninstalls Manager-owned custom nodes without restarting ComfyUI", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const trashItem = vi.fn(async () => undefined);
	let queuedTask: Record<string, unknown> | null = null;
	let uninstallComplete = false;
	const request = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.pathname === "/system_stats" ||
				url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
			) {
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/v2/customnode/installed") {
				return Response.json({
					"ComfyUI-Manager": { ver: "4.2.2", cnr_id: null },
					"comfyui-kjnodes": { ver: "1.5.0", cnr_id: "comfyui-kjnodes" },
				});
			}
			if (url.pathname === "/v2/manager/queue/task") {
				queuedTask = JSON.parse(String(init?.body));
				return Response.json({});
			}
			if (url.pathname === "/v2/manager/queue/start") return Response.json({});
			if (url.pathname === "/v2/manager/queue/history") {
				if (!uninstallComplete) return Response.json({ history: {} });
				const taskId = String(queuedTask?.ui_id);
				return Response.json({
					history: {
						ui_id: taskId,
						status: { completed: true, status_str: "success", messages: [] },
					},
				});
			}
			return new Response(null, { status: 404 });
		},
	);
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_198,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(nodes.removeCustomNode("ComfyUI-Manager")).rejects.toThrow(
		"ComfyUI Manager cannot be removed from Kastard.",
	);
	const removal = nodes.removeCustomNode("comfyui-kjnodes");
	await vi.waitFor(() => expect(queuedTask).not.toBeNull());
	expect(child.signalCode).toBeNull();
	uninstallComplete = true;
	await expect(removal).resolves.toEqual({
		restartRequired: true,
	});

	expect(queuedTask).toMatchObject({
		ui_id: expect.stringMatching(/^kastard-/u),
		client_id: expect.stringMatching(/^kastard-/u),
		kind: "uninstall",
		params: { node_name: "comfyui-kjnodes", is_unknown: false },
	});
	expect(trashItem).not.toHaveBeenCalled();
	expect(runtime.getState()).toEqual({
		status: "ready",
		url: "http://127.0.0.1:18198/",
	});
	await runtime.stop();
});

test("moves a manual custom-node symlink to Trash without following it", async () => {
	const paths = await fixture();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const externalNode = join(paths.dataDirectory, "external-node");
	const nodePath = join(customNodes, "linked-node");
	await mkdir(customNodes, { recursive: true });
	await createGitHubNode(externalNode);
	await symlink(externalNode, nodePath);
	const child = new FakeProcess();
	const trashItem = vi.fn(async () => undefined);
	const request = vi.fn(async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.pathname === "/system_stats" ||
			url.pathname === "/api/settings/Comfy.Workflow.NamedValuesRestore"
		) {
			return new Response(null, { status: 200 });
		}
		if (url.pathname === "/v2/customnode/installed") {
			return Response.json({ "linked-node": { ver: "unknown", cnr_id: null } });
		}
		return new Response(null, { status: 404 });
	});
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_199,
		fetch: request as typeof fetch,
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => child as unknown as ChildProcess,
		retryMs: 1,
		trashItem,
	});
	await runtime.start();

	await expect(nodes.removeCustomNode("linked-node")).resolves.toEqual({
		restartRequired: true,
	});
	expect(trashItem).toHaveBeenCalledWith(nodePath);
	await expect(access(externalNode)).resolves.toBeUndefined();
	await runtime.stop();
});

test("allows Trash recovery only after a custom-node startup failure", async () => {
	const paths = await fixture();
	const nodePath = join(paths.dataDirectory, "data", "custom_nodes", "broken-node");
	await mkdir(nodePath, { recursive: true });
	const child = new FakeProcess();
	const trashItem = vi.fn(async () => undefined);
	const { runtime, nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_200,
		fetch: vi.fn().mockRejectedValue(new Error("ComfyUI is not ready.")),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => {
			queueMicrotask(() => {
				child.stderr.write("(IMPORT FAILED): broken-node\n");
				child.stderr.write("x".repeat(13_000));
				child.exit(1);
			});
			return child as unknown as ChildProcess;
		},
		retryMs: 1,
		startupTimeoutMs: 500,
		trashItem,
	});

	await expect(runtime.start()).rejects.toThrow("ComfyUI exited with code 1.");
	expect(runtime.getState()).toMatchObject({ status: "error", reason: "custom-node" });
	await expect(nodes.removeCustomNode("broken-node")).resolves.toEqual({
		restartRequired: false,
	});
	expect(trashItem).toHaveBeenCalledWith(nodePath);
});

test("keeps a CNR package when its repository URL is invalid", async () => {
	const paths = await fixture();
	await createCnrNode(
		join(paths.dataDirectory, "data", "custom_nodes", "comfyui-kjnodes"),
		"comfyui-kjnodes",
		"1.5.0",
		"file:///private/custom-node",
	);
	const { nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
	});

	await expect(nodes.listCustomNodes()).resolves.toEqual([
		{
			name: "comfyui-kjnodes",
			version: "1.5.0",
			managerId: "comfyui-kjnodes",
		},
	]);
});

test("uses the local GitHub origin and HEAD without checking remote reachability", async () => {
	const paths = await fixture();
	const directory = join(
		paths.dataDirectory,
		"data",
		"custom_nodes",
		"tagged-git-node",
	);
	const commit = await createGitHubNode(directory);
	git(directory, "update-ref", "-d", "refs/remotes/origin/main");
	git(directory, "tag", "v1.0.0");
	const { nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
	});

	await expect(nodes.listCustomNodes()).resolves.toEqual([
		{
			name: "tagged-git-node",
			version: commit,
			managerId: null,
			repository: "https://github.com/owner/local-git-node.git",
		},
	]);
});

test("does not treat a repository subdirectory or symlink as a GitHub custom node", async () => {
	const paths = await fixture();
	const customNodes = join(paths.dataDirectory, "data", "custom_nodes");
	const nestedNode = join(customNodes, "nested-node");
	const externalNode = join(paths.dataDirectory, "external-node");
	await mkdir(nestedNode, { recursive: true });
	git(customNodes, "init", "--quiet");
	await writeFile(join(nestedNode, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
	git(customNodes, "add", "nested-node/__init__.py");
	commitGit(customNodes, "add nested node");
	git(customNodes, "remote", "add", "origin", "https://github.com/owner/monorepo.git");
	git(customNodes, "update-ref", "refs/remotes/origin/main", "HEAD");
	await createGitHubNode(externalNode);
	await symlink(externalNode, join(customNodes, "symlink-node"));
	const { nodes } = createNodes({
		...paths,
		platform: "darwin",
		arch: "arm64",
	});

	await expect(nodes.listCustomNodes()).resolves.toEqual([
		{
			name: ".git",
			version: "unknown",
			managerId: null,
			workerSyncIssue: "No Registry package or supported GitHub repository was found.",
		},
		{
			name: "nested-node",
			version: "unknown",
			managerId: null,
			workerSyncIssue:
				"The custom node directory is not the root of its Git repository.",
		},
		{
			name: "symlink-node",
			version: "unknown",
			managerId: null,
			workerSyncIssue:
				"Symbolic-link custom node directories cannot be reproduced on the Worker.",
		},
	]);
});

test.each(["timeout", "cancellation"] as const)(
	"reports Manager uninstall %s without losing its cause",
	async (reason) => {
		const paths = await fixture();
		const timeout = new AbortController();
		const caller = new AbortController();
		const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation((ms) =>
				ms === 120_000 ? timeout.signal : originalTimeout(ms),
			);
		let queued = false;
		const nodes = new EditorCustomNodes({
			...paths,
			getRuntimeState: () => ({ status: "ready", url: "http://127.0.0.1:18188/" }),
			fetch: (async (input, init) => {
				if (String(input).includes("customnode/installed")) {
					return Response.json({
						"example-node": { ver: "1.0.0", cnr_id: "example-node" },
					});
				}
				queued = true;
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
						once: true,
					});
				});
			}) as typeof fetch,
		});
		try {
			const removal = nodes.removeCustomNode("example-node", caller.signal);
			const expected = expect(removal).rejects.toThrow(
				reason === "timeout"
					? "ComfyUI Manager timed out while uninstalling example-node."
					: "Removal canceled.",
			);
			await vi.waitFor(() => expect(queued).toBe(true));
			if (reason === "timeout")
				timeout.abort(new DOMException("Timed out.", "TimeoutError"));
			else caller.abort(new Error("Removal canceled."));
			await expected;
		} finally {
			timeoutSpy.mockRestore();
		}
	},
);
