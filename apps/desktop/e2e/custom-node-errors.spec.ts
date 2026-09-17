import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeDesktop, expect, launchDesktop, test } from "./test-harness";

// Clipboard restoration must not record existing clipboard contents in traces.
test.use({ trace: "off" });

test("shows a custom node's Git failure through the desktop error log", async ({
	testRoot,
}) => {
	test.skip(process.platform === "win32", "The Git fixture uses a POSIX shell.");
	const comfyDataRoot = join(testRoot, "comfy");
	const node = join(comfyDataRoot, "data", "custom_nodes", "example-node");
	const bin = join(testRoot, "bin");
	await mkdir(node, { recursive: true });
	await mkdir(bin);
	const stderr = "Git cannot run until the developer tools license is accepted.";
	await writeFile(
		join(bin, "git"),
		`#!/bin/sh\nprintf '%s\\n' '${stderr}' >&2\nexit 69\n`,
		{ mode: 0o755 },
	);
	const desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"), {
		PATH: bin,
	});
	let previousClipboard: string | undefined;
	try {
		previousClipboard = await desktop.evaluate(({ clipboard }) => clipboard.readText());
		const page = await desktop.firstWindow();
		await page.getByRole("button", { name: "Custom Nodes", exact: true }).click();
		await expect(page.getByRole("heading", { name: "example-node" })).toBeVisible();
		await expect(page.getByText("Worker sync unavailable")).toBeVisible();
		await page.getByRole("button", { name: "View error log" }).click();
		const dialog = page.getByRole("dialog", { name: "Custom node error log" });
		await expect(dialog.getByText("example-node", { exact: true })).toBeVisible();
		const output = dialog.getByRole("textbox", { name: "Error log output" });
		expect(await output.inputValue()).toContain(
			[
				"Command: git rev-parse --show-toplevel",
				"Exit code: 69",
				`stderr:\n${stderr}\n`,
			].join("\n\n"),
		);
		expect(await output.inputValue()).toContain(
			"Command: Python (pygit2 repository inspection)",
		);
		expect(await output.inputValue()).toContain("Error code: ENOENT");
		await dialog.getByRole("button", { name: "Copy all" }).click();
		await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
		expect(await desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(
			await output.inputValue(),
		);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: "View error log" })).toBeFocused();
	} finally {
		try {
			if (previousClipboard !== undefined) {
				await desktop.evaluate(
					({ clipboard }, text) => clipboard.writeText(text),
					previousClipboard,
				);
			}
		} finally {
			await closeDesktop(desktop);
		}
	}
});
