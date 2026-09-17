// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { EditorCustomNodes } from "./custom-nodes";
import { fixture } from "./test-fixture";

async function inspectionFixture(script?: string, ready = false) {
	const paths = await fixture();
	const directory = join(paths.dataDirectory, "data", "custom_nodes", "example-node");
	const bin = join(paths.dataDirectory, "bin");
	await mkdir(directory, { recursive: true });
	await mkdir(bin);
	if (script !== undefined) {
		await writeFile(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	}
	const nodes = new EditorCustomNodes({
		...paths,
		getRuntimeState: () =>
			ready ? { status: "ready", url: "http://127.0.0.1:18188/" } : { status: "idle" },
		fetch: (async () =>
			Response.json({
				"example-node": { ver: "unknown", cnr_id: null },
			})) as typeof fetch,
	});
	return { nodes, directory, bin };
}

test.each([false, true])(
	"preserves command failure output in the inventory with Manager ready=%s",
	async (ready) => {
		const { nodes, bin } = await inspectionFixture(
			"printf 'Checking repository\\n'\nprintf '\\033[31mGit cannot run until the developer tools license is accepted.\\033[0m\\n' >&2\nexit 69",
			ready,
		);
		vi.stubEnv("PATH", bin);
		const [node] = await nodes.listCustomNodes();
		expect(node).toMatchObject({
			name: "example-node",
			version: "unknown",
			workerSyncIssue: "The Git repository metadata could not be read.",
			workerSyncErrorLog: { truncated: false },
		});
		expect(node?.workerSyncErrorLog?.text).toBe(
			[
				"Command: git rev-parse --show-toplevel",
				"Exit code: 69",
				"stdout:\nChecking repository\n\n\nstderr:\nGit cannot run until the developer tools license is accepted.\n",
			].join("\n\n"),
		);
	},
);

test("records the operating-system error when Git cannot be started", async () => {
	const { nodes, bin } = await inspectionFixture();
	vi.stubEnv("PATH", bin);
	const [node] = await nodes.listCustomNodes();
	expect(node?.workerSyncErrorLog?.text).toContain("Error code: ENOENT");
	expect(node?.workerSyncErrorLog?.text).toContain("spawn git ENOENT");
});

test("records termination and partial output when Git exceeds its timeout", async () => {
	const { nodes, bin } = await inspectionFixture(
		"printf 'Waiting for repository\\n' >&2\nexec /bin/sleep 30",
	);
	vi.stubEnv("PATH", bin);
	const [node] = await nodes.listCustomNodes();
	expect(node?.workerSyncErrorLog?.text).toContain("Signal: SIGTERM");
	expect(node?.workerSyncErrorLog?.text).toContain(
		"The process was terminated before completion.",
	);
	expect(node?.workerSyncErrorLog?.text).toContain("stderr:\nWaiting for repository");
}, 15_000);

test("keeps every failed metadata command in the node's error log", async () => {
	const { nodes, bin } = await inspectionFixture(
		[
			'case "$4 $5" in',
			'"rev-parse --show-toplevel") printf "%s\\n" "$3"; exit 0 ;;',
			'"config --get") printf "Origin could not be read\\n" >&2; exit 2 ;;',
			'"rev-parse --revs-only") printf "HEAD could not be read\\n" >&2; exit 3 ;;',
			'*) printf "Status could not be read\\n" >&2; exit 4 ;;',
			"esac",
		].join("\n"),
	);
	vi.stubEnv("PATH", bin);
	const [node] = await nodes.listCustomNodes();
	for (const output of [
		"Origin could not be read",
		"HEAD could not be read",
		"Status could not be read",
	]) {
		expect(node?.workerSyncErrorLog?.text).toContain(output);
	}
});

test("bounds long output while retaining the command and exit code", async () => {
	const { nodes, bin } = await inspectionFixture(
		"printf '%13000s' '' >&2\nprintf 'Repository read failed\\n' >&2\nexit 2",
	);
	vi.stubEnv("PATH", bin);
	const [node] = await nodes.listCustomNodes();
	expect(node?.workerSyncErrorLog?.truncated).toBe(true);
	expect(node?.workerSyncErrorLog?.text).toContain("Exit code: 2");
	expect(node?.workerSyncErrorLog?.text).toContain("Repository read failed");
	expect(node?.workerSyncErrorLog?.text.length).toBeLessThan(13_000);
});

test("returns the verified repository and commit after a failed inspection recovers", async () => {
	const { nodes, directory, bin } = await inspectionFixture(
		"printf 'Git is unavailable\\n' >&2\nexit 69",
	);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" });
	git("init", "--quiet");
	git(
		"-c",
		"user.name=Example",
		"-c",
		"user.email=example@example.com",
		"commit",
		"--allow-empty",
		"--quiet",
		"-m",
		"Initial",
	);
	git("remote", "add", "origin", "https://github.com/example/example-node.git");
	const version = git("rev-parse", "HEAD").trim();
	vi.stubEnv("PATH", bin);
	expect((await nodes.listCustomNodes())[0]?.workerSyncErrorLog?.text).toContain(
		"Git is unavailable",
	);
	vi.unstubAllEnvs();
	await expect(nodes.listCustomNodes()).resolves.toEqual([
		{
			name: "example-node",
			version,
			managerId: null,
			repository: "https://github.com/example/example-node.git",
		},
	]);
});
