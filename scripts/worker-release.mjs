#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_NUMBER_PATTERN = /^[1-9]\d*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function readWorkerPackage(root) {
	const path = join(root, "apps/server/package.json");
	let packageJson;
	try {
		packageJson = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error.message}`);
	}

	const { buildNumber, version } = packageJson;
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
		throw new Error("apps/server/package.json must contain a stable semantic version.");
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

	return { buildNumber, version };
}

export function resolveWorkerRelease(root, tag) {
	const { buildNumber, version } = readWorkerPackage(root);
	const betaTag = `worker-v${version}-beta.${buildNumber}`;
	const productionTag = `worker-v${version}`;
	const channel =
		tag === betaTag ? "beta" : tag === productionTag ? "production" : null;
	if (channel === null) {
		throw new Error(
			`Tag ${JSON.stringify(tag)} does not match ${betaTag} or ${productionTag}.`,
		);
	}

	return {
		buildNumber,
		channel,
		version,
	};
}

function main() {
	const [tag, ...extraArgs] = process.argv.slice(2);
	if (!tag || extraArgs.length > 0) {
		throw new Error("Usage: node scripts/worker-release.mjs <tag>");
	}

	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const release = resolveWorkerRelease(resolve(scriptDirectory, ".."), tag);
	const channel = release.channel === "beta" ? "Beta" : "Production";
	console.log(`Worker ${channel} ${release.version} (${release.buildNumber})`);
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
