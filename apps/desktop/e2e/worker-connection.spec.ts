import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import {
	closeDesktop,
	expect,
	launchDesktop,
	startServer,
	stopServer,
	type TestServer,
	test,
} from "./test-harness";

async function connectWorker(
	page: Page,
	workerAddress: string,
	authenticationCode: string,
): Promise<void> {
	const dialog = page.getByRole("dialog");
	if ((await dialog.getByLabel("Worker address").count()) === 0) {
		await dialog.getByRole("button", { name: /^Other server/ }).click();
	}
	const syncAfterConnect = dialog.getByRole("switch", {
		name: /^Sync after connecting/,
	});
	await expect(syncAfterConnect).toBeEnabled();
	await expect(syncAfterConnect).toBeChecked();
	await dialog.getByText("Sync after connecting", { exact: true }).click();
	await expect(syncAfterConnect).not.toBeChecked();
	await dialog.getByLabel("Worker address").fill(workerAddress);
	await dialog.getByLabel("Authentication code").fill(authenticationCode);
	await dialog.getByRole("button", { name: "Connect", exact: true }).click();
	await expect(page.getByRole("button", { name: /^Connected/ })).toBeVisible();
}

async function cleanup(
	desktops: ElectronApplication[],
	servers: TestServer[],
): Promise<void> {
	const results = await Promise.allSettled([
		...desktops.map(closeDesktop),
		...servers.map(stopServer),
	]);
	const errors = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (errors.length > 0) throw new AggregateError(errors, "E2E cleanup failed.");
}

