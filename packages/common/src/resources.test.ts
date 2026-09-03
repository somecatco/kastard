import { describe, expect, test } from "bun:test";
import { createWorkerTemplateLinks, parseResources } from "./resources";

const validResources = {
	github: "https://github.com/somecatco/kastard",
	downloads: {
		editorMacArm64:
			"https://github.com/somecatco/kastard/releases/latest/download/Kastard-arm64.dmg",
	},
	docs: {
		home: "https://docs.example.com",
		gettingStarted: "https://docs.example.com/getting-started",
		runWorkerWithDocker: "https://docs.example.com/worker",
		editAndRunWorkflows: "https://docs.example.com/workflows",
		addModelsAndCustomNodes: "https://docs.example.com/models",
	},
	discord: "https://discord.gg/example",
	dockerHub: {
		cu128: "somecatco/kastard-worker-cu128",
		cu130: "somecatco/kastard-worker-cu130",
	},
	workerTemplates: {
		runpod: {
			hub: "https://console.runpod.io/hub/template",
			production: { cu128: "runpod128", cu130: "runpod130" },
			preview: { cu128: "preview128", cu130: "preview130" },
		},
		vastAi: {
			marketplace: "https://cloud.vast.ai/",
			creatorId: 123,
			production: { cu128: 128, cu130: 130 },
			preview: { cu128: 1128, cu130: 1130 },
		},
	},
};

describe("Resources", () => {
	test("parses public destinations and provider template IDs from JSONC", () => {
		const source = `// Public Kastard resources\n${JSON.stringify(validResources)}`;
		expect(parseResources(source)).toEqual(validResources);
	});

	test("requires valid RunPod and Vast.ai template IDs", () => {
		expect(() =>
			parseResources(
				JSON.stringify({
					...validResources,
					workerTemplates: {
						...validResources.workerTemplates,
						runpod: {
							...validResources.workerTemplates.runpod,
							production: {
								...validResources.workerTemplates.runpod.production,
								cu128: "",
							},
						},
					},
				}),
			),
		).toThrow("workerTemplates.runpod.production.cu128");
		expect(() =>
			parseResources(
				JSON.stringify({
					...validResources,
					workerTemplates: {
						...validResources.workerTemplates,
						vastAi: {
							...validResources.workerTemplates.vastAi,
							preview: {
								...validResources.workerTemplates.vastAi.preview,
								cu130: 0,
							},
						},
					},
				}),
			),
		).toThrow("workerTemplates.vastAi.preview.cu130");
	});

	test("requires unique IDs for every provider target", () => {
		expect(() =>
			parseResources(
				JSON.stringify({
					...validResources,
					workerTemplates: {
						...validResources.workerTemplates,
						runpod: {
							...validResources.workerTemplates.runpod,
							preview: {
								...validResources.workerTemplates.runpod.preview,
								cu128: validResources.workerTemplates.runpod.production.cu128,
							},
						},
					},
				}),
			),
		).toThrow("runpod template IDs must be unique");
	});

	test("derives provider links from channel identities", () => {
		const resources = parseResources(JSON.stringify(validResources));
		expect(createWorkerTemplateLinks(resources, "runpod", "production")).toEqual({
			cu128: "https://console.runpod.io/hub/template/runpod128",
			cu130: "https://console.runpod.io/hub/template/runpod130",
		});
		expect(createWorkerTemplateLinks(resources, "vastAi", "preview")).toEqual({
			cu128: "https://cloud.vast.ai/?creator_id=123&name=kastard-worker-preview-cu128",
			cu130: "https://cloud.vast.ai/?creator_id=123&name=kastard-worker-preview-cu130",
		});
	});
});
