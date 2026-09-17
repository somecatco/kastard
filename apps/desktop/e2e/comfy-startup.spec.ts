import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, launchDesktop, test } from "./test-harness";

// Clipboard restoration must not record existing clipboard contents in traces.
test.use({ trace: "off" });

test("shows failed startup output and copies it through the OS clipboard", async ({
	testRoot,
}) => {
	test.skip(
		process.platform === "win32",
		"The failing process fixture uses a POSIX shell.",
	);
	const dataRoot = join(testRoot, "comfy");
	const environment = join(dataRoot, "environment");
	await mkdir(join(environment, "bin"), { recursive: true });
	const manifest = JSON.parse(
		await readFile(resolve("resources/comfyui-runtime/.kastard-source.json"), "utf8"),
	);
	const managerRequirements = await readFile(
		resolve("resources/comfyui-runtime/backend/manager_requirements.txt"),
		"utf8",
	);
	const managerVersion = /comfyui_manager==([^\s]+)/.exec(managerRequirements)?.[1];
	expect(managerVersion).toBeTruthy();
	await writeFile(
		join(environment, ".kastard-runtime.json"),
		JSON.stringify({
			version: manifest.version,
			sha256: manifest.sha256,
			pythonVersion: manifest.pythonVersion,
			managerVersion,
			pygit2Version: manifest.pygit2Version,
			dependencyLockSha256: manifest.dependencyLock.sha256,
			uvVersion: manifest.uv.version,
			platform: manifest.platform,
		}),
	);
	const python = join(environment, "bin", "python");
	await writeFile(
		python,
		"#!/bin/sh\nprintf 'Loading example-node.\\n'\nprintf 'Example startup failure.\\n' >&2\nexit 1\n",
		{ mode: 0o755 },
	);
	const desktop = await launchDesktop(dataRoot, join(testRoot, "desktop"));
	const previousClipboard = await desktop.evaluate(({ clipboard }) =>
		clipboard.readText(),
	);
	try {
		const page = await desktop.firstWindow();
		await expect(
			page.getByRole("heading", { name: "ComfyUI failed to start" }),
		).toBeVisible();
		await page.getByRole("button", { name: "View logs", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "ComfyUI startup logs" });
		await expect(
			dialog.getByText("ComfyUI exited with code 1.", { exact: true }),
		).toBeVisible();
		const output = dialog.getByRole("textbox", { name: "Startup log output" });
		await expect(output).toHaveValue(/Loading example-node\./);
		await expect(output).toHaveValue(/Example startup failure\./);
		const logs = await output.inputValue();
		await dialog.getByRole("button", { name: "Copy all" }).click();
		await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
		expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(
			`ComfyUI exited with code 1.\n\n${logs}`,
		);
		await output.click();
		await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
		await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
		await expect
			.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe(logs);
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: "View logs", exact: true }),
		).toBeFocused();
		await writeFile(
			python,
			"#!/bin/sh\nprintf 'Retry startup failure.\\n' >&2\nexit 2\n",
			{ mode: 0o755 },
		);
		await page.getByRole("button", { name: "Try again" }).click();
		await page.getByRole("button", { name: "View logs", exact: true }).click();
		await expect(output).toHaveValue("Retry startup failure.\n");
		await expect(
			dialog.getByText("ComfyUI exited with code 2.", { exact: true }),
		).toBeVisible();
		await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
		await expect(
			page.getByRole("button", { name: "View logs", exact: true }),
		).toBeFocused();
	} finally {
		await desktop.evaluate(
			({ clipboard }, text) => clipboard.writeText(text),
			previousClipboard,
		);
		const closed = desktop.waitForEvent("close");
		await desktop.evaluate(({ app }) => {
			setImmediate(() => app.exit(0));
		});
		await closed;
	}
});
