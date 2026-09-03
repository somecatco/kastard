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
	"Usage: bun run tag [<release-tag> | <preview|production> <editor|worker> [production-version]]";

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

	const { buildNumber } = readPackage(root, "apps/worker/package.json");
	const tag =
		channel === "preview"
			? `worker-preview.${buildNumber}`
			: `worker-v${productVersion}`;
	resolveWorkerRelease(root, tag, sourceRevision);
	return tag;
}

export function resolveEnteredReleaseTag(root, tag, sourceRevision) {
	if (tag.startsWith("editor-")) {
		return {
			release: resolveEditorRelease(root, tag, sourceRevision),
			target: "editor",
		};
	}
	if (tag.startsWith("worker-")) {
		return {
			release: resolveWorkerRelease(root, tag, sourceRevision),
			target: "worker",
		};
	}
	throw new Error(`Tag ${JSON.stringify(tag)} must target editor or worker.`);
}

async function promptForRelease(root, sourceRevision) {
	const channel = await select({
		message: "Select a release tag",
		options: [
			{ label: "Preview", value: "preview" },
			{ label: "Production", value: "production" },
			{ label: "Enter tag directly", value: "direct" },
		],
	});
	if (isCancel(channel)) {
		cancel("Tag creation cancelled.");
		return;
	}
	if (channel === "direct") {
		const tag = await text({
			message: "Enter the release tag",
			placeholder: "editor-preview.16-1",
			validate: (value) => {
				try {
					resolveEnteredReleaseTag(root, value, sourceRevision);
				} catch (error) {
					return error.message;
				}
			},
		});
		if (isCancel(tag)) {
			cancel("Tag creation cancelled.");
			return;
		}
		return { tag };
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
	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const root = resolve(scriptDirectory, "..");
	const sourceRevision = readSourceRevision(root);
	const args = process.argv.slice(2);
	let tag;
	if (args.length === 0) {
		const selection = await promptForRelease(root, sourceRevision);
		if (!selection) return;
		tag =
			selection.tag ??
			resolveReleaseTag(
				root,
				selection.channel,
				selection.target,
				selection.productVersion,
				sourceRevision,
			);
	} else if (args.length === 1) {
		[tag] = args;
	} else {
		const [channel, target, productVersion, ...extraArgs] = args;
		if (extraArgs.length > 0) throw new Error(USAGE);
		tag = resolveReleaseTag(root, channel, target, productVersion, sourceRevision);
	}

	const { release } = resolveEnteredReleaseTag(root, tag, sourceRevision);
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
