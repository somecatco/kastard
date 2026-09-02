import { join } from "node:path";
import { closeDesktop, expect, launchDesktop, test } from "./test-harness";

test("restores ComfyUI workflow widget values by name", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const desktop = await launchDesktop(comfyDataRoot, join(testRoot, "desktop"));

	try {
		const page = await desktop.firstWindow();
		const comfyFrame = page.locator('iframe[title="ComfyUI"]');
		await expect(comfyFrame).toBeAttached({ timeout: 240_000 });
		const comfyUrl = await comfyFrame.getAttribute("src");
		if (!comfyUrl) throw new Error("ComfyUI URL is not available.");
		const comfy = page.frameLocator('iframe[title="ComfyUI"]');
		await expect(comfy.locator("canvas").first()).toBeVisible({ timeout: 45_000 });
		await expect
			.poll(() =>
				comfy.locator("body").evaluate(() =>
					Boolean(
						(
							globalThis as unknown as {
								comfyAPI?: {
									app?: { app?: { canvas?: { setGraph?: unknown } } };
								};
							}
						).comfyAPI?.app?.app?.canvas?.setGraph,
					),
				),
			)
			.toBe(true);

		const setting = await fetch(
			new URL("api/settings/Comfy.Workflow.NamedValuesRestore", comfyUrl),
		);
		expect(setting.ok).toBe(true);
		expect(await setting.json()).toBe(true);

		const restored = await comfy.locator("body").evaluate(async () => {
			const app = (
				globalThis as unknown as {
					comfyAPI?: {
						app?: {
							app?: {
								loadGraphData: (workflow: unknown) => Promise<void>;
								graphToPrompt: () => Promise<{
									workflow: {
										extra?: { frontendVersion?: string };
										nodes: Array<{
											id: number;
											widgets_values_named?: Record<string, unknown>;
										}>;
									};
									output: Record<string, { inputs: Record<string, unknown> }>;
								}>;
							};
						};
					};
				}
			).comfyAPI?.app?.app;
			if (!app) throw new Error("ComfyUI app is unavailable.");
			await app.loadGraphData({
				last_node_id: 1,
				last_link_id: 0,
				nodes: [
					{
						id: 1,
						type: "EmptyLatentImage",
						pos: [0, 0],
						size: [315, 106],
						flags: {},
						order: 0,
						mode: 0,
						outputs: [{ name: "LATENT", type: "LATENT", links: null }],
						properties: { "Node name for S&R": "EmptyLatentImage" },
						widgets_values: [64, 64, 1],
						widgets_values_named: {
							width: 512,
							height: 768,
							batch_size: 2,
						},
					},
				],
				links: [],
				groups: [],
				config: {},
				extra: {},
				version: 0.4,
			});
			const prompt = await app.graphToPrompt();
			return {
				frontendVersion: prompt.workflow.extra?.frontendVersion,
				inputs: prompt.output["1"]?.inputs,
				namedValues: prompt.workflow.nodes.find((candidate) => candidate.id === 1)
					?.widgets_values_named,
			};
		});

		expect(restored).toEqual({
			frontendVersion: "1.52.1",
			inputs: { width: 512, height: 768, batch_size: 2 },
			namedValues: { width: 512, height: 768, batch_size: 2 },
		});
	} finally {
		await closeDesktop(desktop);
	}
});

test("restores the active ComfyUI workflow after restarting the desktop", async ({
	comfyDataRoot,
	testRoot,
}) => {
	const userDataDirectory = join(testRoot, "desktop");
	const marker = "KAS-69 workflow draft";
	const launch = () => launchDesktop(comfyDataRoot, userDataDirectory);
	let firstComfyUrl: string | null = null;

	const firstDesktop = await launch();
	try {
		const page = await firstDesktop.firstWindow();
		const comfyFrame = page.locator('iframe[title="ComfyUI"]');
		await expect(comfyFrame).toBeAttached({ timeout: 240_000 });
		firstComfyUrl = await comfyFrame.getAttribute("src");
		const comfy = page.frameLocator('iframe[title="ComfyUI"]');
		await expect(comfy.locator("canvas").first()).toBeVisible({ timeout: 45_000 });
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
		await comfy.locator("body").evaluate(async (_body, workflowMarker) => {
			const app = (
				globalThis as unknown as {
					comfyAPI?: {
						app?: {
							app?: {
								loadApiJson: (workflow: unknown, name: string) => Promise<void>;
							};
						};
					};
				}
			).comfyAPI?.app?.app;
			if (!app) throw new Error("ComfyUI app is unavailable.");
			await app.loadApiJson(
				{
					"1": {
						class_type: "CLIPTextEncode",
						inputs: { text: workflowMarker },
					},
				},
				"restart-restore",
			);
		}, marker);
		await expect
			.poll(() =>
				comfy.locator("body").evaluate((_body, workflowMarker) => {
					return Object.keys(localStorage)
						.filter((key) => key.startsWith("Comfy.Workflow.Draft"))
						.some((key) => localStorage.getItem(key)?.includes(workflowMarker));
				}, marker),
			)
			.toBe(true);
	} finally {
		await closeDesktop(firstDesktop);
	}

	if (firstComfyUrl === null) throw new Error("ComfyUI URL is unavailable.");
	const stableComfyUrl = firstComfyUrl;

	const restoredDesktop = await launch();
	try {
		const page = await restoredDesktop.firstWindow();
		const comfyFrame = page.locator('iframe[title="ComfyUI"]');
		await expect(comfyFrame).toBeAttached({ timeout: 240_000 });
		expect(await comfyFrame.getAttribute("src")).toBe(stableComfyUrl);
		const comfy = page.frameLocator('iframe[title="ComfyUI"]');
		await expect(comfy.locator("canvas").first()).toBeVisible({ timeout: 45_000 });
		await expect
			.poll(() =>
				comfy.locator("body").evaluate((_body, workflowMarker) => {
					const app = (
						globalThis as unknown as {
							comfyAPI?: {
								app?: {
									app?: {
										rootGraph?: {
											nodes: Array<{
												widgets?: Array<{ value?: unknown }>;
											}>;
										};
									};
								};
							};
						}
					).comfyAPI?.app?.app;
					return Boolean(
						app?.rootGraph?.nodes.some((node) =>
							node.widgets?.some((widget) => widget.value === workflowMarker),
						),
					);
				}, marker),
			)
			.toBe(true);
	} finally {
		await closeDesktop(restoredDesktop);
	}
});
