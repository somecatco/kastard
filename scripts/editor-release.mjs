#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSourceRevision, verifyProductionLineage } from "./release-lineage.mjs";

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

	const { version: packageVersion } = packageJson;
	const buildVersion = packageJson?.build?.buildVersion;
	if (typeof packageVersion !== "string" || !VERSION_PATTERN.test(packageVersion)) {
		throw new Error(
			"apps/desktop/package.json must contain a technical semantic version.",
		);
	}
	if (
		typeof buildVersion !== "string" ||
		!BUILD_VERSION_PATTERN.test(buildVersion) ||
		!Number.isSafeInteger(Number(buildVersion))
	) {
		throw new Error(
			"apps/desktop/package.json must contain a safe positive integer buildVersion.",
		);
	}

	return { buildVersion, packageVersion };
}

export function resolveEditorRelease(root, tag, sourceRevision) {
	const { buildVersion, packageVersion } = readDesktopPackage(root);
	if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
		throw new Error("The Editor source revision must be a full Git commit SHA.");
	}
	const shortRevision = sourceRevision.slice(0, 7);
	const previewTag = `editor-preview.${buildVersion}`;

	if (tag === previewTag) {
		return {
			appId: "co.somecat.kastard.preview",
			appName: "Kastard Preview",
			artifactName: `Kastard-Preview-${buildVersion}+${shortRevision}-arm64.dmg`,
			buildScript: "build:preview",
			buildVersion,
			bundleVersion: packageVersion,
			channel: "preview",
			outputDirectory: "dist/preview",
			prerelease: true,
			productVersion: null,
			releaseName: `Kastard Preview ${buildVersion} (${shortRevision})`,
			sourceRevision,
		};
	}

	const productionMatch = /^editor-v(\d+\.\d+\.\d+)$/.exec(tag);
	if (productionMatch !== null) {
		const productVersion = productionMatch[1];
		return {
			appId: "co.somecat.kastard",
			appName: "Kastard",
			artifactName: `Kastard-${productVersion}+${buildVersion}-${shortRevision}-arm64.dmg`,
			buildScript: "build:production",
			buildVersion,
			bundleVersion: productVersion,
			channel: "production",
			outputDirectory: "dist/production",
			prerelease: false,
			previewTag,
			productVersion,
			releaseName: `Kastard ${productVersion} (${buildVersion}, ${shortRevision})`,
			sourceRevision,
		};
	}

	throw new Error(
		`Tag ${JSON.stringify(tag)} does not match ${previewTag} or editor-v{version}.`,
	);
}

function printGitHubOutputs(release) {
	for (const [key, value] of Object.entries(release)) {
		const outputKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
		console.log(`${outputKey}=${value ?? ""}`);
	}
}

function main() {
	const [tag, ...extraArgs] = process.argv.slice(2);
	if (!tag || extraArgs.length > 0) {
		throw new Error("Usage: node scripts/editor-release.mjs <tag>");
	}

	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const root = resolve(scriptDirectory, "..");
	const release = resolveEditorRelease(root, tag, readSourceRevision(root));
	verifyProductionLineage(root, release);
	printGitHubOutputs(release);
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
