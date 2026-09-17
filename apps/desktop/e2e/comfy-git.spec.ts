import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { closeDesktop, expect, launchDesktop, test } from "./test-harness";

const run = promisify(execFile);

test.use({ trace: "off" });

for (const git of ["missing", "failing", "available"] as const) {
	test(`starts ComfyUI and Manager with ${git} Git`, async ({
		comfyDataRoot,
		testRoot,
	}) => {
		test.skip(process.platform === "win32", "The Git fixture uses a POSIX shell.");
		const bin = join(testRoot, "bin");
		await mkdir(bin);
		if (git === "failing") {
			await writeFile(
				join(bin, "git"),
				"#!/bin/sh\nprintf 'Git is unavailable until the developer tools license is accepted.\\n' >&2\nexit 69\n",
				{ mode: 0o755 },
			);
		}
		const env = {
			PATH: git === "available" ? process.env.PATH : bin,
			CM_USE_PYGIT2: undefined,
			GIT_PYTHON_GIT_EXECUTABLE: undefined,
			PYTHONHOME: undefined,
			PYTHONPATH: undefined,
			VIRTUAL_ENV: undefined,
			CONDA_PREFIX: undefined,
			PYTHONPYCACHEPREFIX: join(comfyDataRoot, "cache", "python-bytecode"),
		};
		if (git === "available") {
			const { stdout } = await run("git", ["--version"], {
				env: { ...process.env, ...env },
			});
			expect(stdout).toMatch(/^git version /);
		}
		const desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"), env);
		try {
			const page = await desktop.firstWindow();
			const frame = page.locator('iframe[title="ComfyUI"]');
			await expect(frame).toBeAttached({ timeout: 240_000 });
			const url = await frame.getAttribute("src");
			if (!url) throw new Error("ComfyUI URL is not available.");
			const manager = await fetch(new URL("v2/manager/version", url));
			expect(manager.ok).toBe(true);
			const manifest = JSON.parse(
				await readFile(
					resolve("resources/comfyui-runtime/.kastard-source.json"),
					"utf8",
				),
			);
			expect(await manager.text()).toContain(manifest.managerVersion);

			const { stdout } = await run(
				join(comfyDataRoot, "environment", "bin", "python"),
				["-c", "import comfyui_manager.common.git_compat"],
				{
					cwd: resolve("resources/comfyui-runtime/backend"),
					env: { ...process.env, ...env },
				},
			);
			expect(stdout).toContain(
				git === "available"
					? "[ComfyUI-Manager] Using GitPython backend"
					: "[ComfyUI-Manager] Using pygit2 backend (system git not available)",
			);
		} finally {
			await closeDesktop(desktop);
		}
	});
}
