// @vitest-environment node

import { execFileSync } from "node:child_process";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test as baseTest, describe, expect, vi } from "vitest";
import { createCustomNodeSyncPlan } from "../worker/sync-plan";
import { inspectGitHubRepository } from "./custom-node-git";
import { EditorCustomNodes } from "./custom-nodes";
import { fixture } from "./test-fixture";

const testPython = process.env.KASTARD_TEST_PYTHON ?? "";
const test = baseTest.skipIf(process.platform === "win32");
const gitPath = process.env.PATH;
const repository = "https://github.com/example/example-node.git";

function git(directory: string, ...args: string[]) {
	return execFileSync("git", ["--no-optional-locks", "-C", directory, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: gitPath, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	}).trim();
}

function commit(directory: string) {
	git(
		directory,
		"-c",
		"user.name=Example",
		"-c",
		"user.email=example@example.com",
		"commit",
		"--allow-empty",
		"--quiet",
		"-m",
		"Example",
	);
}

async function repositoryFixture() {
	const paths = await fixture();
	const directory = join(paths.dataDirectory, "data", "custom_nodes", "example-node");
	await mkdir(directory, { recursive: true });
	git(directory, "init", "--quiet");
	await writeFile(join(directory, "node.py"), "VALUE = 1\n");
	await writeFile(join(directory, ".gitignore"), "ignored/\n");
	git(directory, "add", ".");
	commit(directory);
	git(directory, "remote", "add", "origin", repository);
	const version = git(directory, "rev-parse", "HEAD");
	const bin = join(paths.dataDirectory, "bin");
	await mkdir(bin);
	return { ...paths, directory, version, bin };
}

async function executable(path: string, script: string) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

async function blockGit(bin: string) {
	await executable(
		join(bin, "git"),
		"printf 'Git cannot run until the developer tools license is accepted.\\n' >&2\nexit 69",
	);
	vi.stubEnv("PATH", bin);
}

test("preserves verified Git metadata and both errors when Python inspection fails", async () => {
	const { directory, version, bin } = await repositoryFixture();
	await executable(
		join(bin, "git"),
		[
			'case "$4 $5" in',
			'"rev-parse --show-toplevel") printf "%s\\n" "$3" ;;',
			`"config --get") printf '%s\\n' '${repository}' ;;`,
			`"rev-parse --revs-only") printf '%s\\n' '${version}' ;;`,
			'*) printf "Status could not be read\\n" >&2; exit 2 ;;',
			"esac",
		].join("\n"),
	);
	const python = join(bin, "python");
	await executable(
		python,
		"printf 'ModuleNotFoundError: No module named pygit2\\n' >&2\nexit 1",
	);
	vi.stubEnv("PATH", bin);
	const result = await inspectGitHubRepository(directory, python);
	expect(result).toMatchObject({
		version,
		repository,
		workerSyncIssue: "The Git repository metadata could not be read.",
	});
	expect(result?.workerSyncErrorLog?.text).toContain("Status could not be read");
	expect(result?.workerSyncErrorLog?.text).toContain(
		"ModuleNotFoundError: No module named pygit2",
	);
});

test.each(["not json", "{}", '{"root":42,"errors":[]}'])(
	"blocks synchronization for invalid Python metadata: %s",
	async (output) => {
		const { directory, bin } = await repositoryFixture();
		await blockGit(bin);
		const python = join(bin, "python");
		await executable(python, `printf '%s' '${output}'`);
		const result = await inspectGitHubRepository(directory, python);
		expect(result?.workerSyncIssue).toBe(
			"The Git repository metadata could not be read.",
		);
		expect(result?.workerSyncErrorLog?.text).toContain("Exit code: 69");
	},
);

test("bounds Python failure output and preserves both command identities", async () => {
	const { directory, bin } = await repositoryFixture();
	await blockGit(bin);
	const python = join(bin, "python");
	await executable(
		python,
		"printf '%13000s' '' >&2\nprintf '\\033[31mRepository read failed\\033[0m\\n' >&2\nexit 1",
	);
	const result = await inspectGitHubRepository(directory, python);
	expect(result?.workerSyncErrorLog?.truncated).toBe(true);
	expect(result?.workerSyncErrorLog?.text).toContain(
		"Command: git rev-parse --show-toplevel",
	);
	expect(result?.workerSyncErrorLog?.text).toContain(
		"Command: Python (pygit2 repository inspection)",
	);
	expect(result?.workerSyncErrorLog?.text).toContain("Repository read failed");
	expect(result?.workerSyncErrorLog?.text.length).toBeLessThan(13_000);
});

test("cancels a running Python inspection", async () => {
	const { directory, bin } = await repositoryFixture();
	await blockGit(bin);
	const python = join(bin, "python");
	const started = join(bin, "started");
	await executable(python, `printf started > '${started}'\nexec /bin/sleep 30`);
	const controller = new AbortController();
	const pending = inspectGitHubRepository(directory, python, controller.signal);
	const rejected = expect(pending).rejects.toThrow("Inspection canceled");
	await vi.waitFor(() => access(started));
	controller.abort(new Error("Inspection canceled"));
	await rejected;
});

