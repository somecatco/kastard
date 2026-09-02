import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	ElectronApplication,
	FrameLocator,
	Page,
	TestInfo,
} from "@playwright/test";
import {
	createLocalWorker,
	LOCAL_WORKER_E2E_MODEL,
	type LocalWorker,
} from "./local-worker-harness";
import { expect, launchDesktop, test } from "./test-harness";

const INPUT_PIXELS = [
	255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
];

type WorkerImage = {
	filename: string;
	subfolder: string;
	type: "output";
};

test.skip(
	process.env.KASTARD_LOCAL_WORKER_E2E !== "1",
	"Run through the dedicated local Worker E2E command.",
);

test("runs on a local CPU Worker and recovers after it restarts", async ({
	comfyDataRoot,
	testRoot,
}, testInfo) => {
	test.setTimeout(20 * 60_000);
	const worker = await createLocalWorker();
	let desktop: ElectronApplication | null = null;
	let testError: unknown;
	const dialogMessages: string[] = [];

	try {
		let session = await test.step("starts an isolated local CPU Worker", () =>
			worker.start());
		await worker.seedModel();
		desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"));
		const page = await desktop.firstWindow();
		seedDesktopModelLibrary(join(testRoot, "desktop"));
		page.on("dialog", (dialog) => {
			dialogMessages.push(dialog.message());
			void dialog.dismiss().catch(() => undefined);
		});

		await test.step("connects and completes Worker setup", async () => {
			await connectWorker(page, session.address, session.authenticationCode);
			await expectWorkerReady(page);
		});

		await createInputImage(page, comfyDataRoot, "kastard-e2e-input.png");
		await test.step("transfers an input and collects the Worker result", async () => {
			await runRoundTripWorkflow(
				page,
				"kastard-e2e-input.png",
				"before-restart",
				dialogMessages,
			);
		});

		await test.step("shows the stopped Worker as offline", async () => {
			await worker.stop();
			await expect(page.getByRole("button", { name: "Offline" })).toBeVisible({
				timeout: 90_000,
			});
		});

		await test.step("retries the connection and prepares the restarted Worker", async () => {
			session = await worker.start();
			await page.getByRole("button", { name: "Offline" }).click();
			await page
				.getByRole("dialog", { name: "Connection details" })
				.getByRole("button", { name: "Reconnect" })
				.click();
			await submitWorkerConnection(page, session.address, session.authenticationCode);
			await expectWorkerReady(page);
		});

		await test.step("runs another workflow after recovery", async () => {
			await runRoundTripWorkflow(
				page,
				"kastard-e2e-input.png",
				"after-restart",
				dialogMessages,
			);
		});
	} catch (error) {
		testError = error;
		await attachWorkerLogs(worker, testInfo);
		await attachDesktopLogs(desktop, testInfo);
		if (dialogMessages.length > 0) {
			await testInfo.attach("dialogs.log", {
				body: dialogMessages.join("\n"),
				contentType: "text/plain",
			});
		}
	}

	const cleanupResults = await Promise.allSettled([
		...(desktop === null ? [] : [closeTestDesktop(desktop)]),
		worker.cleanup(),
	]);
	const cleanupErrors = cleanupResults.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (testError !== undefined || cleanupErrors.length > 0) {
		throw new AggregateError(
			[...(testError === undefined ? [] : [testError]), ...cleanupErrors],
			"Local Worker E2E failed.",
		);
	}
});

async function closeTestDesktop(desktop: ElectronApplication): Promise<void> {
	const process = desktop.process();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		desktop.close().catch(() => undefined),
		new Promise<void>((resolveTimeout) => {
			timeout = setTimeout(resolveTimeout, 15_000);
		}),
	]);
	if (timeout !== undefined) clearTimeout(timeout);
	if (process.exitCode !== null) return;
	const exited = once(process, "exit");
	process.kill("SIGKILL");
	await exited;
}

