#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readJsonAtRevision,
	readSourceRevision,
	verifyProductionLineage,
} from "./release-lineage.mjs";

const BUILD_VERSION_PATTERN = /^[1-9]\d*$/;
const PREVIEW_TAG_PATTERN = /^editor-preview\.([1-9]\d*)(?:-([1-9]\d*))?$/;
const PRODUCTION_TAG_PATTERN = /^editor-v(\d+\.\d+\.\d+)(?:-([1-9]\d*))?$/;
const SOURCE_PACKAGE_VERSION = "0.0.0";

function readDesktopPackage(root, sourceRevision) {
	const packageJson = readJsonAtRevision(
		root,
		"apps/desktop/package.json",
		sourceRevision,
	);
	const { version: packageVersion } = packageJson;
	const buildVersion = packageJson?.build?.buildVersion;
	if (packageVersion !== SOURCE_PACKAGE_VERSION) {
		throw new Error(
			`apps/desktop/package.json must keep version ${SOURCE_PACKAGE_VERSION}; Production versions come from release tags.`,
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
	if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
		throw new Error("The Editor source revision must be a full Git commit SHA.");
	}
	const { buildVersion, packageVersion } = readDesktopPackage(root, sourceRevision);
	const shortRevision = sourceRevision.slice(0, 7);
	const previewTag = `editor-preview.${buildVersion}`;
	const previewMatch = PREVIEW_TAG_PATTERN.exec(tag);

	if (previewMatch?.[1] === buildVersion) {
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

	const productionMatch = PRODUCTION_TAG_PATTERN.exec(tag);
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
		`Tag ${JSON.stringify(tag)} does not match ${previewTag}[-{number}] or editor-v{version}[-{number}].`,
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
