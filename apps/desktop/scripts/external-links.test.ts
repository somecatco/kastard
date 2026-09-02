import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parseExternalLinks } from "../src/shared/external-links";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const externalLinks = parseExternalLinks(
	readFileSync(resolve(repositoryRoot, "LINKS.jsonc"), "utf8"),
);

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
			values: [externalLinks.discord],
		},
		{
			path: "docs/en/run-worker-with-docker.mdx",
			values: [
				`docker.io/${externalLinks.dockerHub.cu128}:latest`,
				`docker.io/${externalLinks.dockerHub.cu130}:latest`,
			],
		},
		{
			path: "docs/ko/run-worker-with-docker.mdx",
			values: [
				`docker.io/${externalLinks.dockerHub.cu128}:latest`,
				`docker.io/${externalLinks.dockerHub.cu130}:latest`,
			],
		},
	] as const;

	for (const mirror of staticMirrors) {
		const contents = readFileSync(resolve(repositoryRoot, mirror.path), "utf8");
		for (const value of mirror.values) {
			expect(contents, `${mirror.path} must contain ${value}`).toContain(value);
		}
	}
});