function seedDesktopModelLibrary(userDataDirectory: string): void {
	const database = new DatabaseSync(join(userDataDirectory, "kastard.sqlite"));
	try {
		const timestamp = new Date().toISOString();
		database
			.prepare(
				`INSERT INTO models (
					id, name, source_url, path, sync, artifact_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
			)
			.run(
				"kastard-local-worker-e2e-model",
				LOCAL_WORKER_E2E_MODEL.name,
				LOCAL_WORKER_E2E_MODEL.sourceUrl,
				LOCAL_WORKER_E2E_MODEL.path,
				JSON.stringify(LOCAL_WORKER_E2E_MODEL.artifact),
				timestamp,
				timestamp,
			);
	} finally {
		database.close();
	}
}

async function connectWorker(
	page: Page,
	workerAddress: string,
	authenticationCode: string,
): Promise<void> {
	await page.getByRole("button", { name: "Connect", exact: true }).click();
	await submitWorkerConnection(page, workerAddress, authenticationCode);
}

async function submitWorkerConnection(
	page: Page,
	workerAddress: string,
	authenticationCode: string,
): Promise<void> {
	const dialog = page.getByRole("dialog");
	if ((await dialog.getByLabel("Worker address").count()) === 0) {
		await dialog.getByRole("button", { name: /^Other server/ }).click();
	}
	await expect(
		dialog.getByRole("switch", { name: /^Sync after connecting/ }),
	).toBeChecked();
	await dialog.getByLabel("Worker address").fill(workerAddress);
	await dialog.getByLabel("Authentication code").fill(authenticationCode);
	await dialog.getByRole("button", { name: "Connect", exact: true }).click();
	await expect(page.getByRole("button", { name: /^Connected/ })).toBeVisible({
		timeout: 30_000,
	});
}

async function expectWorkerReady(page: Page): Promise<void> {
	const synchronization = page.getByRole("list", { name: "Synchronization areas" });
	await expect(
		synchronization.getByRole("listitem", { name: "Backend: Synced, 2/2" }),
	).toBeVisible({ timeout: 10 * 60_000 });
	await expect(
		synchronization.getByRole("listitem", { name: "Nodes: Synced, 0/0" }),
	).toBeVisible();
	await expect(
		synchronization.getByRole("listitem", { name: "Models: Synced, 1/1" }),
	).toBeVisible();

	await page.getByRole("button", { name: /^Connected/ }).click();
	const connection = page.getByRole("dialog", { name: "Connection details" });
	await expect(
		connection.getByText("Backend, models, and custom nodes are synchronized."),
	).toBeVisible();
	await expect(connection.getByText("Running", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: /^Connected/ }).click();

	await page.getByRole("button", { name: "Open Backend status" }).click();
	const backend = page.getByRole("dialog", { name: "Backend status" });
	await expect(backend.getByText(/^CPU · Python /)).toBeVisible();
	await expect(backend.getByText("Running", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Open Backend status" }).click();
}

async function createInputImage(
	page: Page,
	comfyDataRoot: string,
	filename: string,
): Promise<void> {
	const bytes = await page.evaluate((sourcePixels) => {
		type CanvasContext = {
			putImageData: (image: unknown, x: number, y: number) => void;
		};
		type Canvas = {
			width: number;
			height: number;
			getContext: (type: string) => CanvasContext | null;
			toDataURL: (type: string) => string;
		};
		const browserDocument = Reflect.get(globalThis, "document") as {
			createElement: (tag: string) => Canvas;
		};
		const BrowserImageData = Reflect.get(globalThis, "ImageData") as new (
			data: Uint8ClampedArray,
			width: number,
			height: number,
		) => unknown;
		const canvas = browserDocument.createElement("canvas");
		canvas.width = 2;
		canvas.height = 2;
		const context = canvas.getContext("2d");
		if (context === null) throw new Error("Canvas 2D is unavailable.");
		const pixels = new BrowserImageData(new Uint8ClampedArray(sourcePixels), 2, 2);
		context.putImageData(pixels, 0, 0);
		const encoded = canvas.toDataURL("image/png").split(",")[1];
		if (encoded === undefined) throw new Error("Could not encode the input image.");
		return [...Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))];
	}, INPUT_PIXELS);
	const inputDirectory = join(comfyDataRoot, "data", "input");
	await mkdir(inputDirectory, { recursive: true });
	await writeFile(join(inputDirectory, filename), Buffer.from(bytes));
}

async function runRoundTripWorkflow(
	page: Page,
	inputFilename: string,
	outputPrefix: string,
	dialogMessages: string[],
): Promise<void> {
	await page
		.getByTestId("window-titlebar")
		.getByRole("button", { name: "ComfyUI", exact: true })
		.click();
	const frame = page.frameLocator('iframe[title="ComfyUI"]');
	await expect(frame.locator("canvas").first()).toBeVisible({ timeout: 240_000 });
	await expect
		.poll(
			() =>
				frame.locator("body").evaluate(() =>
					Boolean(
						(
							globalThis as unknown as {
								comfyAPI?: {
									app?: { app?: { positionConversion?: unknown } };
								};
							}
						).comfyAPI?.app?.app?.positionConversion,
					),
				),
			{ timeout: 45_000 },
		)
		.toBe(true);
	await dismissInitialComfyDialog(frame);
	const iframe = page.locator('iframe[title="ComfyUI"]');
	const comfyUrl = await iframe.getAttribute("src");
	if (comfyUrl === null) throw new Error("ComfyUI URL is unavailable.");

	const submissionResponse = page
		.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname.endsWith("/prompt"),
			{ timeout: 45_000 },
		)
		.catch(() => null);
	await loadAndRunComfyWorkflow(frame, inputFilename, outputPrefix);
	await page.waitForTimeout(500);
	if (dialogMessages.length > 0) {
		throw new Error(`ComfyUI dialog: ${dialogMessages.join(" | ")}`);
	}
	const response = await submissionResponse;
	if (response === null) {
		throw new Error("ComfyUI did not send the workflow submission request.");
	}
	if (!response.ok()) {
		throw new Error(
			`ComfyUI workflow submission returned HTTP ${response.status()}: ${await response.text()}`,
		);
	}
	const result = await waitForWorkerImage(comfyUrl, outputPrefix);
	await expectResultPixels(frame, result);
}

async function dismissInitialComfyDialog(frame: FrameLocator): Promise<void> {
	const overlay = frame.getByTestId("dialog-overlay");
	if (!(await overlay.isVisible())) return;
	await frame.locator("body").press("Escape");
	await expect(overlay).not.toBeVisible();
}

async function loadAndRunComfyWorkflow(
	frame: FrameLocator,
	inputFilename: string,
	outputPrefix: string,
): Promise<void> {
	const runButton = frame.getByTestId("queue-button");
	const deadline = Date.now() + 30_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		await dismissInitialComfyDialog(frame);
		await frame.locator("body").evaluate(
			async (_body, workflow) => {
				const app = (
					globalThis as unknown as {
						comfyAPI?: {
							app?: {
								app?: {
									loadApiJson: (prompt: unknown, name: string) => Promise<void>;
								};
							};
						};
					}
				).comfyAPI?.app?.app;
				if (app === undefined) throw new Error("ComfyUI app is unavailable.");
				await app.loadApiJson(
					{
						"1": {
							class_type: "LoadImage",
							inputs: { image: workflow.inputFilename },
						},
						"2": {
							class_type: "SaveImage",
							inputs: {
								filename_prefix: workflow.outputPrefix,
								images: ["1", 0],
							},
						},
					},
					workflow.outputPrefix,
				);
			},
			{ inputFilename, outputPrefix },
		);
		await dismissInitialComfyDialog(frame);
		const loaded = await frame.locator("body").evaluate(
			async (_body, workflow) => {
				const app = (
					globalThis as unknown as {
						comfyAPI?: {
							app?: {
								app?: {
									graphToPrompt: () => Promise<{
										output: Record<
											string,
											{
												class_type?: unknown;
												inputs?: { filename_prefix?: unknown };
											}
										>;
									}>;
								};
							};
						};
					}
				).comfyAPI?.app?.app;
				if (app === undefined) throw new Error("ComfyUI app is unavailable.");
				const output = (await app.graphToPrompt()).output;
				return Object.values(output).some(
					(node) =>
						node.class_type === "SaveImage" &&
						node.inputs?.filename_prefix === workflow.outputPrefix,
				);
			},
			{ outputPrefix },
		);
		if (!loaded) continue;
		try {
			await runButton.click({ timeout: 1_000 });
			return;
		} catch (error) {
			lastError = error;
			const overlay = frame.getByTestId("dialog-overlay");
			if (!(await overlay.isVisible())) continue;
			await frame.locator("body").press("Escape");
			await expect(overlay).not.toBeVisible({ timeout: 5_000 });
		}
	}
	throw lastError ?? new Error("ComfyUI did not retain the loaded workflow.");
}

async function waitForWorkerImage(
	comfyUrl: string,
	outputPrefix: string,
): Promise<WorkerImage> {
	const deadline = Date.now() + 120_000;
	let lastHistory: unknown = null;
	while (Date.now() < deadline) {
		const response = await fetch(new URL("history", comfyUrl));
		if (response.ok) {
			lastHistory = await response.json();
			const job = findWorkflowJob(lastHistory, outputPrefix);
			if (job !== null) {
				const result = findWorkerImage(job.value, outputPrefix);
				if (result !== null) return result;
				const detailsResponse = await fetch(new URL(`api/jobs/${job.id}`, comfyUrl));
				const details: unknown = await detailsResponse.json().catch(() => null);
				throw new Error(
					`Worker workflow did not produce an image: ${JSON.stringify(details)}`,
				);
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	throw new Error(
		`Worker workflow result is unavailable. Last history: ${JSON.stringify(lastHistory)}`,
	);
}

function findWorkflowJob(
	value: unknown,
	outputPrefix: string,
): { id: string; value: Record<string, unknown> } | null {
	if (!isRecord(value)) return null;
	for (const [id, history] of Object.entries(value)) {
		if (!isRecord(history) || !Array.isArray(history.prompt)) continue;
		const prompt = history.prompt[2];
		if (!isRecord(prompt)) continue;
		const matches = Object.values(prompt).some(
			(node) =>
				isRecord(node) &&
				node.class_type === "SaveImage" &&
				isRecord(node.inputs) &&
				node.inputs.filename_prefix === outputPrefix,
		);
		if (matches) return { id, value: history };
	}
	return null;
}

function findWorkerImage(value: unknown, outputPrefix: string): WorkerImage | null {
	if (!isRecord(value) || !isRecord(value.outputs)) return null;
	for (const output of Object.values(value.outputs)) {
		if (!isRecord(output)) continue;
		for (const items of Object.values(output)) {
			if (!Array.isArray(items)) continue;
			for (const item of items) {
				if (
					isRecord(item) &&
					typeof item.filename === "string" &&
					item.filename.startsWith(outputPrefix) &&
					typeof item.subfolder === "string" &&
					/^kastard\/[0-9a-f-]+\/[0-9a-f]{64}$/.test(item.subfolder) &&
					item.type === "output"
				) {
					return {
						filename: item.filename,
						subfolder: item.subfolder,
						type: "output",
					};
				}
			}
		}
	}
	return null;
}

async function expectResultPixels(
	frame: FrameLocator,
	image: WorkerImage,
): Promise<void> {
	const query = new URLSearchParams(image).toString();
	const decoded = await frame.locator("body").evaluate(async (_body, path) => {
		type Bitmap = { width: number; height: number; close: () => void };
		type CanvasContext = {
			drawImage: (image: unknown, x: number, y: number) => void;
			getImageData: (
				x: number,
				y: number,
				width: number,
				height: number,
			) => { data: Uint8ClampedArray };
		};
		type Canvas = {
			width: number;
			height: number;
			getContext: (type: string) => CanvasContext | null;
		};
		const createBitmap = Reflect.get(globalThis, "createImageBitmap") as (
			blob: Blob,
		) => Promise<Bitmap>;
		const browserDocument = Reflect.get(globalThis, "document") as {
			createElement: (tag: string) => Canvas;
		};
		const response = await fetch(path);
		if (!response.ok) throw new Error(`Result view returned HTTP ${response.status}.`);
		const bitmap = await createBitmap(await response.blob());
		try {
			const canvas = browserDocument.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext("2d");
			if (context === null) throw new Error("Canvas 2D is unavailable.");
			context.drawImage(bitmap, 0, 0);
			return {
				width: bitmap.width,
				height: bitmap.height,
				pixels: [...context.getImageData(0, 0, bitmap.width, bitmap.height).data],
			};
		} finally {
			bitmap.close();
		}
	}, `/view?${query}`);
	expect(decoded).toEqual({ width: 2, height: 2, pixels: INPUT_PIXELS });
}

async function attachWorkerLogs(
	worker: LocalWorker,
	testInfo: TestInfo,
): Promise<void> {
	let body: string;
	try {
		body = await worker.logs();
	} catch (error) {
		body = error instanceof Error ? error.message : String(error);
	}
	await testInfo.attach("local-worker.log", {
		body,
		contentType: "text/plain",
	});
}

async function attachDesktopLogs(
	desktop: ElectronApplication | null,
	testInfo: TestInfo,
): Promise<void> {
	if (desktop === null) return;
	let body: string;
	try {
		const page = await desktop.firstWindow();
		const logs = await page.evaluate(() => {
			const browserWindow = globalThis as unknown as {
				kastard: {
					connection: { getLogs: () => Promise<unknown> };
				};
			};
			return browserWindow.kastard.connection.getLogs();
		});
		body = JSON.stringify(logs, null, 2);
	} catch (error) {
		body = error instanceof Error ? error.message : String(error);
	}
	await testInfo.attach("desktop-worker-logs.json", {
		body,
		contentType: "application/json",
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
