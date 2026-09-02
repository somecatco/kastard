import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeDesktop, expect, launchDesktop, test } from "./test-harness";

test("starts official ComfyUI and stops it after app.quit()", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"));
	let desktopClosed = false;

	try {
		const page = await desktop.firstWindow();
		await expect(
			page.getByRole("progressbar", { name: "ComfyUI startup progress" }),
		).toBeVisible();
		await expect(
			page.getByText(
				"The first launch downloads Python and PyTorch and may take a few minutes.",
			),
		).toBeVisible();
		expect(
			await desktop.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().every(
					(window) => !window.isVisible() && !window.isFocused(),
				),
			),
		).toBe(true);

		const comfyFrame = page.locator('iframe[title="ComfyUI"]');
		await expect(comfyFrame).toBeAttached({ timeout: 240_000 });
		const comfyUrl = await comfyFrame.getAttribute("src");
		if (!comfyUrl) throw new Error("ComfyUI URL is not available.");
		const comfy = page.frameLocator('iframe[title="ComfyUI"]');
		await expect(comfy.locator("#vue-app")).toBeAttached({ timeout: 30_000 });
		await expect(comfy.locator("canvas").first()).toBeVisible({ timeout: 45_000 });
		await expect(comfy.getByRole("button", { name: /^Run/ }).first()).toBeVisible();
		await expect(comfy.locator("#splash-loader")).toBeHidden();

		await closeDesktop(desktop);
		desktopClosed = true;
		await expect
			.poll(async () => {
				try {
					await fetch(`${comfyUrl}?after-will-quit`);
					return false;
				} catch {
					return true;
				}
			})
			.toBe(true);
	} finally {
		if (!desktopClosed) await desktop.close();
	}
});

test("opens native Settings without revealing the hidden desktop window", async ({
	comfyDataRoot,
	testRoot,
}) => {
	test.skip(process.platform !== "darwin", "The native Settings menu is macOS-only.");
	const desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"));

	try {
		const page = await desktop.firstWindow();
		const nativeSettings = await desktop.evaluate(({ Menu }) => {
			const item = Menu.getApplicationMenu()?.getMenuItemById("settings");
			if (!item) return null;
			item.click();
			return { label: item.label, accelerator: item.accelerator };
		});
		expect(nativeSettings).toEqual({
			label: "Settings…",
			accelerator: "CmdOrCtrl+,",
		});
		await expect(page.getByTestId("settings-surface")).toBeVisible();
		expect(
			await desktop.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().every(
					(window) => !window.isVisible() && !window.isFocused(),
				),
			),
		).toBe(true);
	} finally {
		await closeDesktop(desktop);
	}
});

test("keeps desktop theme changes isolated from ComfyUI", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const userDataDirectory = join(testRoot, "desktop");
	await mkdir(userDataDirectory, { recursive: true });
	await writeFile(
		join(userDataDirectory, "theme.json"),
		`${JSON.stringify({ version: 1, theme: "dark" })}\n`,
	);
	const desktop = await launchDesktop(comfyDataRoot, userDataDirectory);

	try {
		const page = await desktop.firstWindow();
		const comfy = page.frameLocator('iframe[title="ComfyUI"]');
		await expect(comfy.locator("canvas").first()).toBeVisible({ timeout: 240_000 });
		const comfyDocumentClass = await comfy.locator("html").getAttribute("class");

		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = page.getByTestId("settings-surface");
		const theme = settings.getByRole("combobox", { name: "Theme" });
		await theme.selectOption("light");
		await expect(page.locator("html")).not.toHaveClass(/dark/);
		expect(await comfy.locator("html").getAttribute("class")).toBe(comfyDocumentClass);

		await theme.selectOption("dark");
		await expect(page.locator("html")).toHaveClass(/dark/);
		expect(await comfy.locator("html").getAttribute("class")).toBe(comfyDocumentClass);
	} finally {
		await closeDesktop(desktop);
	}
});

test("restarts ComfyUI with a fresh usable frontend", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"));

	try {
		const page = await desktop.firstWindow();
		const comfy = page.frameLocator('iframe[title="ComfyUI"]');
		await expect(comfy.locator("canvas").first()).toBeVisible({ timeout: 240_000 });
		await comfy.locator("html").evaluate(() => {
			Reflect.set(globalThis, "__kastardComfyRestartMarker", true);
		});

		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = page.getByTestId("settings-surface");
		await settings.getByRole("button", { name: "ComfyUI" }).click();
		await settings.getByRole("button", { name: "Restart", exact: true }).click();
		await expect(settings.getByText("ComfyUI restarted.", { exact: true })).toBeVisible(
			{
				timeout: 240_000,
			},
		);
		await page
			.getByTestId("window-titlebar")
			.getByRole("button", { name: "ComfyUI", exact: true })
			.click();
		await expect(comfy.locator("#vue-app")).toBeAttached({ timeout: 30_000 });
		await expect(comfy.locator("canvas").first()).toBeVisible({ timeout: 45_000 });
		expect(
			await comfy
				.locator("html")
				.evaluate(() => Reflect.get(globalThis, "__kastardComfyRestartMarker")),
		).toBeUndefined();
	} finally {
		await closeDesktop(desktop);
	}
});

test("honors the native quit decision for unsaved ComfyUI changes", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"));

	try {
		const page = await desktop.firstWindow();
		await expect(page.locator('iframe[title="ComfyUI"]')).toBeAttached({
			timeout: 240_000,
		});
		const ignoredBeforeUnload = await desktop.evaluate(({ BrowserWindow, dialog }) => {
			const window = BrowserWindow.getAllWindows()[0];
			if (!window) throw new Error("Desktop window is not available.");
			const originalShowMessageBoxSync = dialog.showMessageBoxSync;
			const prevented: boolean[] = [];
			for (const choice of [0, 1]) {
				dialog.showMessageBoxSync = () => choice;
				let ignoredBeforeUnload = false;
				window.webContents.emit("will-prevent-unload", {
					preventDefault: () => {
						ignoredBeforeUnload = true;
					},
				} as never);
				prevented.push(ignoredBeforeUnload);
			}
			dialog.showMessageBoxSync = originalShowMessageBoxSync;
			return prevented;
		});
		expect(ignoredBeforeUnload).toEqual([false, true]);
	} finally {
		await closeDesktop(desktop);
	}
});
