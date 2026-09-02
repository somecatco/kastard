import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BackendProvisionerApi, BackendState } from "./backend-provisioner";
import {
	CustomNodeProvisioner,
	CustomNodeSyncError,
	type CustomNodeSyncState,
	runCommand,
} from "./custom-node-provisioner";
import { ServerLogStore } from "./server-log";

const ROOT = join(tmpdir(), "kastard-custom-node-provisioner-test");
const RUNTIME_PYTHON = "/opt/kastard/runtime/bin/python";
const MANAGER_VERSION = "4.2.2";

describe("CustomNodeProvisioner", () => {
	beforeEach(async () => rm(ROOT, { recursive: true, force: true }));
	afterEach(async () => rm(ROOT, { recursive: true, force: true }));

	test("streams normalized command output before the command exits", async () => {
		await mkdir(ROOT, { recursive: true });
		const lines: Array<{ stream: "stdout" | "stderr"; line: string }> = [];
		let finished = false;
		const execution = runCommand(
			[
				process.execPath,
				"-e",
				[
					'process.stdout.write("Downloading\\r");',
					'process.stderr.write(String.fromCharCode(27) + "[33mResolved 3 packages" + String.fromCharCode(27) + "[0m\\n");',
					"await Bun.sleep(150);",
					'process.stdout.write("Installed\\n" + "x".repeat(4_010) + "\\n");',
				].join(""),
			],
			{
				cwd: ROOT,
				env: {},
				timeoutMs: 2_000,
				onOutput: (stream, line) => lines.push({ stream, line }),
			},
		);
		void execution.then(
			() => {
				finished = true;
			},
			() => {
				finished = true;
			},
		);

		await waitForCondition(
			() =>
				lines.some(({ line }) => line === "Downloading") &&
				lines.some(({ line }) => line === "Resolved 3 packages"),
		);
		expect(finished).toBe(false);

		const output = await execution;
		expect(output).toContain("Downloading\rInstalled");
		expect(output).toContain("Resolved 3 packages");
		expect(lines).toContainEqual({ stream: "stdout", line: "Installed" });
		expect(lines.filter(({ line }) => /^x+$/u.test(line))).toHaveLength(2);
		expect(lines.every(({ line }) => line.length <= 4_000)).toBe(true);
	});

	test("returns a timeout without waiting for inherited output streams", async () => {
		await mkdir(ROOT, { recursive: true });
		const startedAt = performance.now();
		const execution = runCommand(
			[
				process.execPath,
				"-e",
				[
					`Bun.spawn([${JSON.stringify(process.execPath)}, "-e", "await Bun.sleep(2_000)"], { stdout: "inherit", stderr: "inherit" });`,
					"await Bun.sleep(2_000);",
				].join(""),
			],
			{ cwd: ROOT, env: {}, timeoutMs: 25 },
		);

		await expect(execution).rejects.toThrow(
			"Custom node command timed out after 25ms.",
		);
		expect(performance.now() - startedAt).toBeLessThan(1_500);
	});

	test("can return only stdout while still streaming stderr", async () => {
		await mkdir(ROOT, { recursive: true });
		const lines: Array<{ stream: "stdout" | "stderr"; line: string }> = [];
		const output = await runCommand(
			[
				process.execPath,
				"-e",
				'process.stdout.write("value\\n"); process.stderr.write("warning\\n");',
			],
			{
				cwd: ROOT,
				env: {},
				timeoutMs: 2_000,
				returnOutput: "stdout",
				onOutput: (stream, line) => lines.push({ stream, line }),
			},
		);

		expect(output).toBe("value");
		expect(lines).toContainEqual({ stream: "stderr", line: "warning" });
	});

	test("records each custom node command stage and its output", async () => {
		const logs = new ServerLogStore({ instanceId: "server-one" });
		const cursor = logs.getCursor();
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs,
			runCommand: async (command, options) => {
				options.onOutput?.("stdout", `Running ${command[0]}.`);
				return fakeManagerCommand(command, options);
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
		});
		await waitForState(provisioner, "ready");

		expect(logs.readAfter(cursor).logs.map(({ message }) => message)).toEqual([
			`Installing ComfyUI Manager ${MANAGER_VERSION} with uv.`,
			"[stdout] Running uv.",
			`Synchronizing 1 custom nodes with local Manager ${MANAGER_VERSION}; installing 1.`,
			"Installing comfyui-kjnodes@1.5.0.",
			`[stdout] Running ${RUNTIME_PYTHON}.`,
			"1 custom node is synchronized.",
		]);
	});

	test("installs exact node versions one at a time", async () => {
		const commands: Array<{
			command: string[];
			cwd: string;
			env: NodeJS.ProcessEnv;
			timeoutMs: number;
		}> = [];
		const managerDirectories: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				commands.push({
					command,
					cwd: options.cwd,
					env: options.env,
					timeoutMs: options.timeoutMs,
				});
				return fakeManagerCommand(command);
			},
			prepareManagerDirectory: async (...args) => {
				managerDirectories.push(args);
				await mkdir(args[1], { recursive: true });
			},
			sourceEnvironment: {
				PATH: "/usr/bin",
				UV_CONSTRAINT: "/opt/kastard/runtime-constraints.txt",
				RUNPOD_API_KEY: "must-not-reach-custom-nodes",
			},
		});

		expect(
			provisioner.sync({
				managerVersion: MANAGER_VERSION,
				nodes: [
					{ id: "comfyui-kjnodes", version: "1.5.0" },
					{ id: "comfyui-impact-pack", version: "8.24" },
				],
			}),
		).toMatchObject({
			status: "syncing",
			phase: "install",
			total: 2,
		});

		await waitForState(provisioner, "ready");
		expect(commands).toHaveLength(3);
		expect(commands[0]?.command).toEqual([
			"uv",
			"pip",
			"install",
			"--python",
			RUNTIME_PYTHON,
			`comfyui_manager==${MANAGER_VERSION}`,
		]);
		expect(commands[1]?.command).toEqual([
			RUNTIME_PYTHON,
			"-m",
			"cm_cli",
			"install",
			"comfyui-kjnodes@1.5.0",
			"--mode",
			"cache",
			"--user-directory",
			join(ROOT, ".kastard", "comfyui-manager"),
			"--exit-on-fail",
		]);
		expect(commands[2]?.command).toEqual([
			RUNTIME_PYTHON,
			"-m",
			"cm_cli",
			"install",
			"comfyui-impact-pack@8.24",
			"--mode",
			"cache",
			"--user-directory",
			join(ROOT, ".kastard", "comfyui-manager"),
			"--exit-on-fail",
		]);
		expect(commands[1]?.timeoutMs).toBe(15 * 60 * 1_000);
		expect(commands[2]?.timeoutMs).toBe(15 * 60 * 1_000);
		expect(commands[0]).toMatchObject({
			cwd: join(ROOT, "backend"),
			env: {
				PATH: "/usr/bin",
				HOME: join(ROOT, ".kastard", "comfyui-manager"),
				UV_CONSTRAINT: "/opt/kastard/runtime-constraints.txt",
				PYTHONPYCACHEPREFIX: join(
					ROOT,
					".kastard",
					"comfyui-manager",
					"cache",
					"python-bytecode",
				),
				COMFYUI_PATH: join(ROOT, "backend"),
				COMFYUI_FOLDERS_BASE_PATH: ROOT,
			},
		});
		expect(commands[0]?.env).not.toHaveProperty("RUNPOD_API_KEY");
		expect(commands[1]?.command).toContain(join(ROOT, ".kastard", "comfyui-manager"));
		expect(managerDirectories).toEqual([
			[ROOT, join(ROOT, ".kastard", "comfyui-manager")],
		]);
		expect(provisioner.getState()).toMatchObject({
			status: "ready",
			nodes: [
				{ id: "comfyui-kjnodes", version: "1.5.0" },
				{ id: "comfyui-impact-pack", version: "8.24" },
			],
		});
	});

	test("refreshes the node snapshot after each completed install", async () => {
		const firstNode = { id: "first-node", version: "1.0.0" };
		const secondNode = { id: "second-node", version: "2.0.0" };
		let finishSecondInstall = (): void => undefined;
		const secondInstall = new Promise<void>((resolve) => {
			finishSecondInstall = resolve;
		});
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				if (command[4] === `${secondNode.id}@${secondNode.version}`) {
					await secondInstall;
				}
				return fakeManagerCommand(command, options);
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [firstNode, secondNode],
		});
		await waitForCondition(() => {
			const state = provisioner.getState();
			return (
				state.status === "syncing" &&
				state.currentNode === `${secondNode.id}@${secondNode.version}`
			);
		});

		expect(provisioner.getState()).toMatchObject({
			status: "syncing",
			current: 1,
			currentNode: `${secondNode.id}@${secondNode.version}`,
			nodeSnapshot: {
				targetNodes: [
					{ id: firstNode.id, status: "installed", workerVersion: firstNode.version },
					{ id: secondNode.id, status: "installing", workerVersion: null },
				],
			},
		});
		finishSecondInstall();
		await waitForState(provisioner, "ready");
	});

	test("continues installing selected nodes after one install fails", async () => {
		const failedNode = { id: "failed-node", version: "1.0.0" };
		const successfulNode = { id: "successful-node", version: "2.0.0" };
		const nodes = [failedNode, successfulNode];
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				if (command[4] === "failed-node@1.0.0") {
					throw new Error("Registry unavailable.");
				}
				return fakeManagerCommand(command);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes });
		await waitForState(provisioner, "failed");

		expect(
			commands
				.filter((command) => command[3] === "install")
				.map((command) => command[4]),
		).toEqual(["failed-node@1.0.0", "successful-node@2.0.0"]);
		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			nodes: [
				{
					name: successfulNode.id,
					managerId: successfulNode.id,
					version: successfulNode.version,
				},
			],
			error: expect.stringContaining("failed-node: Registry unavailable."),
			nodeSnapshot: {
				targetNodes: [
					{ id: failedNode.id, status: "failed", workerVersion: null },
					{
						id: successfulNode.id,
						status: "installed",
						workerVersion: successfulNode.version,
					},
				],
				activeNodes: [
					{
						name: successfulNode.id,
						managerId: successfulNode.id,
						version: successfulNode.version,
					},
				],
			},
		});
		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({
			managerVersion: MANAGER_VERSION,
			confirmedNodes: [successfulNode],
		});
	});

	test("does not confirm an install when Manager reports an error", async () => {
		const node = { id: "reported-error-node", version: "1.0.0" };
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				const output = await fakeManagerCommand(command);
				return command[3] === "install"
					? "ERROR: dependency installation failed"
					: output;
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [node] });
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			nodes: [{ managerId: node.id, version: node.version }],
			error: expect.stringContaining("Manager reported install errors"),
			nodeSnapshot: {
				targetNodes: [{ id: node.id, status: "failed", workerVersion: node.version }],
			},
		});
		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({ managerVersion: MANAGER_VERSION, confirmedNodes: [] });
	});

	test("synchronizes a public GitHub node to the requested commit", async () => {
		const directory = join(ROOT, "custom_nodes", "comfyui-obvpm");
		const source = join(ROOT, "source", "comfyui-obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		const { firstCommit } = await writeGitHubNode(directory);
		await mkdir(dirname(source), { recursive: true });
		await gitTest(ROOT, "clone", "--no-hardlinks", directory, source);
		await gitTest(
			source,
			"remote",
			"set-url",
			"origin",
			"https://github.com/obvpm/comfyui-obvpm.git",
		);
		const node = {
			id: "obvpm/comfyui-obvpm",
			version: firstCommit,
			repository: "https://github.com/obvpm/comfyui-obvpm.git",
		};
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				commands.push(command);
				if (command[0] === "git") return runCommand(command, options);
				if (managerAction(command) === "uninstall") {
					await rm(directory, { recursive: true, force: true });
				}
				if (command[3] === "install" && command[4] === node.repository) {
					await gitTest(ROOT, "clone", "--no-hardlinks", source, directory);
					await gitTest(directory, "remote", "set-url", "origin", node.repository);
				}
				return "";
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [node] });
		await waitForState(provisioner, "ready");

		expect(provisioner.getState()).toMatchObject({ status: "ready", nodes: [node] });
		expect(await gitTest(directory, "rev-parse", "HEAD")).toBe(firstCommit);
		expect(await readFile(join(directory, "__init__.py"), "utf8")).toBe(
			"first revision\n",
		);
		expect(commands).toContainEqual([
			"git",
			"--no-optional-locks",
			"-C",
			directory,
			"checkout",
			"--no-overwrite-ignore",
			"--detach",
			firstCommit,
		]);
		expect(commands).toContainEqual([
			RUNTIME_PYTHON,
			"-m",
			"cm_cli",
			"fix",
			"comfyui-obvpm@unknown",
			"--mode",
			"cache",
			"--user-directory",
			join(ROOT, ".kastard", "comfyui-manager"),
		]);
		expect(
			await provisioner.verify({ managerVersion: MANAGER_VERSION, nodes: [node] }),
		).toEqual({ status: "synced", total: 1 });

		commands.length = 0;
		await writeFile(join(directory, "stale-local-file.py"), "remove me\n");
		provisioner.reinstall({ managerVersion: MANAGER_VERSION, nodes: [node] });
		await waitForState(provisioner, "ready");
		expect(provisioner.getState()).toMatchObject({
			operationKind: "reinstall",
			status: "ready",
			nodes: [node],
		});
		expect(
			commands.find((command) => managerAction(command) === "uninstall")?.[4],
		).toBe("comfyui-obvpm@unknown");
		expect(commands.find((command) => command[3] === "install")?.[4]).toBe(
			node.repository,
		);
		expect(commands.filter((command) => command[3] === "fix")).toHaveLength(1);
		await expect(access(join(directory, "stale-local-file.py"))).rejects.toThrow();
		expect(await gitTest(directory, "rev-parse", "HEAD")).toBe(firstCommit);
	});

	test("fetches a missing commit outside the checkout's local Git config", async () => {
		const directory = join(ROOT, "custom_nodes", "comfyui-obvpm");
		const source = join(ROOT, "source", "comfyui-obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		await writeGitHubNode(directory);
		await gitTest(
			directory,
			"remote",
			"set-url",
			"origin",
			"git@github.com:obvpm/comfyui-obvpm.git",
		);
		await writeGitHubNode(source);
		await writeFile(join(source, "target.py"), "target revision\n");
		await gitTest(source, "add", "target.py");
		await gitTest(source, "commit", "-m", "target");
		const targetCommit = (await gitTest(source, "rev-parse", "HEAD")).trim();
		const node = githubNode(targetCommit);
		await gitTest(
			directory,
			"config",
			`url.file://${join(ROOT, "unreachable-mirror")}.insteadOf`,
			node.repository,
		);
		const commands: Array<{
			command: string[];
			environment: NodeJS.ProcessEnv;
		}> = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				if (command[0] !== "git") return "";
				commands.push({ command, environment: options.env });
				if (command[4] === "fetch") {
					const isolatedFetch = [...command];
					const repositoryIndex = isolatedFetch.indexOf(node.repository);
					isolatedFetch[repositoryIndex] = source;
					return runCommand(isolatedFetch, options);
				}
				return runCommand(command, options);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [node] });
		await waitForState(provisioner, "ready");

		const fetch = commands.find(({ command }) => command[4] === "fetch");
		expect(fetch?.command.slice(4)).toEqual([
			"fetch",
			"--force",
			"--no-write-fetch-head",
			node.repository,
			targetCommit,
		]);
		expect(fetch?.command[3]).not.toBe(directory);
		expect(fetch?.environment.GIT_OBJECT_DIRECTORY).toBe(
			join(directory, ".git", "objects"),
		);
		expect(fetch?.environment.HOME).toBe(fetch?.command[3]);
		expect(fetch?.environment.XDG_CONFIG_HOME).toBe(fetch?.command[3]);
		await expect(access(fetch?.command[3] ?? "")).rejects.toThrow();
		expect(await gitTest(directory, "rev-parse", "HEAD")).toBe(targetCommit);
	});

	test("reports an unavailable GitHub commit without exposing command output", async () => {
		const directory = join(ROOT, "custom_nodes", "comfyui-obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		const { secondCommit } = await writeGitHubNode(directory);
		const node = githubNode("b".repeat(40));
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				if (command[0] !== "git") return "";
				if (command[4] === "fetch") throw new Error("sensitive command output");
				return runCommand(command, options);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [node] });
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining(
				`Worker could not fetch the requested GitHub commit: ${node.id}.`,
			),
		});
		expect(JSON.stringify(provisioner.getState())).not.toContain(
			"sensitive command output",
		);
		expect(await gitTest(directory, "rev-parse", "HEAD")).toBe(secondCommit);
	});

	test("preserves a dirty Worker GitHub checkout", async () => {
		const directory = join(ROOT, "custom_nodes", "comfyui-obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		const { firstCommit, secondCommit } = await writeGitHubNode(directory);
		await Promise.all([
			writeFile(join(directory, "__init__.py"), "dirty local change\n"),
			writeFile(join(directory, "untracked.py"), "untracked local file\n"),
		]);
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) =>
				command[0] === "git" ? runCommand(command, options) : "",
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [githubNode(firstCommit)],
		});
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining("has local changes"),
		});
		expect(await gitTest(directory, "rev-parse", "HEAD")).toBe(secondCommit);
		expect(await readFile(join(directory, "__init__.py"), "utf8")).toBe(
			"dirty local change\n",
		);
		expect(await readFile(join(directory, "untracked.py"), "utf8")).toBe(
			"untracked local file\n",
		);
	});

	test("preserves an ignored Worker file that conflicts with the requested commit", async () => {
		const directory = join(ROOT, "custom_nodes", "comfyui-obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		await writeGitHubNode(directory);
		await writeFile(join(directory, ".gitignore"), "generated.py\n");
		await gitTest(directory, "add", ".gitignore");
		await gitTest(directory, "commit", "-m", "ignore generated file");
		const workerCommit = (await gitTest(directory, "rev-parse", "HEAD")).trim();
		await writeFile(join(directory, "generated.py"), "tracked target file\n");
		await gitTest(directory, "add", "--force", "generated.py");
		await gitTest(directory, "commit", "-m", "track generated file");
		const targetCommit = (await gitTest(directory, "rev-parse", "HEAD")).trim();
		await gitTest(directory, "checkout", "--detach", workerCommit);
		await writeFile(join(directory, "generated.py"), "ignored local file\n");
		expect(
			await gitTest(directory, "status", "--porcelain=v1", "--untracked-files=all"),
		).toBe("");
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) =>
				command[0] === "git" ? runCommand(command, options) : "",
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [githubNode(targetCommit)],
		});
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining(
				"has ignored files that conflict with the requested version",
			),
		});
		expect(await gitTest(directory, "rev-parse", "HEAD")).toBe(workerCommit);
		expect(await readFile(join(directory, "generated.py"), "utf8")).toBe(
			"ignored local file\n",
		);
	});

	test("synchronizes only the root commit without inspecting Git submodules", async () => {
		const directory = join(ROOT, "custom_nodes", "comfyui-obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		await writeGitHubNode(directory);
		const workerCommit = (await gitTest(directory, "rev-parse", "HEAD")).trim();
		const { commit: targetCommit, submoduleDirectory } = await addSubmodule(directory);
		await gitTest(directory, "checkout", "--detach", workerCommit);
		await rm(submoduleDirectory, { recursive: true, force: true });
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				commands.push(command);
				return command[0] === "git" ? runCommand(command, options) : "";
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [githubNode(targetCommit)],
		});
		await waitForState(provisioner, "ready");

		expect(provisioner.getState()).toMatchObject({ status: "ready" });
		expect(await gitTest(directory, "rev-parse", "HEAD")).toBe(targetCommit);
		await expect(
			access(join(submoduleDirectory, "dependency.py")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(commands.some((command) => command.includes("submodule"))).toBe(false);
	});

	test("does not synchronize a GitHub custom node nested in another repository", async () => {
		const customNodesDirectory = join(ROOT, "custom_nodes");
		const directory = join(customNodesDirectory, "comfyui-obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		await mkdir(directory, { recursive: true });
		await gitTest(customNodesDirectory, "init");
		await writeFile(join(directory, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
		await gitTest(customNodesDirectory, "add", "comfyui-obvpm/__init__.py");
		await gitTest(customNodesDirectory, "commit", "-m", "add nested node");
		const commit = (await gitTest(customNodesDirectory, "rev-parse", "HEAD")).trim();
		await gitTest(
			customNodesDirectory,
			"remote",
			"add",
			"origin",
			"https://github.com/obvpm/comfyui-obvpm.git",
		);
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) =>
				command[0] === "git" ? runCommand(command, options) : "",
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [githubNode(commit)] });
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining("must be a repository root"),
		});
		expect(await gitTest(customNodesDirectory, "rev-parse", "HEAD")).toBe(commit);
	});

	test("does not synchronize a Worker GitHub checkout through a symlink", async () => {
		const source = join(ROOT, "external", "comfyui-obvpm");
		const { firstCommit, secondCommit } = await writeGitHubNode(source);
		await mkdir(join(ROOT, "custom_nodes"), { recursive: true });
		await symlink(source, join(ROOT, "custom_nodes", "comfyui-obvpm"));
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) =>
				command[0] === "git" ? runCommand(command, options) : "",
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [githubNode(firstCommit)],
		});
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining("unsupported or unmanaged node"),
		});
		expect(await gitTest(source, "rev-parse", "HEAD")).toBe(secondCommit);
	});

	test("asks Manager to clone a missing GitHub node by repository URL", async () => {
		const commit = "a".repeat(40);
		const repository = "https://github.com/obvpm/comfyui-obvpm.git";
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return "";
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [{ id: "obvpm/comfyui-obvpm", version: commit, repository }],
		});
		await waitForState(provisioner, "failed");

		expect(commands.filter((command) => command[3] === "enable")).toHaveLength(0);
		expect(commands.find((command) => command[3] === "install")).toEqual([
			RUNTIME_PYTHON,
			"-m",
			"cm_cli",
			"install",
			repository,
			"--mode",
			"cache",
			"--user-directory",
			join(ROOT, ".kastard", "comfyui-manager"),
			"--no-deps",
			"--exit-on-fail",
		]);
	});

	test("enables an inactive GitHub node before synchronizing it", async () => {
		const directoryName = "ComfyUI-Obvpm";
		const disabledDirectory = join(ROOT, "custom_nodes", ".disabled", directoryName);
		await mkdir(join(ROOT, "backend"), { recursive: true });
		const { secondCommit } = await writeGitHubNode(disabledDirectory);
		const node = githubNode(secondCommit);
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				commands.push(command);
				if (command[0] === "git") return runCommand(command, options);
				if (command[3] === "enable") {
					await rename(disabledDirectory, join(ROOT, "custom_nodes", directoryName));
				}
				return "";
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [node] });
		await waitForState(provisioner, "ready");
		expect(commands.find((command) => command[3] === "enable")?.[4]).toBe(
			`${directoryName}@unknown`,
		);
		expect(commands.some((command) => command[3] === "install")).toBe(false);
	});

	test("does not enable a different GitHub repository with the same directory name", async () => {
		const directory = join(ROOT, "custom_nodes", "repository");
		const managerDirectory = join(ROOT, ".kastard", "comfyui-manager");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		const { secondCommit } = await writeGitHubNode(directory);
		await gitTest(
			directory,
			"remote",
			"set-url",
			"origin",
			"https://github.com/owner-a/repository.git",
		);
		const previousNode = {
			id: "owner-a/repository",
			version: secondCommit,
			repository: "https://github.com/owner-a/repository.git",
		};
		await mkdir(managerDirectory, { recursive: true });
		await writeFile(
			join(managerDirectory, "custom-node-installations.json"),
			`${JSON.stringify({
				managerVersion: MANAGER_VERSION,
				confirmedNodes: [previousNode],
			})}\n`,
		);
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				commands.push(command);
				return command[0] === "git" ? runCommand(command, options) : "";
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [
				{
					id: "owner-b/repository",
					version: "b".repeat(40),
					repository: "https://github.com/owner-b/repository.git",
				},
			],
		});
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining(
				"repository is occupied by owner-a/repository, not owner-b/repository",
			),
		});
		expect(
			commands.filter((command) =>
				["disable", "enable", "install"].includes(command[3] ?? ""),
			),
		).toHaveLength(0);
		expect(await gitTest(directory, "rev-parse", "HEAD")).toBe(secondCommit);
		expect(
			JSON.parse(
				await readFile(
					join(managerDirectory, "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({
			managerVersion: MANAGER_VERSION,
			confirmedNodes: [previousNode],
		});
	});

	test("leaves an unrequested GitHub node active", async () => {
		const directory = join(ROOT, "custom_nodes", "ComfyUI-Obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		const { secondCommit } = await writeGitHubNode(directory);
		const node = githubNode(secondCommit);
		await writeInstallations(node);
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				commands.push(command);
				return command[0] === "git"
					? runCommand(command, options)
					: fakeManagerCommand(command);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [] });
		await waitForState(provisioner, "ready");

		expect(commands.some((command) => command[3] === "disable")).toBe(false);
		expect(await gitTest(directory, "rev-parse", "HEAD")).toBe(secondCommit);
	});

	test("detects a registry directory conflict before installing a GitHub node", async () => {
		await mkdir(join(ROOT, "backend"), { recursive: true });
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				if (command[3] === "install" && command[4] === "registry-node@1.0.0") {
					await writeTrackedNode(ROOT, "registry-node", "1.0.0", "repository");
				}
				return "";
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [
				{ id: "registry-node", version: "1.0.0" },
				{
					id: "owner/repository",
					version: "a".repeat(40),
					repository: "https://github.com/owner/repository.git",
				},
			],
		});
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining("directory repository is occupied"),
		});
		expect(
			commands.some(
				(command) => command[3] === "install" && command[4]?.startsWith("https://"),
			),
		).toBe(false);
		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({
			managerVersion: MANAGER_VERSION,
			confirmedNodes: [{ id: "registry-node", version: "1.0.0" }],
		});
	});

	test("verifies requested nodes without rejecting additional Worker inventory", async () => {
		const nodes = [{ id: "comfyui-kjnodes", version: "1.5.0" }];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});
		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes });
		await waitForState(provisioner, "ready");
		const ready = provisioner.getState();

		expect(
			await provisioner.verify({ managerVersion: MANAGER_VERSION, nodes }),
		).toEqual({ status: "synced", total: 1 });
		const installationPath = join(
			ROOT,
			".kastard",
			"comfyui-manager",
			"custom-node-installations.json",
		);
		const installationContents = await readFile(installationPath, "utf8");
		const installations = JSON.parse(installationContents);
		await writeFile(
			installationPath,
			JSON.stringify({
				...installations,
				confirmedNodes: [...nodes, { id: "stale-node", version: "1.0.0" }],
			}),
		);
		expect(
			await provisioner.verify({ managerVersion: MANAGER_VERSION, nodes }),
		).toEqual({ status: "synced", total: 1 });
		await writeFile(installationPath, installationContents);
		expect(await provisioner.verify({ managerVersion: "4.3.0", nodes })).toMatchObject({
			status: "out-of-sync",
			problems: [{ reason: "version-mismatch", name: "ComfyUI Manager" }],
		});
		await mkdir(join(ROOT, "custom_nodes", "manual-node"), { recursive: true });
		expect(
			await provisioner.verify({ managerVersion: MANAGER_VERSION, nodes }),
		).toEqual({ status: "synced", total: 1 });
		expect(provisioner.getState()).toEqual(ready);
	});

	test("does not verify an exact active node without a completion record", async () => {
		const node = { id: "unconfirmed-node", version: "1.0.0" };
		await writeTrackedNode(ROOT, node.id, node.version);
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});

		expect(
			await provisioner.verify({ managerVersion: MANAGER_VERSION, nodes: [node] }),
		).toMatchObject({
			status: "out-of-sync",
			problems: expect.arrayContaining([
				{
					reason: "stale",
					name: node.id,
					expected: node.version,
					actual: null,
				},
			]),
		});
	});

	test("verifies only the root commit without inspecting Git submodule state", async () => {
		const directory = join(ROOT, "custom_nodes", "comfyui-obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		await writeGitHubNode(directory);
		const { commit, source, submoduleDirectory } = await addSubmodule(directory);
		await writeFile(join(source, "dependency.py"), "next dependency\n");
		await gitTest(source, "add", "dependency.py");
		await gitTest(source, "commit", "-m", "update dependency");
		const divergentCommit = (await gitTest(source, "rev-parse", "HEAD")).trim();
		await gitTest(submoduleDirectory, "fetch", "origin", divergentCommit);
		await gitTest(submoduleDirectory, "checkout", "--detach", divergentCommit);
		await writeFile(
			join(submoduleDirectory, "dependency.py"),
			"local dependency change\n",
		);
		const node = githubNode(commit);
		await writeInstallations(node);
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				commands.push(command);
				return command[0] === "git" ? runCommand(command, options) : "";
			},
		});
		expect(
			await provisioner.verify({ managerVersion: MANAGER_VERSION, nodes: [node] }),
		).toEqual({ status: "synced", total: 1 });
		expect(commands.some((command) => command.includes("submodule"))).toBe(false);
	});

	test("ignores excluded Worker GitHub files during verification", async () => {
		const directory = join(ROOT, "custom_nodes", "comfyui-obvpm");
		await mkdir(join(ROOT, "backend"), { recursive: true });
		await writeGitHubNode(directory);
		await writeFile(join(directory, ".gitignore"), "local-config.py\n");
		await gitTest(directory, "add", ".gitignore");
		await gitTest(directory, "commit", "-m", "ignore local config");
		const commit = (await gitTest(directory, "rev-parse", "HEAD")).trim();
		await writeFile(join(directory, "local-config.py"), "LOCAL_SETTING = True\n");
		const node = githubNode(commit);
		await writeInstallations(node);
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) =>
				command[0] === "git" ? runCommand(command, options) : "",
		});

		expect(
			await provisioner.verify({ managerVersion: MANAGER_VERSION, nodes: [node] }),
		).toEqual({ status: "synced", total: 1 });
	});

	test("requires a ready backend and rejects invalid or duplicate targets", () => {
		const notReady = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: backend({ status: "not-installed", runtime: workerRuntime }),
			logs: new ServerLogStore(),
		});
		expect(() => notReady.sync({ managerVersion: MANAGER_VERSION, nodes: [] })).toThrow(
			"Prepare the Worker ComfyUI backend",
		);

		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
		});
		for (const request of [
			{ managerVersion: "latest", nodes: [] },
			{
				managerVersion: MANAGER_VERSION,
				nodes: [{ id: "bad@id", version: "1.0.0" }],
			},
			{
				managerVersion: MANAGER_VERSION,
				nodes: [{ id: "good-id", version: "nightly" }],
			},
			{
				managerVersion: MANAGER_VERSION,
				nodes: [
					{ id: "same-id", version: "1.0.0" },
					{ id: "same-id", version: "1.1.0" },
				],
			},
			{
				managerVersion: MANAGER_VERSION,
				nodes: [
					{
						id: "owner-a/repository",
						version: "a".repeat(40),
						repository: "https://github.com/owner-a/repository.git",
					},
					{
						id: "owner-b/repository",
						version: "b".repeat(40),
						repository: "https://github.com/owner-b/repository.git",
					},
				],
			},
			{
				managerVersion: MANAGER_VERSION,
				nodes: [
					{
						id: "owner/repository",
						version: "a".repeat(40),
						repository: "https://github.com/other/repository.git",
					},
				],
			},
			{
				managerVersion: MANAGER_VERSION,
				nodes: [
					{
						id: "owner/repository",
						version: "latest",
						repository: "https://github.com/owner/repository.git",
					},
				],
			},
		]) {
			expect(() => provisioner.sync(request)).toThrow(CustomNodeSyncError);
		}
		expect(() =>
			provisioner.reinstall({ managerVersion: MANAGER_VERSION, nodes: [] }),
		).toThrow("exactly one custom node");
		expect(() =>
			provisioner.reinstall({
				managerVersion: MANAGER_VERSION,
				nodes: [
					{ id: "first-node", version: "1.0.0" },
					{ id: "second-node", version: "2.0.0" },
				],
			}),
		).toThrow("exactly one custom node");
	});

	test("serializes synchronization", async () => {
		const nodes = [{ id: "comfyui-kjnodes", version: "1.5.0" }];
		let releaseInstall: (() => void) | undefined;
		const installGate = new Promise<void>((resolve) => {
			releaseInstall = resolve;
		});
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				await installGate;
				return fakeManagerCommand(command);
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes,
		});
		expect(() =>
			provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [] }),
		).toThrow("already synchronizing");
		releaseInstall?.();
		await waitForState(provisioner, "ready");
		expect(provisioner.getState()).toMatchObject({
			status: "ready",
			nodes,
		});
		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [] });
		await waitForState(provisioner, "ready");
	});

	test("cancels an active install and recovers it on retry", async () => {
		const node = { id: "cancel-node", version: "1.0.0" };
		let blockInstall = true;
		let markInstallStarted: (() => void) | null = null;
		const installStarted = new Promise<void>((resolve) => {
			markInstallStarted = resolve;
		});
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				if (command[3] === "install" && blockInstall) {
					markInstallStarted?.();
					await new Promise<void>((_resolve, reject) => {
						options.signal.addEventListener(
							"abort",
							() => reject(options.signal.reason),
							{ once: true },
						);
					});
				}
				return fakeManagerCommand(command);
			},
		});

		const running = provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [node],
		});
		await installStarted;
		expect(() => provisioner.cancel("superseded-operation")).toThrow(
			"no longer current",
		);
		expect(provisioner.getState()).toMatchObject({ status: "syncing" });
		if (running.status !== "syncing") throw new Error("Expected an active operation.");
		expect(provisioner.cancel(running.operationId)).toMatchObject({
			status: "canceling",
			operationId: running.operationId,
		});
		expect(() =>
			provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [node] }),
		).toThrow("already synchronizing");
		await waitForState(provisioner, "canceled");
		const canceled = provisioner.getState();
		expect(provisioner.getState()).toMatchObject({
			status: "canceled",
			nodes: [],
		});
		expect(provisioner.cancel()).toEqual(canceled);
		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({
			managerVersion: MANAGER_VERSION,
			confirmedNodes: [],
		});

		const restartCommands: string[][] = [];
		const restarted = await CustomNodeProvisioner.create({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				restartCommands.push(command);
				return fakeManagerCommand(command);
			},
		});
		expect(restarted.getState()).toMatchObject({ status: "idle", nodes: [] });
		expect(restartCommands.some((command) => command[3] === "disable")).toBe(false);
		expect(restartCommands.some((command) => command[3] === "install")).toBe(false);

		blockInstall = false;
		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [node] });
		await waitForState(provisioner, "ready");
	});

	test("skips matching confirmed nodes without reinstalling or repairing them", async () => {
		const nodes = [
			{ id: "existing-node", version: "1.0.0" },
			{ id: "other-existing-node", version: "2.0.0" },
		];
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return fakeManagerCommand(command);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes });
		await waitForState(provisioner, "ready");
		commands.length = 0;
		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes });
		await waitForState(provisioner, "ready");

		expect(commands.map((command) => command[3])).toEqual(["--python"]);
	});

	test("force reinstalls one confirmed node and preserves other confirmations", async () => {
		const target = { id: "existing-node", version: "1.0.0" };
		const other = { id: "other-existing-node", version: "2.0.0" };
		const commands: string[][] = [];
		let holdReinstallCommands = false;
		let releaseUninstall: (() => void) | undefined;
		let releaseInstall: (() => void) | undefined;
		const uninstallGate = new Promise<void>((resolve) => {
			releaseUninstall = resolve;
		});
		const installGate = new Promise<void>((resolve) => {
			releaseInstall = resolve;
		});
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				if (holdReinstallCommands && managerAction(command) === "uninstall") {
					await uninstallGate;
				}
				if (holdReinstallCommands && managerAction(command) === "install") {
					await installGate;
				}
				return fakeManagerCommand(command);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [target, other] });
		await waitForState(provisioner, "ready");
		const staleFile = join(ROOT, "custom_nodes", target.id, "stale.py");
		await writeFile(staleFile, "remove me\n");
		commands.length = 0;
		holdReinstallCommands = true;
		const started = provisioner.reinstall({
			managerVersion: MANAGER_VERSION,
			nodes: [target],
		});

		expect(started).toMatchObject({
			capabilities: { forceReinstall: true },
			operationKind: "reinstall",
			target: { managerVersion: MANAGER_VERSION, nodes: [target] },
			status: "syncing",
			reinstallPhase: "prepare",
		});
		await waitForCondition(() =>
			commands.some((command) => managerAction(command) === "uninstall"),
		);
		expect(provisioner.getState()).toMatchObject({
			status: "syncing",
			reinstallPhase: "remove",
		});
		releaseUninstall?.();
		await waitForCondition(() =>
			commands.some((command) => managerAction(command) === "install"),
		);
		expect(provisioner.getState()).toMatchObject({
			status: "syncing",
			reinstallPhase: "install",
		});
		releaseInstall?.();
		await waitForState(provisioner, "ready");
		holdReinstallCommands = false;
		expect(provisioner.getState()).toMatchObject({
			operationKind: "reinstall",
			status: "ready",
			nodes: [target],
		});
		expect(commands.map(managerAction)).toEqual(["--python", "uninstall", "install"]);
		expect(commands[1]?.slice(0, 3)).toEqual([
			RUNTIME_PYTHON,
			"-c",
			expect.stringContaining("cmd_ctx.set_user_directory"),
		]);
		expect(commands[1]?.[2]).toContain("unified_manager.purge_node_state");
		expect(commands[1]?.[3]).toBe(join(ROOT, ".kastard", "comfyui-manager"));
		expect(commands[1]?.[4]).toBe(`${target.id}@${target.version}`);
		expect(commands[1]).not.toContain("--user-directory");
		expect(commands[2]?.[4]).toBe(`${target.id}@${target.version}`);
		expect(commands[2]).toContain("--exit-on-fail");
		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({ managerVersion: MANAGER_VERSION, confirmedNodes: [other, target] });
		await expect(access(staleFile)).rejects.toThrow();
		await access(join(ROOT, "custom_nodes", other.id));

		const inactiveDirectory = join(ROOT, "custom_nodes", ".disabled", target.id);
		await mkdir(dirname(inactiveDirectory), { recursive: true });
		await rename(join(ROOT, "custom_nodes", target.id), inactiveDirectory);
		const inactiveStaleFile = join(inactiveDirectory, "inactive-stale.py");
		await writeFile(inactiveStaleFile, "remove me too\n");
		commands.length = 0;
		provisioner.reinstall({ managerVersion: MANAGER_VERSION, nodes: [target] });
		await waitForState(provisioner, "ready");

		expect(commands.map(managerAction)).toEqual(["--python", "uninstall", "install"]);
		await expect(access(inactiveStaleFile)).rejects.toThrow();
		await access(join(ROOT, "custom_nodes", target.id));
		await access(join(ROOT, "custom_nodes", other.id));

		await rm(join(ROOT, "custom_nodes", target.id), { recursive: true, force: true });
		const unknownDirectory = join(ROOT, "custom_nodes", target.id);
		await mkdir(unknownDirectory);
		const unknownStaleFile = join(unknownDirectory, "unknown-stale.py");
		await writeFile(unknownStaleFile, "remove me as unknown\n");
		commands.length = 0;
		provisioner.reinstall({ managerVersion: MANAGER_VERSION, nodes: [target] });
		await waitForState(provisioner, "ready");

		expect(commands.map(managerAction)).toEqual(["--python", "uninstall", "install"]);
		await expect(access(unknownStaleFile)).rejects.toThrow();
		await access(join(ROOT, "custom_nodes", target.id));
		await access(join(ROOT, "custom_nodes", other.id));
	});

	test("does not install when force reinstall cannot remove the selected node", async () => {
		const target = { id: "existing-node", version: "1.0.0" };
		let failUninstall = false;
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				if (failUninstall && managerAction(command) === "uninstall") {
					return "ERROR: uninstall failed";
				}
				return fakeManagerCommand(command);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [target] });
		await waitForState(provisioner, "ready");
		commands.length = 0;
		failUninstall = true;
		provisioner.reinstall({ managerVersion: MANAGER_VERSION, nodes: [target] });
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			operationKind: "reinstall",
			status: "failed",
			error: expect.stringContaining(
				"Custom node reinstall did not complete: Could not remove existing-node for reinstall",
			),
		});
		expect(commands.map(managerAction)).toEqual(["--python", "uninstall"]);
		await access(join(ROOT, "custom_nodes", target.id));
	});

	test("removes one unselected Manager node and preserves other installations", async () => {
		const removed = { id: "remove-me", version: "1.0.0" };
		const selected = { id: "keep-me", version: "2.0.0" };
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				commands.push(command);
				return fakeManagerCommand(command, options);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [removed, selected] });
		await waitForState(provisioner, "ready");
		commands.length = 0;
		const started = provisioner.remove({
			managerVersion: MANAGER_VERSION,
			nodes: [selected],
			node: { name: removed.id, managerId: removed.id, version: removed.version },
		});

		expect(started).toMatchObject({
			capabilities: { remove: true },
			operationKind: "remove",
			removalNode: { name: removed.id },
			status: "syncing",
			phase: "remove",
			removalPhase: "prepare",
		});
		if (started.status !== "syncing") throw new Error("Expected an active operation.");
		expect(provisioner.cancel(started.operationId)).toMatchObject({
			operationKind: "remove",
			status: "syncing",
		});
		await waitForState(provisioner, "ready");
		expect(provisioner.getState()).toMatchObject({
			operationKind: "remove",
			status: "ready",
			nodes: [selected],
			nodeSnapshot: {
				targetNodes: [{ id: selected.id, status: "installed" }],
				activeNodes: [{ name: selected.id }],
			},
		});
		expect(commands.map(managerAction)).toEqual(["--python", "uninstall"]);
		await expect(access(join(ROOT, "custom_nodes", removed.id))).rejects.toThrow();
		await access(join(ROOT, "custom_nodes", selected.id));
		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({ managerVersion: MANAGER_VERSION, confirmedNodes: [selected] });
	});

	test("permanently removes manual Worker files, directories, and symlinks one at a time", async () => {
		const customNodesDirectory = join(ROOT, "custom_nodes");
		const manualFile = join(customNodesDirectory, "manual.py");
		const manualDirectory = join(customNodesDirectory, "manual-directory");
		const manualLink = join(customNodesDirectory, "manual-link");
		const manualLinkTarget = join(ROOT, "manual-link-target");
		const otherPath = join(ROOT, "custom_nodes", "other.py");
		await Promise.all([
			mkdir(manualDirectory, { recursive: true }),
			mkdir(manualLinkTarget, { recursive: true }),
		]);
		await Promise.all([
			writeFile(manualFile, "print('manual')\n"),
			writeFile(join(manualDirectory, "__init__.py"), "print('directory')\n"),
			writeFile(join(manualLinkTarget, "__init__.py"), "print('link target')\n"),
			writeFile(otherPath, "print('other')\n"),
		]);
		await symlink(manualLinkTarget, manualLink);
		const provisioner = await CustomNodeProvisioner.create({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});

		for (const name of ["manual.py", "manual-directory", "manual-link"]) {
			provisioner.remove({
				managerVersion: MANAGER_VERSION,
				nodes: [],
				node: { name, managerId: null, version: null },
			});
			await waitForState(provisioner, "ready");
			await expect(access(join(customNodesDirectory, name))).rejects.toThrow();
			await access(otherPath);
			await access(manualLinkTarget);
		}

		expect(provisioner.getState()).toMatchObject({
			operationKind: "remove",
			nodeSnapshot: { activeNodes: [{ name: "other.py" }] },
		});
	});

	test("removes one unselected Git custom node through Manager", async () => {
		const directory = join(ROOT, "custom_nodes", "comfyui-obvpm");
		const { secondCommit } = await writeGitHubNode(directory);
		const commands: string[][] = [];
		const provisioner = await CustomNodeProvisioner.create({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				if (managerAction(command) === "uninstall") {
					await rm(directory, { recursive: true, force: true });
				}
				return "";
			},
		});
		const node = {
			name: "comfyui-obvpm",
			managerId: null,
			version: secondCommit,
			repository: "https://github.com/obvpm/comfyui-obvpm.git",
		};

		provisioner.remove({
			managerVersion: MANAGER_VERSION,
			nodes: [],
			node,
		});
		await waitForState(provisioner, "ready");

		expect(commands.map(managerAction)).toEqual(["--python", "uninstall"]);
		await expect(access(directory)).rejects.toThrow();
		expect(provisioner.getState()).toMatchObject({
			operationKind: "remove",
			removalNode: node,
			nodeSnapshot: { activeNodes: [] },
		});
	});

	test("rejects selected and stale Worker custom node removals", async () => {
		const node = { id: "selected-node", version: "1.0.0" };
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});
		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [node] });
		await waitForState(provisioner, "ready");

		expect(() =>
			provisioner.remove({
				managerVersion: MANAGER_VERSION,
				nodes: [node],
				node: { name: node.id, managerId: node.id, version: node.version },
			}),
		).toThrow("Selected custom nodes cannot be removed");
		provisioner.remove({
			managerVersion: MANAGER_VERSION,
			nodes: [],
			node: { name: node.id, managerId: node.id, version: "2.0.0" },
		});
		await waitForState(provisioner, "failed");
		expect(provisioner.getState()).toMatchObject({
			error: expect.stringContaining("no longer matches"),
			nodeSnapshot: { activeNodes: [{ name: node.id, version: node.version }] },
		});
		await access(join(ROOT, "custom_nodes", node.id));
	});

	test("preserves a removal target when selected nodes are not synchronized", async () => {
		const selected = { id: "selected-node", version: "1.0.0" };
		const removalPath = join(ROOT, "custom_nodes", "manual.py");
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});
		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [selected] });
		await waitForState(provisioner, "ready");
		await writeFile(removalPath, "print('manual')\n");
		await rm(join(ROOT, "custom_nodes", selected.id), {
			recursive: true,
			force: true,
		});

		provisioner.remove({
			managerVersion: MANAGER_VERSION,
			nodes: [selected],
			node: { name: "manual.py", managerId: null, version: null },
		});
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			operationKind: "remove",
			status: "failed",
			error: expect.stringContaining("Requested custom nodes are missing"),
		});
		await access(removalPath);
	});

	test("rejects removal when the same installation also has a disabled copy", async () => {
		const node = { id: "duplicate-node", version: "1.0.0" };
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});
		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [node] });
		await waitForState(provisioner, "ready");
		await mkdir(join(ROOT, "custom_nodes", `${node.id}.disabled`), { recursive: true });
		await writeFile(
			join(ROOT, "custom_nodes", `${node.id}.disabled`, "pyproject.toml"),
			`[project]\nname = "${node.id}"\nversion = "${node.version}"\n`,
		);

		provisioner.remove({
			managerVersion: MANAGER_VERSION,
			nodes: [],
			node: { name: node.id, managerId: node.id, version: node.version },
		});
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			error: expect.stringContaining("duplicate installations"),
		});
		await access(join(ROOT, "custom_nodes", node.id));
		await access(join(ROOT, "custom_nodes", `${node.id}.disabled`));
	});

	test("leaves the selected node absent when its fresh install fails", async () => {
		const target = { id: "existing-node", version: "1.0.0" };
		const other = { id: "other-existing-node", version: "2.0.0" };
		let failInstall = false;
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				if (failInstall && command[3] === "install") {
					return "ERROR: dependency installation failed";
				}
				return fakeManagerCommand(command);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [target, other] });
		await waitForState(provisioner, "ready");
		failInstall = true;
		provisioner.reinstall({ managerVersion: MANAGER_VERSION, nodes: [target] });
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			operationKind: "reinstall",
			status: "failed",
			nodes: [{ name: other.id, managerId: other.id, version: other.version }],
		});
		await expect(access(join(ROOT, "custom_nodes", target.id))).rejects.toThrow();
		await access(join(ROOT, "custom_nodes", other.id));
		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({ managerVersion: MANAGER_VERSION, confirmedNodes: [other] });
	});

	test("leaves the selected node absent when force reinstall is canceled", async () => {
		const target = { id: "existing-node", version: "1.0.0" };
		let blockInstall = false;
		let markInstallStarted: (() => void) | undefined;
		const installStarted = new Promise<void>((resolve) => {
			markInstallStarted = resolve;
		});
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command, options) => {
				if (blockInstall && command[3] === "install") {
					markInstallStarted?.();
					await new Promise<void>((_resolve, reject) => {
						options.signal.addEventListener(
							"abort",
							() => reject(options.signal.reason),
							{ once: true },
						);
					});
				}
				return fakeManagerCommand(command);
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [target] });
		await waitForState(provisioner, "ready");
		blockInstall = true;
		const running = provisioner.reinstall({
			managerVersion: MANAGER_VERSION,
			nodes: [target],
		});
		await installStarted;
		if (running.status !== "syncing") throw new Error("Expected an active operation.");
		provisioner.cancel(running.operationId);
		await waitForState(provisioner, "canceled");

		expect(provisioner.getState()).toMatchObject({
			operationKind: "reinstall",
			status: "canceled",
			nodes: [],
		});
		await expect(access(join(ROOT, "custom_nodes", target.id))).rejects.toThrow();
	});

	test("installs new nodes without changing confirmed or omitted nodes", async () => {
		const omittedNode = { id: "omitted-node", version: "1.0.0" };
		const reusableNode = { id: "reusable-node", version: "2.0.0" };
		const newNode = { id: "new-node", version: "3.0.0" };
		const first = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});
		first.sync({ managerVersion: MANAGER_VERSION, nodes: [omittedNode, reusableNode] });
		await waitForState(first, "ready");

		const commands: string[][] = [];
		const second = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return fakeManagerCommand(command);
			},
		});
		second.sync({ managerVersion: MANAGER_VERSION, nodes: [reusableNode, newNode] });
		await waitForState(second, "ready");

		expect(commands.map((command) => command[3])).toEqual(["--python", "install"]);
		expect(
			commands
				.filter((command) => command[3] !== "--python")
				.every((command) => command.includes("cache")),
		).toBe(true);
		expect(commands[1]?.[4]).toBe(`${newNode.id}@${newNode.version}`);
		await access(join(ROOT, "custom_nodes", omittedNode.id));
	});

	test("records empty confirmed installations as synchronized", async () => {
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});

		expect(
			provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [] }),
		).toMatchObject({
			status: "syncing",
			total: 0,
		});
		await waitForState(provisioner, "ready");
		expect(provisioner.getState()).toMatchObject({ status: "ready", nodes: [] });
	});

	test("reads a cumulative installation record larger than one sync request", async () => {
		const managerDirectory = join(ROOT, ".kastard", "comfyui-manager");
		const confirmedNodes = Array.from({ length: 251 }, (_, index) => ({
			id: `confirmed-node-${index}`,
			version: "1.0.0",
		}));
		await mkdir(managerDirectory, { recursive: true });
		await writeFile(
			join(managerDirectory, "custom-node-installations.json"),
			`${JSON.stringify({ managerVersion: MANAGER_VERSION, confirmedNodes })}\n`,
		);
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [] });
		await waitForState(provisioner, "ready");
		expect(
			JSON.parse(
				await readFile(
					join(managerDirectory, "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({ managerVersion: MANAGER_VERSION, confirmedNodes: [] });
	});

	test("rejects invalid confirmed installation records", async () => {
		const managerDirectory = join(ROOT, ".kastard", "comfyui-manager");
		await mkdir(managerDirectory, { recursive: true });
		await writeFile(
			join(managerDirectory, "custom-node-installations.json"),
			`${JSON.stringify({
				managerVersion: MANAGER_VERSION,
				confirmedNodes: "invalid",
			})}\n`,
		);
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});

		expect(
			await provisioner.verify({ managerVersion: MANAGER_VERSION, nodes: [] }),
		).toEqual({
			status: "unavailable",
			error: "Could not inspect active Worker custom nodes.",
		});
	});

	test("exposes active nodes before the backend is prepared", async () => {
		await mkdir(join(ROOT, "custom_nodes", "manual-node"), { recursive: true });
		const provisioner = await CustomNodeProvisioner.create({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: backend({ status: "not-installed", runtime: workerRuntime }),
			logs: new ServerLogStore(),
			runCommand: async () => "",
		});

		expect(provisioner.getState()).toMatchObject({
			status: "idle",
			nodes: [{ name: "manual-node", managerId: null, version: null }],
		});
	});

	test("does not resume confirmed installations after a worker restart", async () => {
		const nodes = [{ id: "restored-node", version: "1.2.3" }];
		const first = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});
		first.sync({ managerVersion: MANAGER_VERSION, nodes });
		await waitForState(first, "ready");

		const commands: string[][] = [];
		const restored = await CustomNodeProvisioner.create({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return fakeManagerCommand(command);
			},
		});

		expect(restored.getState()).toMatchObject({
			status: "idle",
			target: null,
			nodes: [
				{
					name: "restored-node",
					managerId: "restored-node",
					version: "1.2.3",
				},
			],
		});
		expect(commands).toEqual([]);
	});

	test("leaves nodes omitted from the next Editor target active", async () => {
		const omittedNodes = [
			{ id: "old-node", version: "1.0.0" },
			{ id: "other-old-node", version: "2.0.0" },
		];
		const first = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});
		first.sync({
			managerVersion: MANAGER_VERSION,
			nodes: omittedNodes,
		});
		await waitForState(first, "ready");

		const commands: string[][] = [];
		const second = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return fakeManagerCommand(command);
			},
		});
		second.sync({ managerVersion: MANAGER_VERSION, nodes: [] });
		await waitForState(second, "ready");

		expect(commands).toHaveLength(1);
		expect(commands.some((command) => command[3] === "disable")).toBe(false);
		for (const node of omittedNodes) {
			await access(join(ROOT, "custom_nodes", node.id));
		}
		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({
			managerVersion: MANAGER_VERSION,
			confirmedNodes: omittedNodes,
		});
	});

	test("reports the actual active inventory after a partially applied sync fails", async () => {
		const first = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: fakeManagerCommand,
		});
		first.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [{ id: "old-node", version: "1.0.0" }],
		});
		await waitForState(first, "ready");

		const failed = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				if (command[3] === "install") throw new Error("New node install failed.");
				return fakeManagerCommand(command);
			},
		});
		failed.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [{ id: "new-node", version: "2.0.0" }],
		});
		await waitForState(failed, "failed");

		expect(failed.getState()).toMatchObject({
			status: "failed",
			nodes: [
				{
					name: "old-node",
					managerId: "old-node",
					version: "1.0.0",
				},
			],
			error: expect.stringContaining("new-node: New node install failed."),
		});
	});

	test("reports an unknown inventory when active nodes cannot be read", async () => {
		await mkdir(ROOT, { recursive: true });
		await writeFile(join(ROOT, "custom_nodes"), "not a directory\n");
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async () => "",
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [] });
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			nodes: null,
		});
	});

	test("retains the last observed inventory when a later read fails", async () => {
		const existingNode = { id: "existing-node", version: "1.0.0" };
		const requestedNode = { id: "requested-node", version: "2.0.0" };
		await writeTrackedNode(ROOT, existingNode.id, existingNode.version);
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				if (command[3] === "install") {
					await rm(join(ROOT, "custom_nodes"), { recursive: true, force: true });
					await writeFile(join(ROOT, "custom_nodes"), "not a directory\n");
				}
				return "";
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [requestedNode] });
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			nodes: [
				{
					name: existingNode.id,
					managerId: existingNode.id,
					version: existingNode.version,
				},
			],
			nodeSnapshot: {
				activeNodes: [
					{
						name: existingNode.id,
						managerId: existingNode.id,
						version: existingNode.version,
					},
				],
			},
		});
	});

	test("reconciles a partially installed batch even when Manager reports success", async () => {
		const installedNode = { id: "installed-node", version: "1.0.0" };
		const missingNode = { id: "missing-node", version: "2.0.0" };
		const nodes = [installedNode, missingNode];
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				if (command[3] === "install") {
					await writeTrackedNode(ROOT, installedNode.id, installedNode.version);
				}
				return "";
			},
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes });
		await waitForState(provisioner, "failed");

		expect(commands.filter((command) => command[3] === "install")).toHaveLength(2);
		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			nodes: [
				{
					name: installedNode.id,
					managerId: installedNode.id,
					version: installedNode.version,
				},
			],
			error: expect.stringContaining("missing-node (expected 2.0.0, found missing)"),
		});
		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({
			managerVersion: MANAGER_VERSION,
			confirmedNodes: [installedNode],
		});
	});

	test("retries an unconfirmed partial install on the next Editor sync", async () => {
		const partialNode = { id: "partial-node", version: "1.0.0" };
		const failed = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				if (command[3] === "install") {
					await writeTrackedNode(ROOT, partialNode.id, partialNode.version);
					throw new Error("Install failed after creating node files.");
				}
				return "";
			},
		});
		failed.sync({ managerVersion: MANAGER_VERSION, nodes: [partialNode] });
		await waitForState(failed, "failed");

		expect(
			JSON.parse(
				await readFile(
					join(ROOT, ".kastard", "comfyui-manager", "custom-node-installations.json"),
					"utf8",
				),
			),
		).toEqual({
			managerVersion: MANAGER_VERSION,
			confirmedNodes: [],
		});

		const commands: string[][] = [];
		const restarted = await CustomNodeProvisioner.create({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return fakeManagerCommand(command);
			},
		});

		expect(restarted.getState()).toMatchObject({ status: "idle" });
		expect(commands).toEqual([]);
		restarted.sync({ managerVersion: MANAGER_VERSION, nodes: [partialNode] });
		await waitForState(restarted, "ready");
		expect(commands[1]?.slice(0, 5)).toEqual([
			RUNTIME_PYTHON,
			"-m",
			"cm_cli",
			"disable",
			"partial-node@1.0.0",
		]);
		expect(commands[2]?.slice(0, 5)).toEqual([
			RUNTIME_PYTHON,
			"-m",
			"cm_cli",
			"install",
			"partial-node@1.0.0",
		]);
	});

	test("leaves a successful install unconfirmed when recording completion fails", async () => {
		const installedNode = { id: "unrecorded-node", version: "1.0.0" };
		const managerDirectory = join(ROOT, ".kastard", "comfyui-manager");
		const installationPath = join(managerDirectory, "custom-node-installations.json");
		const failed = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				const output = await fakeManagerCommand(command);
				if (command[3] === "install") await mkdir(`${installationPath}.tmp`);
				return output;
			},
		});
		failed.sync({ managerVersion: MANAGER_VERSION, nodes: [installedNode] });
		await waitForState(failed, "failed");

		expect(JSON.parse(await readFile(installationPath, "utf8"))).toEqual({
			managerVersion: MANAGER_VERSION,
			confirmedNodes: [],
		});
		await rm(`${installationPath}.tmp`, { recursive: true });

		const commands: string[][] = [];
		const restarted = await CustomNodeProvisioner.create({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return fakeManagerCommand(command);
			},
		});

		expect(restarted.getState()).toMatchObject({ status: "idle" });
		expect(commands).toEqual([]);
		restarted.sync({ managerVersion: MANAGER_VERSION, nodes: [installedNode] });
		await waitForState(restarted, "ready");
		expect(commands[1]?.slice(0, 5)).toEqual([
			RUNTIME_PYTHON,
			"-m",
			"cm_cli",
			"disable",
			"unrecorded-node@1.0.0",
		]);
		expect(commands[2]?.slice(0, 5)).toEqual([
			RUNTIME_PYTHON,
			"-m",
			"cm_cli",
			"install",
			"unrecorded-node@1.0.0",
		]);
	});

	test("allows ready while unrequested active custom nodes remain", async () => {
		await mkdir(join(ROOT, "custom_nodes", "manual-node"), { recursive: true });
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async () => "",
		});

		provisioner.sync({ managerVersion: MANAGER_VERSION, nodes: [] });
		await waitForState(provisioner, "ready");

		expect(provisioner.getState()).toMatchObject({
			status: "ready",
			nodes: [],
			nodeSnapshot: {
				targetNodes: [],
				activeNodes: [{ name: "manual-node", managerId: null, version: null }],
			},
		});
	});

	test("reinstalls an active requested node with a normalized Manager target", async () => {
		const node = { id: "ComfyUI-DaSiWa-Nodes", version: "0.4.20" };
		await writeTrackedNode(ROOT, node.id, node.version, "renamed-directory");
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return fakeManagerCommand(command);
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [node],
		});
		await waitForState(provisioner, "ready");

		expect(provisioner.getState()).toMatchObject({
			status: "ready",
			nodes: [node],
		});
		expect(commands.map((command) => command[3])).toEqual([
			"--python",
			"disable",
			"install",
		]);
		expect(commands[1]?.[4]).toBe("comfyui-dasiwa-nodes@0.4.20");
		expect(commands.some((command) => command[3] === "fix")).toBe(false);
	});

	test("refuses ready when a requested node is missing", async () => {
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async () => "",
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [{ id: "missing-node", version: "1.0.0" }],
		});
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining("missing-node (expected 1.0.0, found missing)"),
		});
	});

	test("replaces an installed node when its version differs from the request", async () => {
		await writeTrackedNode(ROOT, "selected-node", "0.9.0");
		const commands: string[][] = [];
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return fakeManagerCommand(command);
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [{ id: "selected-node", version: "1.0.0" }],
		});
		await waitForState(provisioner, "ready");

		expect(provisioner.getState()).toMatchObject({
			status: "ready",
			nodes: [{ id: "selected-node", version: "1.0.0" }],
		});
		expect(commands[1]?.slice(3, 5)).toEqual(["disable", "selected-node@0.9.0"]);
		expect(commands[2]?.slice(3, 5)).toEqual(["install", "selected-node@1.0.0"]);
	});

	test("rejects duplicate Manager installations before force reinstall deletion", async () => {
		const directories = ["first-directory", "second-directory"];
		const commands: string[][] = [];
		await Promise.all(
			directories.map((name) => writeTrackedNode(ROOT, "selected-node", "1.0.0", name)),
		);
		const provisioner = new CustomNodeProvisioner({
			rootDirectory: ROOT,
			runtimePython: RUNTIME_PYTHON,
			backend: readyBackend(),
			logs: new ServerLogStore(),
			runCommand: async (command) => {
				commands.push(command);
				return "";
			},
		});

		provisioner.sync({
			managerVersion: MANAGER_VERSION,
			nodes: [{ id: "selected-node", version: "1.0.0" }],
		});
		await waitForState(provisioner, "failed");

		expect(provisioner.getState()).toMatchObject({
			status: "failed",
			error: expect.stringContaining("Duplicate active custom node ID: selected-node"),
		});

		const disabledDirectory = join(ROOT, "custom_nodes", ".disabled");
		await mkdir(disabledDirectory, { recursive: true });
		await rename(
			join(ROOT, "custom_nodes", "second-directory"),
			join(disabledDirectory, "second-directory"),
		);
		commands.length = 0;
		provisioner.reinstall({
			managerVersion: MANAGER_VERSION,
			nodes: [{ id: "selected-node", version: "1.0.0" }],
		});
		await waitForState(provisioner, "failed");
		expect(provisioner.getState()).toMatchObject({
			error: expect.stringContaining("Remove the duplicate before reinstalling"),
		});
		expect(commands.some((command) => managerAction(command) === "uninstall")).toBe(
			false,
		);
	});

	test("configures the worker custom_nodes directory as Manager's default", async () => {
		const root = await mkdtemp(join(tmpdir(), "kastard-custom-node-manager-"));
		try {
			const provisioner = new CustomNodeProvisioner({
				rootDirectory: root,
				runtimePython: RUNTIME_PYTHON,
				backend: readyBackend(),
				logs: new ServerLogStore(),
				runCommand: fakeManagerCommand,
			});

			provisioner.sync({
				managerVersion: MANAGER_VERSION,
				nodes: [{ id: "comfyui-kjnodes", version: "1.5.0" }],
			});
			await waitForState(provisioner, "ready");
			expect(
				await readFile(
					join(root, ".kastard", "comfyui-manager", "extra_model_paths.yaml"),
					"utf8",
				),
			).toBe(
				[
					"kastard:",
					`  base_path: ${JSON.stringify(root)}`,
					"  is_default: true",
					"  custom_nodes: custom_nodes",
					"",
				].join("\n"),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

async function fakeManagerCommand(
	command: string[],
	options?: { cwd: string },
): Promise<string> {
	const rootDirectory = options === undefined ? ROOT : dirname(options.cwd);
	const action = managerAction(command);
	const optionIndex = command.findIndex(
		(argument, index) => index >= 4 && argument.startsWith("--"),
	);
	const targets =
		action === "uninstall" && command[1] === "-c"
			? command.slice(4)
			: command.slice(4, optionIndex < 0 ? undefined : optionIndex);
	if (action === "install") {
		for (const target of targets) {
			const separator = target.lastIndexOf("@");
			if (separator < 1) throw new Error(`Invalid fake Manager target: ${target}`);
			const managerId = target.slice(0, separator);
			const version = target.slice(separator + 1);
			const inactive = (await fakeManagerEntries(rootDirectory)).find(
				(entry) =>
					entry.inactive &&
					entry.managerId.toLowerCase() === managerId.toLowerCase() &&
					entry.version === version,
			);
			if (inactive === undefined) {
				await writeTrackedNode(rootDirectory, managerId, version);
			} else {
				await rename(
					inactive.path,
					join(rootDirectory, "custom_nodes", inactive.directoryName),
				);
			}
		}
	}
	if (action === "disable") {
		for (const target of targets) {
			const separator = target.lastIndexOf("@");
			const managerId = separator < 1 ? target : target.slice(0, separator);
			const disabledDirectory = join(rootDirectory, "custom_nodes", ".disabled");
			await mkdir(disabledDirectory, { recursive: true });
			for (const entry of await fakeManagerEntries(rootDirectory)) {
				if (
					entry.inactive ||
					entry.managerId.toLowerCase() !== managerId.toLowerCase()
				) {
					continue;
				}
				await rename(entry.path, join(disabledDirectory, entry.directoryName));
			}
		}
	}
	if (action === "enable") {
		for (const target of targets) {
			const separator = target.lastIndexOf("@");
			const managerId = separator < 1 ? target : target.slice(0, separator);
			for (const entry of await fakeManagerEntries(rootDirectory)) {
				if (
					!entry.inactive ||
					(entry.managerId.toLowerCase() !== managerId.toLowerCase() &&
						entry.directoryName.toLowerCase() !== managerId.toLowerCase())
				) {
					continue;
				}
				await rename(
					entry.path,
					join(rootDirectory, "custom_nodes", entry.directoryName),
				);
			}
		}
	}
	if (action === "uninstall") {
		for (const target of targets) {
			const separator = target.lastIndexOf("@");
			const managerId = separator < 1 ? target : target.slice(0, separator);
			for (const entry of await fakeManagerEntries(rootDirectory)) {
				if (
					entry.managerId.toLowerCase() !== managerId.toLowerCase() &&
					entry.directoryName.toLowerCase() !== managerId.toLowerCase()
				) {
					continue;
				}
				await rm(entry.path, { recursive: true, force: true });
			}
			if (command[2]?.includes("purge_node_state")) {
				await Promise.all([
					rm(join(rootDirectory, "custom_nodes", managerId), {
						recursive: true,
						force: true,
					}),
					rm(join(rootDirectory, "custom_nodes", ".disabled", managerId), {
						recursive: true,
						force: true,
					}),
				]);
			}
		}
	}
	return "";
}

function managerAction(command: string[]): string | undefined {
	return command[1] === "-c" ? "uninstall" : command[3];
}

async function fakeManagerEntries(rootDirectory: string): Promise<
	Array<{
		directoryName: string;
		inactive: boolean;
		managerId: string;
		path: string;
		version: string;
	}>
> {
	const customNodesDirectory = join(rootDirectory, "custom_nodes");
	const disabledDirectory = join(customNodesDirectory, ".disabled");
	const [activeEntries, inactiveEntries] = await Promise.all([
		readdir(customNodesDirectory, { withFileTypes: true }).catch(() => []),
		readdir(disabledDirectory, { withFileTypes: true }).catch(() => []),
	]);
	const entries = activeEntries
		.filter((entry) => entry.isDirectory() && entry.name !== ".disabled")
		.map((entry) => ({ entry, inactive: false, parent: customNodesDirectory }))
		.concat(
			inactiveEntries
				.filter((entry) => entry.isDirectory())
				.map((entry) => ({ entry, inactive: true, parent: disabledDirectory })),
		);
	const result = [];
	for (const { entry, inactive, parent } of entries) {
		try {
			const metadata: unknown = Bun.TOML.parse(
				await readFile(join(parent, entry.name, "pyproject.toml"), "utf8"),
			);
			if (
				typeof metadata !== "object" ||
				metadata === null ||
				!("project" in metadata) ||
				typeof metadata.project !== "object" ||
				metadata.project === null ||
				!("name" in metadata.project) ||
				typeof metadata.project.name !== "string" ||
				!("version" in metadata.project) ||
				typeof metadata.project.version !== "string"
			) {
				continue;
			}
			result.push({
				directoryName: entry.name,
				inactive,
				managerId: metadata.project.name,
				path: join(parent, entry.name),
				version: metadata.project.version,
			});
		} catch {}
	}
	return result;
}

async function writeTrackedNode(
	rootDirectory: string,
	managerId: string,
	version: string,
	directoryName = managerId,
): Promise<void> {
	const directory = join(rootDirectory, "custom_nodes", directoryName);
	await mkdir(directory, { recursive: true });
	await Promise.all([
		writeFile(join(directory, ".tracking"), "__init__.py\n"),
		writeFile(
			join(directory, "pyproject.toml"),
			`[project]\nname = ${JSON.stringify(managerId)}\nversion = ${JSON.stringify(version)}\n`,
		),
	]);
}

function githubNode(version: string) {
	return {
		id: "obvpm/comfyui-obvpm",
		version,
		repository: "https://github.com/obvpm/comfyui-obvpm.git",
	};
}

async function writeInstallations(node: ReturnType<typeof githubNode>): Promise<void> {
	const directory = join(ROOT, ".kastard", "comfyui-manager");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "custom-node-installations.json"),
		`${JSON.stringify({
			managerVersion: MANAGER_VERSION,
			confirmedNodes: [node],
		})}\n`,
	);
}

async function writeGitHubNode(
	directory: string,
): Promise<{ firstCommit: string; secondCommit: string }> {
	await mkdir(directory, { recursive: true });
	await gitTest(directory, "init");
	await writeFile(join(directory, "__init__.py"), "first revision\n");
	await gitTest(directory, "add", "__init__.py");
	await gitTest(directory, "commit", "-m", "first");
	const firstCommit = (await gitTest(directory, "rev-parse", "HEAD")).trim();
	await writeFile(join(directory, "__init__.py"), "second revision\n");
	await gitTest(directory, "add", "__init__.py");
	await gitTest(directory, "commit", "-m", "second");
	const secondCommit = (await gitTest(directory, "rev-parse", "HEAD")).trim();
	await gitTest(
		directory,
		"remote",
		"add",
		"origin",
		"https://github.com/obvpm/comfyui-obvpm.git",
	);
	return { firstCommit, secondCommit };
}

async function addSubmodule(
	directory: string,
): Promise<{ commit: string; source: string; submoduleDirectory: string }> {
	const source = join(ROOT, "submodule-source");
	const submoduleDirectory = join(directory, "dependency");
	await mkdir(source, { recursive: true });
	await gitTest(source, "init");
	await writeFile(join(source, "dependency.py"), "clean dependency\n");
	await gitTest(source, "add", "dependency.py");
	await gitTest(source, "commit", "-m", "add dependency");
	await gitTest(
		directory,
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		source,
		"dependency",
	);
	await gitTest(directory, "add", ".gitmodules", "dependency");
	await gitTest(directory, "commit", "-m", "add dependency");
	return {
		commit: (await gitTest(directory, "rev-parse", "HEAD")).trim(),
		source,
		submoduleDirectory,
	};
}

function gitTest(directory: string, ...args: string[]): Promise<string> {
	return runCommand(["git", "--no-optional-locks", "-C", directory, ...args], {
		cwd: directory,
		env: {
			PATH: process.env.PATH,
			GIT_AUTHOR_NAME: "Kastard Test",
			GIT_AUTHOR_EMAIL: "kastard@example.com",
			GIT_COMMITTER_NAME: "Kastard Test",
			GIT_COMMITTER_EMAIL: "kastard@example.com",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
		},
		timeoutMs: 2_000,
	});
}

const workerRuntime = {
	cudaVersion: "12.8",
	pythonVersion: "3.12.13",
	torchVersion: "2.11.0+cu128",
	torchvisionVersion: "0.26.0+cu128",
	torchaudioVersion: "2.11.0+cu128",
	uvVersion: "0.12.4",
};

function readyBackend(): BackendProvisionerApi {
	return backend({ status: "ready", version: "0.33.1", runtime: workerRuntime });
}

function backend(state: BackendState): BackendProvisionerApi {
	return {
		getState: () => state,
		prepare: () => state,
	};
}

async function waitForState(
	provisioner: CustomNodeProvisioner,
	status: CustomNodeSyncState["status"],
): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (provisioner.getState().status === status) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`Custom node provisioner did not reach ${status}: ${JSON.stringify(provisioner.getState())}`,
	);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Condition was not met before timeout.");
}