test.describe("reusable Worker session connection", () => {
	let desktop: ElectronApplication | null = null;
	let page: Page;
	let server: TestServer | null = null;

	test.beforeEach(async ({ comfyDataRoot, testRoot }) => {
		server = await startServer();
		desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"));
		page = await desktop.firstWindow();
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await connectWorker(page, server.address, server.authenticationCode);
	});

	test.afterEach(async () => {
		await cleanup(desktop ? [desktop] : [], server ? [server] : []);
		desktop = null;
		server = null;
	});

	test("authenticates a protocol-free Worker address and exposes its system status", async () => {
		if (!server) throw new Error("Worker server is not available.");
		expect(server.authenticationCode).toMatch(/^(?:[A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		const systemStatus = page.getByRole("list", { name: "Worker status" });
		await expect(systemStatus).toBeVisible();
		await expect(
			systemStatus.getByRole("img", { name: /^CPU usage: \d+%$/ }),
		).toBeVisible();
	});

	test("copies and selects Worker logs through the OS clipboard", async () => {
		if (!desktop) throw new Error("Desktop is not available.");
		await page.getByRole("button", { name: /^Connected/ }).click();
		const connectionPopover = page.getByRole("dialog", {
			name: "Connection details",
		});
		await expect(connectionPopover).toBeVisible();
		if (!server) throw new Error("Worker server is not available.");
		await expect(connectionPopover.getByText(server.address)).toBeVisible();
		await connectionPopover.getByRole("button", { name: "View Worker logs" }).click();
		const logsDialog = page.getByRole("dialog", { name: "Worker logs" });
		const connectionLog = logsDialog.getByText("Editor connected.");
		await expect(connectionLog).toBeVisible();
		const previousClipboard = await desktop.evaluate(({ clipboard }) =>
			clipboard.readText(),
		);
		try {
			await logsDialog.getByRole("button", { name: "Copy all" }).click();
			await expect(logsDialog.getByText("Worker logs copied.")).toBeVisible();
			const copiedLogs = await desktop.evaluate(({ clipboard }) =>
				clipboard.readText(),
			);
			expect(copiedLogs).toContain("INFO Editor connected.");

			await desktop.evaluate(({ clipboard }) =>
				clipboard.writeText("kastard-e2e-clipboard-sentinel"),
			);
			await connectionLog.click();
			await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
			await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
			await expect
				.poll(() => desktop?.evaluate(({ clipboard }) => clipboard.readText()))
				.toContain("Editor connected.");
		} finally {
			await desktop.evaluate(
				({ clipboard }, value) => clipboard.writeText(value),
				previousClipboard,
			);
		}
	});

	test("dismisses transient overlays when the ComfyUI iframe is clicked", async () => {
		await page.getByRole("button", { name: "ComfyUI" }).click();
		const comfyFrame = page.locator('iframe[title="ComfyUI"]');
		const comfyBody = page.frameLocator('iframe[title="ComfyUI"]').locator("body");
		await expect(comfyFrame).toBeAttached({ timeout: 120_000 });
		const clickComfyArea = async (overlay: Locator): Promise<void> => {
			const bounds = await comfyFrame.boundingBox();
			if (!bounds) throw new Error("ComfyUI frame is not visible.");
			const overlayBounds = await overlay.boundingBox();
			const candidates = [
				{ x: bounds.x + bounds.width - 40, y: bounds.y + bounds.height - 40 },
				{ x: bounds.x + 40, y: bounds.y + bounds.height - 40 },
				{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 40 },
			];
			const target = candidates.find(
				(point) =>
					overlayBounds === null ||
					point.x < overlayBounds.x ||
					point.x > overlayBounds.x + overlayBounds.width ||
					point.y < overlayBounds.y ||
					point.y > overlayBounds.y + overlayBounds.height,
			);
			if (!target) throw new Error("No uncovered ComfyUI frame area is available.");
			await page.mouse.move(target.x, target.y);
			await expect(page.getByTestId("hover-overlay-dismiss-surface")).toHaveCount(0);
			await comfyBody.click({
				position: { x: target.x - bounds.x, y: target.y - bounds.y },
			});
		};

		await comfyFrame.focus();
		await expect(comfyFrame).toBeFocused();
		const cpuMetric = page
			.getByRole("list", { name: "Worker status" })
			.getByRole("img", { name: /^CPU usage: \d+%$/ });
		await cpuMetric.hover();
		const metricTooltip = page.getByRole("tooltip");
		await expect(metricTooltip).toBeVisible();
		await expect(metricTooltip).toContainText("CPU usage");
		await clickComfyArea(metricTooltip);
		await expect(metricTooltip).toHaveCount(0);
		await expect(comfyFrame).toBeFocused();

		await page.getByRole("button", { name: /^Connected/ }).click();
		const connectionPopover = page.getByRole("dialog", {
			name: "Connection details",
		});
		await expect(connectionPopover).toBeVisible();
		await clickComfyArea(connectionPopover);
		await expect(connectionPopover).toHaveCount(0);
		await expect(comfyFrame).toBeFocused();

		for (const area of ["Backend", "Nodes", "Models"] as const) {
			await page.getByRole("button", { name: `Open ${area} status` }).click();
			const statusPopover = page.getByRole("dialog", { name: `${area} status` });
			await expect(statusPopover).toBeVisible();
			await clickComfyArea(statusPopover);
			await expect(statusPopover).toHaveCount(0);
			await expect(comfyFrame).toBeFocused();
		}
	});
});

test("replaces the connected Editor after authenticating the same code", async ({
	comfyDataRoot,
	testRoot,
}) => {
	let firstDesktop: ElectronApplication | null = null;
	let replacementDesktop: ElectronApplication | null = null;
	let server: TestServer | null = null;

	try {
		server = await startServer();
		firstDesktop = await launchDesktop(comfyDataRoot, join(testRoot, "first-desktop"));
		const firstPage = await firstDesktop.firstWindow();
		await firstPage.getByRole("button", { name: "Connect", exact: true }).click();
		await connectWorker(firstPage, server.address, server.authenticationCode);

		replacementDesktop = await launchDesktop(
			comfyDataRoot,
			join(testRoot, "replacement-desktop"),
		);
		const replacementPage = await replacementDesktop.firstWindow();
		await replacementPage.getByRole("button", { name: "Connect", exact: true }).click();
		await connectWorker(replacementPage, server.address, server.authenticationCode);

		await expect(
			replacementPage.getByRole("button", { name: /^Connected/ }),
		).toBeVisible();
		await expect(firstPage.getByRole("button", { name: "Offline" })).toBeVisible();
		await firstPage.getByRole("button", { name: "Offline" }).click();
		const details = firstPage.getByRole("dialog", { name: "Connection details" });
		await expect(details.getByRole("button", { name: "Reconnect" })).toBeVisible();
	} finally {
		await cleanup(
			[firstDesktop, replacementDesktop].filter(
				(candidate): candidate is ElectronApplication => candidate !== null,
			),
			server ? [server] : [],
		);
	}
});

test("starts disconnected and prefills the recent server after restart", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const userDataDirectory = join(testRoot, "desktop");
	let firstDesktop: ElectronApplication | null = null;
	let restoredDesktop: ElectronApplication | null = null;
	let server: TestServer | null = null;

	try {
		firstDesktop = await launchDesktop(comfyDataRoot, userDataDirectory);
		const firstPage = await firstDesktop.firstWindow();
		await firstPage.getByRole("button", { name: "Connect", exact: true }).click();
		server = await startServer();
		await connectWorker(firstPage, server.address, server.authenticationCode);
		const disconnected = server.waitForDisconnect();
		await closeDesktop(firstDesktop);
		firstDesktop = null;
		await disconnected;

		restoredDesktop = await launchDesktop(comfyDataRoot, userDataDirectory);
		const page = await restoredDesktop.firstWindow();
		const connectButton = page.getByRole("button", { name: "Connect", exact: true });
		await expect(connectButton).toBeVisible();
		await expect(page.getByRole("button", { name: /^Connected/ })).toHaveCount(0);
		await connectButton.click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByLabel("Worker address")).toHaveValue(server.address);
		await expect(dialog.getByLabel("Authentication code")).toHaveValue("");
		await expect(
			dialog.getByRole("switch", { name: /^Sync after connecting/ }),
		).not.toBeChecked();
		await dialog.getByLabel("Authentication code").fill(server.authenticationCode);
		await dialog.getByRole("button", { name: "Connect", exact: true }).click();
		const connectedButton = page.getByRole("button", { name: /^Connected/ });
		await expect(connectedButton).toBeVisible();
		await connectedButton.click();
		await page
			.getByRole("dialog", { name: "Connection details" })
			.getByRole("button", { name: "Disconnect" })
			.click();
		await expect(connectButton).toBeVisible();
	} finally {
		await cleanup(
			[firstDesktop, restoredDesktop].filter(
				(candidate): candidate is ElectronApplication => candidate !== null,
			),
			server ? [server] : [],
		);
	}
});
