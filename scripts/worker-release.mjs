#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSourceRevision, verifyProductionLineage } from "./release-lineage.mjs";

const BUILD_NUMBER_PATTERN = /^[1-9]\d*$/;
const PREVIEW_TAG_PATTERN = /^worker-preview\.([1-9]\d*)(?:-([1-9]\d*))?$/;
const PRODUCTION_TAG_PATTERN = /^worker-v(\d+\.\d+\.\d+)(?:-([1-9]\d*))?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function readWorkerPackage(root) {
	const path = join(root, "apps/server/package.json");
	let packageJson;
	try {
		packageJson = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error.message}`);
	}

	const { buildNumber, version: packageVersion } = packageJson;
	if (typeof packageVersion !== "string" || !VERSION_PATTERN.test(packageVersion)) {
		throw new Error(
			"apps/server/package.json must contain a technical semantic version.",
		);
	}
	if (
		typeof buildNumber !== "string" ||
		!BUILD_NUMBER_PATTERN.test(buildNumber) ||
		!Number.isSafeInteger(Number(buildNumber))
	) {
		throw new Error(
			"apps/server/package.json must contain a safe positive integer buildNumber.",
		);
	}

	return { buildNumber };
}

export function resolveWorkerRelease(root, tag, sourceRevision) {
	const { buildNumber } = readWorkerPackage(root);
	if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
		throw new Error("The Worker source revision must be a full Git commit SHA.");
	}
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
