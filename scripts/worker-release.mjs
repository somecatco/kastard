#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readJsonAtRevision,
	readSourceRevision,
	verifyProductionLineage,
} from "./release-lineage.mjs";

const BUILD_NUMBER_PATTERN = /^[1-9]\d*$/;
const PREVIEW_TAG_PATTERN = /^worker-preview\.([1-9]\d*)(?:-([1-9]\d*))?$/;
const PRODUCTION_TAG_PATTERN = /^worker-v(\d+\.\d+\.\d+)(?:-([1-9]\d*))?$/;
const SOURCE_PACKAGE_VERSION = "0.0.0";

function readWorkerPackage(root, sourceRevision) {
	const packageJson = readJsonAtRevision(
		root,
		"apps/worker/package.json",
		sourceRevision,
	);
	const { buildNumber, version: packageVersion } = packageJson;
	if (packageVersion !== SOURCE_PACKAGE_VERSION) {
		throw new Error(
			`apps/worker/package.json must keep version ${SOURCE_PACKAGE_VERSION}; Production versions come from release tags.`,
		);
	}
	if (
		typeof buildNumber !== "string" ||
		!BUILD_NUMBER_PATTERN.test(buildNumber) ||
		!Number.isSafeInteger(Number(buildNumber))
	) {
		throw new Error(
			"apps/worker/package.json must contain a safe positive integer buildNumber.",
		);
	}

	return { buildNumber };
}

export function resolveWorkerRelease(root, tag, sourceRevision) {
	if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
		throw new Error("The Worker source revision must be a full Git commit SHA.");
	}
	const { buildNumber } = readWorkerPackage(root, sourceRevision);
	const previewTag = `worker-preview.${buildNumber}`;
	const previewMatch = PREVIEW_TAG_PATTERN.exec(tag);
	if (previewMatch?.[1] === buildNumber) {
		return {
			buildNumber,
			channel: "preview",
			productVersion: null,
			sourceRevision,
		};
	}

	const productionMatch = PRODUCTION_TAG_PATTERN.exec(tag);
	if (productionMatch === null) {
		throw new Error(
			`Tag ${JSON.stringify(tag)} does not match ${previewTag}[-{number}] or worker-v{version}[-{number}].`,
		);
	}
	return {
		buildNumber,
		channel: "production",
		previewTag,
		productVersion: productionMatch[1],
		sourceRevision,
	};
}

function main() {
	const [tag, ...extraArgs] = process.argv.slice(2);
	if (!tag || extraArgs.length > 0) {
		throw new Error("Usage: node scripts/worker-release.mjs <tag>");
	}

	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const root = resolve(scriptDirectory, "..");
	const release = resolveWorkerRelease(root, tag, readSourceRevision(root));
	verifyProductionLineage(root, release);
	for (const [key, value] of Object.entries(release)) {
		const outputKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
		console.log(`${outputKey}=${value ?? ""}`);
	}
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
