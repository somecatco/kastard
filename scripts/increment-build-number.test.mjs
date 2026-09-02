import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBuildNumbers, incrementBuildNumbers } from "./increment-build-number.mjs";

const roots = [];
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRevision = "a".repeat(40);

function writeJson(root, path, value) {
	const fullPath = join(root, path);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture({ editor = "4", worker = "7" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "kastard-build-number-"));
	roots.push(root);
	writeJson(root, "apps/desktop/package.json", {
		build: { buildVersion: editor },
	});
	writeJson(root, "apps/server/package.json", {
		buildNumber: worker,
		version: "0.0.0",
	});
	return root;
}

function installWorkerImageScript(root, branch = "main") {
	const path = join(root, "scripts/worker-image.sh");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, readFileSync(join(scriptDirectory, "worker-image.sh"), "utf8"));
	const result = Bun.spawnSync(
		["git", "init", "--quiet", `--initial-branch=${branch}`],
		{
			cwd: root,
		},
	);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function installWorkerBuildTools(root, runtimeExists) {
	const bin = join(root, "bin");
	const log = join(root, "docker.log");
	mkdirSync(bin);
	const bun = join(bin, "bun");
	writeFileSync(
		bun,
		`#!/bin/sh
if [ "$1" = "-e" ]; then
	if [ -n "$4" ]; then
		printf 'nvidia/cuda:fixture\\t3.13.12'
	else
		printf '7'
	fi
elif [ "$2" = "--fingerprint" ]; then
	printf 'fixture%s\\n' "$3"
fi
`,
	);
	chmodSync(bun, 0o755);
	const docker = join(bin, "docker");
	writeFileSync(
		docker,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = "manifest" ] && [ "$2" = "inspect" ]; then
	if [ "$RUNTIME_EXISTS" = "true" ]; then exit 0; fi
	if [ "$RUNTIME_EXISTS" = "error" ]; then
		printf 'registry unavailable\\n' >&2
		exit 1
	fi
	printf 'manifest unknown\\n' >&2
	exit 1
fi
`,
	);
	chmodSync(docker, 0o755);
	return {
		...process.env,
		DOCKER_LOG: log,
		GITHUB_ACTIONS: "true",
		KASTARD_PRODUCT_VERSION: "0.2.0",
		KASTARD_SOURCE_REVISION: sourceRevision,
		PATH: `${bin}:${process.env.PATH}`,
		RUNTIME_EXISTS: String(runtimeExists),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("build number increment", () => {
	test("increments only the selected app", () => {
		const root = createFixture();

		expect(incrementBuildNumbers(root, "editor")).toEqual([
			{ name: "editor", originalBuildNumber: 4, nextBuildNumber: 5 },
		]);
		expect(checkBuildNumbers(root)).toEqual({ editor: 5, worker: 7 });
	});

	test("increments Editor and Worker together", () => {
		const root = createFixture();

		expect(incrementBuildNumbers(root, "all")).toEqual([
			{ name: "editor", originalBuildNumber: 4, nextBuildNumber: 5 },
			{ name: "worker", originalBuildNumber: 7, nextBuildNumber: 8 },
		]);
		expect(checkBuildNumbers(root)).toEqual({ editor: 5, worker: 8 });
	});

	test("validates both apps before changing an all-target increment", () => {
		const root = createFixture({ worker: "0" });
		const editorPath = join(root, "apps/desktop/package.json");
		const before = readFileSync(editorPath, "utf8");

		expect(() => incrementBuildNumbers(root, "all")).toThrow(
			"must contain a positive integer build number",
		);
		expect(readFileSync(editorPath, "utf8")).toBe(before);
	});

	test("validates one selected app independently", () => {
		const root = createFixture({ editor: "9007199254740992" });

		expect(() => checkBuildNumbers(root, "editor")).toThrow("safe integer range");
		expect(checkBuildNumbers(root, "worker")).toEqual({ worker: 7 });
	});

	test("rejects unsafe and unknown values without changing files", () => {
		const root = createFixture({ editor: "9007199254740991" });
		const editorPath = join(root, "apps/desktop/package.json");
		const before = readFileSync(editorPath, "utf8");

		expect(() => incrementBuildNumbers(root, "editor")).toThrow(
			"cannot be incremented safely",
		);
		expect(() => incrementBuildNumbers(root, "server")).toThrow("Unknown target");
		expect(readFileSync(editorPath, "utf8")).toBe(before);
	});

	test("rejects an unsafe Worker build number before resolving a Preview image", () => {
		const root = createFixture({ worker: "9007199254740992" });
		installWorkerImageScript(root);

		const result = Bun.spawnSync(
			["bash", "scripts/worker-image.sh", "--preview", "--print-images"],
			{ cwd: root },
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toContain("safe integer range");
	});

	test("resolves both explicit Worker runtime image tags from one Preview build", () => {
		const root = createFixture();
		installWorkerImageScript(root);

		const result = Bun.spawnSync(
			["bash", "scripts/worker-image.sh", "--preview", "--print-images"],
			{ cwd: root, env: { ...process.env, KASTARD_SOURCE_REVISION: sourceRevision } },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(result.stdout.toString()).toBe(
			"cu128\tsomecatco/kastard-worker-cu128:preview-build.7-aaaaaaa\n" +
				"cu130\tsomecatco/kastard-worker-cu130:preview-build.7-aaaaaaa\n",
		);
	});

	test("resolves one explicit Worker runtime for a matrix build", () => {
		const root = createFixture();
		installWorkerImageScript(root);

		const result = Bun.spawnSync(
			[
				"bash",
				"scripts/worker-image.sh",
				"--preview",
				"--runtime",
				"cu130",
				"--print-images",
			],
			{ cwd: root, env: { ...process.env, KASTARD_SOURCE_REVISION: sourceRevision } },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(result.stdout.toString()).toBe(
			"cu130\tsomecatco/kastard-worker-cu130:preview-build.7-aaaaaaa\n",
		);
	});

	test("rejects an unsupported Worker runtime", () => {
		const root = createFixture();
		installWorkerImageScript(root);

		const result = Bun.spawnSync(
			["bash", "scripts/worker-image.sh", "--runtime", "cpu", "--print-images"],
			{ cwd: root },
		);

		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("--runtime <cu128|cu130>");
	});

	test("resolves Production Worker images from the version and build number", () => {
		const root = createFixture();
		installWorkerImageScript(root);

		const result = Bun.spawnSync(
			["bash", "scripts/worker-image.sh", "--production", "--print-images"],
			{
				cwd: root,
				env: {
					...process.env,
					KASTARD_PRODUCT_VERSION: "0.2.0",
					KASTARD_SOURCE_REVISION: sourceRevision,
				},
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(result.stdout.toString()).toBe(
			"cu128\tsomecatco/kastard-worker-cu128:0.2.0-build.7-aaaaaaa\n" +
				"cu130\tsomecatco/kastard-worker-cu130:0.2.0-build.7-aaaaaaa\n",
		);
	});

	test("requires one release channel", () => {
		const root = createFixture();
		installWorkerImageScript(root);

		const result = Bun.spawnSync(
			[
				"bash",
				"scripts/worker-image.sh",
				"--preview",
				"--production",
				"--print-images",
			],
			{ cwd: root },
		);

		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("--preview | --production");
	});

	test("keeps branch and commit tags outside main", () => {
		const root = createFixture();
		installWorkerImageScript(root, "Feature/Test");
		const commit = Bun.spawnSync(
			[
				"git",
				"-c",
				"user.name=Kastard Test",
				"-c",
				"user.email=test@kastard.invalid",
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				"fixture",
			],
			{ cwd: root },
		);
		expect(commit.exitCode).toBe(0);
		const sha = Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"], {
			cwd: root,
		})
			.stdout.toString()
			.trim();

		const result = Bun.spawnSync(
			["bash", "scripts/worker-image.sh", "--print-images"],
			{ cwd: root },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(result.stdout.toString()).toBe(
			`cu128\tssinss/kastard-worker:feature-test-${sha}-cu128\n` +
				`cu130\tssinss/kastard-worker:feature-test-${sha}-cu130\n`,
		);
	});
});

describe("Worker image builds", () => {
	test("publishes a missing runtime base before the Preview Worker image", () => {
		const root = createFixture();
		installWorkerImageScript(root);
		const env = installWorkerBuildTools(root, false);

		const result = Bun.spawnSync(
			["bash", "scripts/worker-image.sh", "--preview", "--runtime", "cu128", "--push"],
			{ cwd: root, env },
		);

		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		const commands = readFileSync(env.DOCKER_LOG, "utf8").trim().split("\n");
		expect(commands[0]).toContain(
			"manifest inspect -- somecatco/kastard-worker-cu128:runtime-cu128-fixturecu128",
		);
		expect(commands[1]).toContain("-f apps/server/Dockerfile.runtime");
		expect(commands[1]).toContain("--build-arg CLEAN_UV_CACHE=true");
		expect(commands[1]).toContain(
			"--cache-from type=registry,ref=somecatco/kastard-worker-cu128:buildcache-runtime-cu128",
		);
		expect(commands[1]).toContain(
			"--cache-to type=registry,ref=somecatco/kastard-worker-cu128:buildcache-runtime-cu128,mode=max",
		);
		expect(commands[2]).toContain(
			"--build-arg RUNTIME_IMAGE=somecatco/kastard-worker-cu128:runtime-cu128-fixturecu128",
		);
		expect(commands[2]).toContain("--build-arg KASTARD_CHANNEL=preview");
		expect(commands[2]).toContain(
			`--build-arg KASTARD_SOURCE_REVISION=${sourceRevision}`,
		);
		expect(commands[2]).toContain(
			"--cache-to type=registry,ref=somecatco/kastard-worker-cu128:buildcache-worker-cu128,mode=max",
		);
		expect(commands[2]).toContain(
			"--cache-from type=registry,ref=somecatco/kastard-worker-cu128:buildcache-worker-cu128",
		);
		expect(commands[2]).toContain(
			"-t somecatco/kastard-worker-cu128:preview-build.7-aaaaaaa",
		);
	});

	test("reuses a published runtime base and preserves the Production latest tag", () => {
		const root = createFixture();
		installWorkerImageScript(root);
		const env = installWorkerBuildTools(root, true);

		const result = Bun.spawnSync(
			[
				"bash",
				"scripts/worker-image.sh",
				"--production",
				"--runtime",
				"cu130",
				"--push",
			],
			{ cwd: root, env },
		);

		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		const commands = readFileSync(env.DOCKER_LOG, "utf8").trim().split("\n");
		expect(commands).toHaveLength(2);
		expect(commands[1]).not.toContain("Dockerfile.runtime");
		expect(commands[1]).toContain(
			"-t somecatco/kastard-worker-cu130:0.2.0-build.7-aaaaaaa",
		);
		expect(commands[1]).toContain("-t somecatco/kastard-worker-cu130:latest");
		expect(commands[1]).toContain("--build-arg KASTARD_CHANNEL=production");
		expect(commands[1]).toContain("--build-arg KASTARD_PRODUCT_VERSION=0.2.0");
	});

	test("fails when the runtime registry lookup is unavailable", () => {
		const root = createFixture();
		installWorkerImageScript(root);
		const env = installWorkerBuildTools(root, "error");

		const result = Bun.spawnSync(
			["bash", "scripts/worker-image.sh", "--preview", "--runtime", "cu128", "--push"],
			{ cwd: root, env },
		);

		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("registry unavailable");
		expect(readFileSync(env.DOCKER_LOG, "utf8").trim().split("\n")).toHaveLength(1);
	});

	test("keeps registry cache export specific to GitHub Actions", () => {
		const root = createFixture();
		installWorkerImageScript(root);
		const env = installWorkerBuildTools(root, true);
		delete env.GITHUB_ACTIONS;

		const result = Bun.spawnSync(
			["bash", "scripts/worker-image.sh", "--preview", "--runtime", "cu130", "--push"],
			{ cwd: root, env },
		);

		expect(result.exitCode).toBe(0);
		const commands = readFileSync(env.DOCKER_LOG, "utf8").trim().split("\n");
		expect(commands[1]).not.toContain("--cache-from");
		expect(commands[1]).not.toContain("--cache-to");
		expect(commands[1]).not.toContain("--build-arg CLEAN_UV_CACHE=true");
	});
});
