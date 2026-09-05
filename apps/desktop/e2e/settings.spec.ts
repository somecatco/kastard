import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeDesktop, expect, launchDesktop, test } from "./test-harness";

test("retains saved settings across navigation and persists subsequent changes", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const userDataDirectory = join(testRoot, "desktop");
	await mkdir(userDataDirectory, { recursive: true });
	await writeFile(
		join(userDataDirectory, "theme.json"),
		JSON.stringify({ version: 1, theme: "dark" }),
	);
	const notificationPath = join(userDataDirectory, "sync-completion-notification.json");
	await writeFile(notificationPath, JSON.stringify({ version: 1, enabled: false }));
	const desktop = await launchDesktop(comfyDataRoot, userDataDirectory);
	try {
		const page = await desktop.firstWindow();
		const navigation = page.getByRole("navigation", { name: "Primary navigation" });
		await navigation.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = page.getByTestId("settings-surface");
		const notification = settings.getByRole("switch", {
			name: /^Worker setup complete/,
		});
		await expect(notification).not.toBeChecked();
		await expect(notification).toBeVisible();
		await expect(settings.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
		await settings.getByRole("button", { name: "Connection", exact: true }).click();
		await settings.getByRole("button", { name: "General", exact: true }).click();
		await expect(notification).not.toBeChecked();
		await navigation.getByRole("button", { name: "ComfyUI", exact: true }).click();
		await navigation.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(notification).not.toBeChecked();
		await settings.getByText("Worker setup complete", { exact: true }).click();
		await settings.getByRole("combobox", { name: "Theme" }).selectOption("light");
		await navigation.getByRole("button", { name: "ComfyUI", exact: true }).click();
		await expect
			.poll(async () => JSON.parse(await readFile(notificationPath, "utf8")))
			.toEqual({ version: 1, enabled: true });
		await expect
			.poll(async () =>
				JSON.parse(await readFile(join(userDataDirectory, "theme.json"), "utf8")),
			)
			.toEqual({ version: 1, theme: "light" });
		await navigation.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(notification).toBeChecked();
		await expect(settings.getByRole("combobox", { name: "Theme" })).toHaveValue(
			"light",
		);
		await expect(page.locator("html")).not.toHaveClass(/dark/);
	} finally {
		await closeDesktop(desktop);
	}
});
