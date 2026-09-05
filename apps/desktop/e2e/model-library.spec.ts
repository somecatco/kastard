import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ElectronApplication, Page } from "@playwright/test";
import { closeDesktop, expect, launchDesktop, test } from "./test-harness";

const model = {
	name: "Stable Diffusion 1.5",
	sourceUrl:
		"https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/blob/main/diffusion_models/v1_5-pruned-emaonly-fp16.safetensors",
	path: "unet/v1_5-pruned-emaonly-fp16.safetensors",
};

async function stubModelMetadata(desktop: ElectronApplication): Promise<void> {
	await desktop.evaluate(async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (
				url ===
				"https://huggingface.co/api/models/Comfy-Org/stable-diffusion-v1-5-archive/revision/main?blobs=true"
			) {
				return Response.json({
					modelId: "Comfy-Org/stable-diffusion-v1-5-archive",
					sha: "6ad2af6cc1378562b96bf2827523d20d858beef2",
					siblings: [
						{
							rfilename: "diffusion_models/v1_5-pruned-emaonly-fp16.safetensors",
							size: 2_132_696_762,
						},
						{ rfilename: "v1-5-pruned-emaonly.safetensors", size: 4_265_380_512 },
					],
				});
			}
			return originalFetch(input, init);
		};
	});
}

async function registerModel(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Model Library", exact: true }).click();
	await page.getByRole("button", { name: "Add Model" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Source URL").fill(model.sourceUrl);
	await dialog.getByRole("button", { name: "Load Model Info" }).click();
	await dialog.getByLabel("Name").fill(model.name);
	await dialog.getByLabel("ComfyUI folder").selectOption("unet");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toHaveCount(0);
}

async function removeModel(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Model Library", exact: true }).click();
	await page.getByRole("button", { name: `Delete ${model.name}` }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(dialog).toHaveCount(0);
}

async function getComfyUrl(page: Page): Promise<string> {
	const comfyFrame = page.locator('iframe[title="ComfyUI"]');
	await expect(comfyFrame).toBeAttached({ timeout: 240_000 });
	const comfyUrl = await comfyFrame.getAttribute("src");
	if (!comfyUrl) throw new Error("ComfyUI URL is not available.");
	return comfyUrl;
}

test("registers a model with the real ComfyUI definitions and graph", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const userDataDirectory = join(testRoot, "desktop");
	const localModelName = "local-only.safetensors";
	const localModelDirectory = join(comfyDataRoot, "data", "models", "unet");
	await mkdir(localModelDirectory, { recursive: true });
	await writeFile(join(localModelDirectory, localModelName), "");
	const desktop = await launchDesktop(comfyDataRoot, userDataDirectory);

	try {
		const page = await desktop.firstWindow();
		const comfy = page.frameLocator('iframe[title="ComfyUI"]');
		await expect(comfy.locator("canvas").first()).toBeVisible({ timeout: 240_000 });
		await stubModelMetadata(desktop);
		const comfyUrl = await getComfyUrl(page);
		await registerModel(page);

		const definitionResponse = await fetch(
			new URL("api/object_info/UNETLoader", comfyUrl),
		);
		const definitions = (await definitionResponse.json()) as {
			UNETLoader: { input: { required: { unet_name: [string[]] } } };
		};
		expect(definitions.UNETLoader.input.required.unet_name[0]).toContain(
			"v1_5-pruned-emaonly-fp16.safetensors",
		);
		expect(definitions.UNETLoader.input.required.unet_name[0]).toContain(
			localModelName,
		);

		await page.getByRole("button", { name: "ComfyUI" }).click();
		await expect
			.poll(() =>
				comfy.locator("body").evaluate(() =>
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
			)
			.toBe(true);
		const registeredNode = await comfy
			.locator("body")
			.evaluate(async (_body, unetName) => {
				const app = (
					globalThis as unknown as {
						comfyAPI?: {
							app?: {
								app?: {
									loadApiJson: (workflow: unknown, name: string) => Promise<void>;
									graphToPrompt: () => Promise<{
										output: Record<
											string,
											{
												class_type: string;
												inputs: Record<string, unknown>;
											}
										>;
									}>;
								};
							};
						};
					}
				).comfyAPI?.app?.app;
				if (!app) throw new Error("ComfyUI app is unavailable.");
				await app.loadApiJson(
					{
						"1": {
							class_type: "UNETLoader",
							inputs: { unet_name: unetName, weight_dtype: "default" },
						},
					},
					"virtual-model",
				);
				const node = Object.values((await app.graphToPrompt()).output).find(
					(candidate) => candidate.class_type === "UNETLoader",
				);
				return {
					type: node?.class_type,
					model: node?.inputs.unet_name,
				};
			}, "v1_5-pruned-emaonly-fp16.safetensors");
		expect(registeredNode).toEqual({
			type: "UNETLoader",
			model: "v1_5-pruned-emaonly-fp16.safetensors",
		});
	} finally {
		await closeDesktop(desktop);
	}
});

test("removes a registered model from the real ComfyUI definitions", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"));

	try {
		const page = await desktop.firstWindow();
		await expect(
			page.frameLocator('iframe[title="ComfyUI"]').locator("canvas").first(),
		).toBeVisible({ timeout: 240_000 });
		await stubModelMetadata(desktop);
		const comfyUrl = await getComfyUrl(page);
		await registerModel(page);
		await removeModel(page);

		const definitionResponse = await fetch(
			new URL("api/object_info/UNETLoader", comfyUrl),
		);
		expect(definitionResponse.ok).toBe(true);
		const definitions = (await definitionResponse.json()) as {
			UNETLoader: { input: { required: { unet_name: [string[]] } } };
		};
		expect(definitions.UNETLoader.input.required.unet_name[0]).not.toContain(
			"v1_5-pruned-emaonly-fp16.safetensors",
		);
	} finally {
		await closeDesktop(desktop);
	}
});

test("opens the desktop when the Model Library database cannot initialize", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const userDataDirectory = join(testRoot, "desktop");
	await mkdir(userDataDirectory, { recursive: true });
	const database = new DatabaseSync(join(userDataDirectory, "kastard.sqlite"));
	database.exec("PRAGMA user_version = 3");
	database.close();
	const desktop = await launchDesktop(comfyDataRoot, userDataDirectory);

	try {
		const page = await desktop.firstWindow();
		await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
		await page.getByRole("button", { name: "Model Library", exact: true }).click();
		await expect(page.getByRole("alert")).toContainText("unsupported schema version");
	} finally {
		await closeDesktop(desktop);
	}
});

test("opens the desktop when model provider settings cannot initialize", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const userDataDirectory = join(testRoot, "desktop");
	await mkdir(userDataDirectory, { recursive: true });
	await writeFile(join(userDataDirectory, "model-provider-settings.json"), "{invalid");
	const desktop = await launchDesktop(comfyDataRoot, userDataDirectory);

	try {
		const page = await desktop.firstWindow();
		await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
		await page.getByRole("button", { name: "Settings" }).click();
		const settings = page.getByTestId("settings-surface");
		await settings.getByRole("button", { name: "Model Providers" }).click();
		await expect(settings.getByRole("alert")).toContainText(
			"Expected property name or '}'",
		);
		await expect(
			settings.getByRole("button", { name: /^Retry .+ settings$/ }),
		).toHaveCount(2);
	} finally {
		await closeDesktop(desktop);
	}
});
