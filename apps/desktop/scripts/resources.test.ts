import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createWorkerTemplateLinks,
	parseResources,
	workerTemplateChannels,
} from "@kastard/common";
import { expect, test } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const resources = parseResources(
	readFileSync(resolve(repositoryRoot, "resources.jsonc"), "utf8"),
);
const composeFileUrl = `${resources.github.replace(
	"https://github.com/",
	"https://raw.githubusercontent.com/",
)}/main/compose.yaml`;

test("derives distinct public RunPod template links", () => {
	const templateLinks = workerTemplateChannels.flatMap((channel) =>
		Object.values(createWorkerTemplateLinks(resources, "runpod", channel)),
	);
	expect(new Set(templateLinks).size).toBe(4);
	for (const link of templateLinks) {
		expect(link).toMatch(/^https:\/\/console\.runpod\.io\/hub\/template\/[a-z0-9]+$/);
	}
});

test("keeps static external resource mirrors aligned with resources.jsonc", () => {
	const staticMirrors = [
		{
			path: "apps/desktop/resources/Credits.html",
			values: [resources.docs.home, resources.github, resources.discord],
		},
		{
			path: "apps/worker/worker-templates/template.md",
			values: [resources.github, resources.docs.home, resources.discord],
		},
		{
			path: "docs/docs.json",
			values: [resources.github, resources.discord],
		},
		{
			path: "README.md",
			values: [
				resources.docs.home,
				resources.docs.gettingStarted,
				resources.docs.runWorkerWithDocker,
				resources.docs.editAndRunWorkflows,
				resources.docs.addModelsAndCustomNodes,
				resources.discord,
			],
		},
		{
			path: "docs/en/run-worker-with-docker.mdx",
			values: [
				composeFileUrl,
				`docker.io/${resources.dockerHub.cu128}:latest`,
				`docker.io/${resources.dockerHub.cu130}:latest`,
			],
		},
		{
			path: "docs/ko/run-worker-with-docker.mdx",
			values: [
				composeFileUrl,
				`docker.io/${resources.dockerHub.cu128}:latest`,
				`docker.io/${resources.dockerHub.cu130}:latest`,
			],
		},
	] as const;

	for (const mirror of staticMirrors) {
		const contents = readFileSync(resolve(repositoryRoot, mirror.path), "utf8");
		const references =
			contents.match(/(?:https:\/\/|docker\.io\/)[^\s"'`()<>]+/g) ?? [];
		for (const value of mirror.values) {
			expect(references, `${mirror.path} must reference ${value}`).toContain(value);
		}
	}
});

test("keeps release Worker image repositories aligned with resources.jsonc", () => {
	const workerImageScript = readFileSync(
		resolve(repositoryRoot, "scripts/worker-image.sh"),
		"utf8",
	);
	const repositoryTemplate = workerImageScript.match(
		/image="([^"]+\$\{runtime\}):\$\{base_tag\}"/,
	)?.[1];

	expect(
		repositoryTemplate,
		"scripts/worker-image.sh must define a runtime repository template",
	).toBeDefined();
	for (const runtime of ["cu128", "cu130"] as const) {
		expect(repositoryTemplate?.replace(/\$\{runtime\}/, runtime)).toBe(
			resources.dockerHub[runtime],
		);
	}
});
