#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cancel, isCancel, select, text } from "@clack/prompts";
import { resolveEditorRelease } from "./editor-release.mjs";
import { readSourceRevision, verifyProductionLineage } from "./release-lineage.mjs";
import { resolveWorkerRelease } from "./worker-release.mjs";

const USAGE =
	"Usage: bun run tag <preview|production> <editor|worker> [production-version]";

function readPackage(root, path) {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}

export function resolveReleaseTag(
	root,
	channel,
	target,
	productVersion,
	sourceRevision,
) {
	if (
		!["preview", "production"].includes(channel) ||
		!["editor", "worker"].includes(target)
	) {
		throw new Error(USAGE);
	}
	if (
		(channel === "preview" && productVersion !== undefined) ||
		(channel === "production" &&
			(typeof productVersion !== "string" ||
				!/^\d+\.\d+\.\d+$/.test(productVersion))) ||
		!/^[0-9a-f]{40}$/.test(sourceRevision)
	) {
		throw new Error(USAGE);
	}

	if (target === "editor") {
		const { build } = readPackage(root, "apps/desktop/package.json");
		const tag =
			channel === "preview"
				? `editor-preview.${build?.buildVersion}`
				: `editor-v${productVersion}`;
		resolveEditorRelease(root, tag, sourceRevision);
		return tag;
	}

	const { buildNumber } = readPackage(root, "apps/server/package.json");
	const tag =
		channel === "preview"
			? `worker-preview.${buildNumber}`
			: `worker-v${productVersion}`;
	resolveWorkerRelease(root, tag, sourceRevision);
	return tag;
}

async function promptForRelease() {
	const channel = await select({
		message: "Select a release channel",
		options: [
			{ label: "Preview", value: "preview" },
			{ label: "Production", value: "production" },
		],
	});
	if (isCancel(channel)) {
		cancel("Tag creation cancelled.");
		return;
	}

	const target = await select({
		message: "Select a release target",
		options: [
			{ label: "Editor", value: "editor" },
			{ label: "Worker", value: "worker" },
		],
	});
	if (isCancel(target)) {
		cancel("Tag creation cancelled.");
		return;
	}

	let productVersion;
	if (channel === "production") {
		productVersion = await text({
			message: "Enter the Production version",
			validate: (value) =>
				/^\d+\.\d+\.\d+$/.test(value)
					? undefined
					: "Enter a stable semantic version such as 0.2.0.",
		});
		if (isCancel(productVersion)) {
			cancel("Tag creation cancelled.");
			return;
		}
	}

	return { channel, productVersion, target };
}

async function main() {
	let [channel, target, productVersion, ...extraArgs] = process.argv.slice(2);
	if (extraArgs.length > 0 || Boolean(channel) !== Boolean(target)) {
		throw new Error(USAGE);
	}
	if (!channel) {
		const selection = await promptForRelease();
		if (!selection) return;
		({ channel, productVersion, target } = selection);
	}

	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const root = resolve(scriptDirectory, "..");
	const sourceRevision = readSourceRevision(root);
	const tag = resolveReleaseTag(root, channel, target, productVersion, sourceRevision);
	const release =
		target === "editor"
			? resolveEditorRelease(root, tag, sourceRevision)
			: resolveWorkerRelease(root, tag, sourceRevision);
	verifyProductionLineage(root, release);
	execFileSync("git", ["tag", tag], { cwd: root, stdio: "inherit" });
	console.log(`Created ${tag}.\nPush with: git push origin ${tag}`);
}

const isDirectExecution =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
	main().catch((error) => {
		console.error(`error: ${error.message}`);
		process.exitCode = 1;
	});
}