test("records the timeout of a stalled Python inspection", async () => {
	const { directory, bin } = await repositoryFixture();
	await blockGit(bin);
	const python = join(bin, "python");
	await executable(python, "printf 'Reading repository\\n' >&2\nexec /bin/sleep 30");
	const result = await inspectGitHubRepository(directory, python);
	expect(result?.workerSyncErrorLog?.text).toContain("Signal: SIGTERM");
	expect(result?.workerSyncErrorLog?.text).toContain("Reading repository");
}, 15_000);

describe.skipIf(testPython === "")("managed pygit2 inspection", () => {
	test.each([false, true])(
		"includes the recovered commit in the sync plan with Manager ready=%s",
		async (ready) => {
			const paths = await repositoryFixture();
			await symlink(
				dirname(dirname(testPython)),
				join(paths.dataDirectory, "environment"),
				"dir",
			);
			await blockGit(paths.bin);
			const nodes = new EditorCustomNodes({
				...paths,
				getRuntimeState: () =>
					ready
						? { status: "ready", url: "http://127.0.0.1:18188/" }
						: { status: "idle" },
				fetch: (async () =>
					Response.json({
						"example-node": { ver: "unknown", cnr_id: null },
					})) as typeof fetch,
			});
			const entries = await nodes.listCustomNodes();
			expect(entries).toEqual([
				{ name: "example-node", version: paths.version, repository, managerId: null },
			]);
			expect(
				createCustomNodeSyncPlan(
					entries.map((node) => ({ ...node, sync: true })),
					"4.2.2",
				),
			).toEqual({
				managerVersion: "4.2.2",
				nodes: [{ id: "example/example-node", version: paths.version, repository }],
				unsupportedNodes: [],
			});
		},
	);

	test.each(["missing", "timeout", "status failure"])(
		"recovers metadata after %s Git",
		async (failure) => {
			const { directory, version, bin } = await repositoryFixture();
			if (failure === "timeout")
				await executable(join(bin, "git"), "exec /bin/sleep 30");
			if (failure === "status failure") {
				const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
					encoding: "utf8",
				}).trim();
				await executable(
					join(bin, "git"),
					`if [ "$4" = status ]; then exit 69; fi\nexec '${realGit}' "$@"`,
				);
			}
			vi.stubEnv("PATH", bin);
			await expect(inspectGitHubRepository(directory, testPython)).resolves.toEqual({
				version,
				repository,
			});
		},
		15_000,
	);

	test.each([
		"clean",
		"staged",
		"unstaged",
		"untracked",
		"ignored",
		"missing origin",
		"unsupported origin",
		"unborn HEAD",
		"detached HEAD",
		"nested",
		"symlink",
		"worktree",
		"invalid index",
	])("matches Git eligibility for %s repositories", async (state) => {
		const { directory, bin, dataDirectory } = await repositoryFixture();
		let inspected = directory;
		if (state === "staged" || state === "unstaged") {
			await writeFile(join(directory, "node.py"), "VALUE = 2\n");
			if (state === "staged") git(directory, "add", "node.py");
		}
		if (state === "untracked" || state === "ignored") {
			await mkdir(join(directory, state));
			await writeFile(join(directory, state, "local.py"), "VALUE = 2\n");
		}
		if (state === "missing origin") git(directory, "remote", "remove", "origin");
		if (state === "unsupported origin")
			git(
				directory,
				"remote",
				"set-url",
				"origin",
				"https://example.com/example/node.git",
			);
		if (state === "unborn HEAD") git(directory, "checkout", "--orphan", "empty");
		if (state === "detached HEAD") git(directory, "checkout", "--detach", "HEAD");
		if (state === "nested") {
			inspected = join(directory, "nested");
			await mkdir(inspected);
		}
		if (state === "symlink") {
			inspected = join(dataDirectory, "link");
			await symlink(directory, inspected, "dir");
		}
		if (state === "worktree") {
			inspected = join(dataDirectory, "worktree");
			git(directory, "worktree", "add", "--detach", inspected);
		}
		if (state === "invalid index")
			await writeFile(join(directory, ".git", "index"), "invalid");
		const expected = await inspectGitHubRepository(
			inspected,
			join(bin, "unavailable-python"),
		);
		await blockGit(bin);
		const actual = await inspectGitHubRepository(inspected, testPython);
		const eligibility = (value: typeof actual) => ({
			version: value?.version,
			repository: value?.repository,
			issue: value?.workerSyncIssue,
		});
		expect(eligibility(actual)).toEqual(eligibility(expected));
	});

	test("matches Git for modified, staged, added, removed, and replaced submodules", async () => {
		const { directory, bin, dataDirectory } = await repositoryFixture();
		const source = join(dataDirectory, "dependency");
		await mkdir(source);
		git(source, "init", "--quiet");
		await writeFile(join(source, "dependency.py"), "VALUE = 1\n");
		git(source, "add", ".");
		commit(source);
		git(
			directory,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			source,
			"dependency",
		);
		git(directory, "add", ".");
		commit(directory);
		const child = join(directory, "dependency");
		async function compare() {
			vi.unstubAllEnvs();
			const expected = await inspectGitHubRepository(
				directory,
				join(bin, "unavailable-python"),
			);
			await blockGit(bin);
			expect(await inspectGitHubRepository(directory, testPython)).toEqual(expected);
		}
		await writeFile(join(child, "dependency.py"), "VALUE = 2\n");
		await compare();
		git(child, "add", ".");
		commit(child);
		git(directory, "add", "dependency");
		await compare();
		const head = git(child, "rev-parse", "HEAD");
		git(
			directory,
			"update-index",
			"--add",
			"--cacheinfo",
			`160000,${head},new-dependency`,
		);
		await compare();
		git(directory, "update-index", "--force-remove", "dependency");
		await rm(child, { recursive: true });
		await compare();
		await writeFile(child, "ordinary file\n");
		git(directory, "add", "dependency");
		await compare();
	});

	test("isolates inspection from custom-node Python modules and environment overrides", async () => {
		const { directory, bin } = await repositoryFixture();
		await writeFile(
			join(directory, "pygit2.py"),
			'raise RuntimeError("Custom node code was executed")\n',
		);
		await writeFile(
			join(directory, "sitecustomize.py"),
			'raise RuntimeError("Custom node startup code was executed")\n',
		);
		git(directory, "add", ".");
		commit(directory);
		const expectedVersion = git(directory, "rev-parse", "HEAD");
		await blockGit(bin);
		vi.stubEnv("PYTHONPATH", directory);
		vi.stubEnv("PYTHONHOME", directory);
		vi.stubEnv("GIT_DIR", join(directory, "unrelated"));
		await expect(inspectGitHubRepository(directory, testPython)).resolves.toEqual({
			version: expectedVersion,
			repository,
		});
		await expect(access(join(directory, "__pycache__"))).rejects.toThrow();
	});

	test.each([false, true])(
		"identifies installed nodes with unavailable Git and installation failure=%s",
		async (fails) => {
			const paths = await repositoryFixture();
			await symlink(
				dirname(dirname(testPython)),
				join(paths.dataDirectory, "environment"),
				"dir",
			);
			await blockGit(paths.bin);
			const installedRepository = "https://github.com/example/installed-node.git";
			const installed = join(dirname(paths.directory), "installed-node");
			const unrelated = join(dirname(paths.directory), "unrelated-node");
			const trashItem = vi.fn(async () => undefined);
			const nodes = new EditorCustomNodes({
				...paths,
				getRuntimeState: () =>
					fails
						? { status: "ready", url: "http://127.0.0.1:18188/" }
						: { status: "idle" },
				fetch: (async () => Response.json({})) as typeof fetch,
				trashItem,
				runCommand: async () => {
					git(paths.directory, "clone", "--local", paths.directory, installed);
					git(installed, "remote", "set-url", "origin", installedRepository);
					if (fails) {
						git(paths.directory, "clone", "--local", paths.directory, unrelated);
						git(
							unrelated,
							"remote",
							"set-url",
							"origin",
							"https://github.com/example/unrelated-node.git",
						);
						throw new Error("Installation failed");
					}
				},
			});
			if (fails) {
				await expect(nodes.installCustomNode(installedRepository)).rejects.toThrow(
					"ComfyUI Manager could not install the custom node.",
				);
				expect(trashItem.mock.calls).toEqual([[installed]]);
				await expect(access(unrelated)).resolves.toBeUndefined();
			} else {
				await expect(
					nodes.installCustomNode(installedRepository),
				).resolves.toMatchObject({
					node: {
						name: "installed-node",
						repository: installedRepository,
						version: paths.version,
						managerId: null,
					},
					restartRequired: true,
				});
			}
		},
	);

	test("keeps an unprepared node excluded and recovers on a later inventory refresh", async () => {
		const paths = await repositoryFixture();
		await blockGit(paths.bin);
		const nodes = new EditorCustomNodes({
			...paths,
			getRuntimeState: () => ({ status: "idle" }),
		});
		const [failed] = await nodes.listCustomNodes();
		expect(failed?.workerSyncErrorLog?.text).toContain("Error code: ENOENT");
		await symlink(
			dirname(dirname(testPython)),
			join(paths.dataDirectory, "environment"),
			"dir",
		);
		await expect(nodes.listCustomNodes()).resolves.toEqual([
			{ name: "example-node", managerId: null, repository, version: paths.version },
		]);
	});
});
