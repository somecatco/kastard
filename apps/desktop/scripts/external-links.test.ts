import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parseExternalLinks } from "../src/shared/external-links";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const externalLinks = parseExternalLinks(
	readFileSync(resolve(repositoryRoot, "LINKS.jsonc"), "utf8"),
);
const composeFileUrl = `${externalLinks.github.replace(
	"https://github.com/",
	"https://raw.githubusercontent.com/",
)}/main/compose.yaml`;

test("keeps static external link mirrors aligned with LINKS.jsonc", () => {
	const staticMirrors = [
		{
			path: "apps/desktop/resources/Credits.html",
			values: [externalLinks.docs.home, externalLinks.github, externalLinks.discord],
		},
		{
			path: "apps/server/worker-templates/template.md",
			values: [externalLinks.github, externalLinks.docs.home, externalLinks.discord],
		},
		{
			path: "docs/docs.json",
			values: [externalLinks.github, externalLinks.discord],
		},
		{
			path: "README.md",
			values: [
				externalLinks.docs.home,
				`${externalLinks.docs.home}/en/getting-started`,
				externalLinks.docs.runWorkerWithDocker,
				`${externalLinks.docs.home}/en/edit-and-run-workflows`,
				`${externalLinks.docs.home}/en/add-models-and-custom-nodes`,
				externalLinks.discord,
			],
		},
		{
			path: "docs/en/run-worker-with-docker.mdx",
			values: [
				composeFileUrl,
				`docker.io/${externalLinks.dockerHub.cu128}:latest`,
				`docker.io/${externalLinks.dockerHub.cu130}:latest`,
			],
		},
		{
			path: "docs/ko/run-worker-with-docker.mdx",
			values: [
				composeFileUrl,
				`docker.io/${externalLinks.dockerHub.cu128}:latest`,
				`docker.io/${externalLinks.dockerHub.cu130}:latest`,
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

test("keeps release Worker image repositories aligned with LINKS.jsonc", () => {
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
			externalLinks.dockerHub[runtime],
		);
	}
});
