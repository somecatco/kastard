#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_VERSION_PATTERN = /^[1-9]\d*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function readDesktopPackage(root) {
	const path = join(root, "apps/desktop/package.json");
	let packageJson;
	try {
		packageJson = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error.message}`);
	}

	const { version } = packageJson;
	const buildVersion = packageJson?.build?.buildVersion;
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
		throw new Error(
			"apps/desktop/package.json must contain a stable semantic version.",
		);
	}
	if (typeof buildVersion !== "string" || !BUILD_VERSION_PATTERN.test(buildVersion)) {
		throw new Error(
			"apps/desktop/package.json must contain a positive integer buildVersion.",
		);
	}

	return { buildVersion, version };
}

export function resolveEditorRelease(root, tag) {
	const { buildVersion, version } = readDesktopPackage(root);
	const betaTag = `editor-v${version}-beta.${buildVersion}`;
	const productionTag = `editor-v${version}`;

	if (tag === betaTag) {
		return {
			appId: "co.somecat.kastard.beta",
			appName: "Kastard Beta",
			artifactName: `Kastard-Beta-${version}+${buildVersion}-arm64.dmg`,
			buildScript: "build:beta",
			buildVersion,
			outputDirectory: "dist/beta",
			prerelease: true,
			releaseName: `Kastard Beta ${version} (${buildVersion})`,
			version,
		};
	}

	if (tag === productionTag) {
		return {
			appId: "co.somecat.kastard",
			appName: "Kastard",
			artifactName: `Kastard-${version}+${buildVersion}-arm64.dmg`,
			buildScript: "build:production",
			buildVersion,
			outputDirectory: "dist/production",
			prerelease: false,
			releaseName: `Kastard ${version} (${buildVersion})`,
			version,
		};
	}

	throw new Error(
		`Tag ${JSON.stringify(tag)} does not match ${productionTag} or ${betaTag}.`,
	);
}

function printGitHubOutputs(release) {
	for (const [key, value] of Object.entries(release)) {
		const outputKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
		console.log(`${outputKey}=${value}`);
	}
}

function main() {
	const [tag, ...extraArgs] = process.argv.slice(2);
	if (!tag || extraArgs.length > 0) {
		throw new Error("Usage: node scripts/editor-release.mjs <tag>");
	}

	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	printGitHubOutputs(resolveEditorRelease(resolve(scriptDirectory, ".."), tag));
}

const isDirectExecution =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
	try {
		main();
	} catch (error) {
		console.error(`error: ${error.message}`);
		process.exitCode = 1;
	}
}
