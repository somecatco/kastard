#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cancel, isCancel, select } from "@clack/prompts";
import { resolveEditorRelease } from "./editor-release.mjs";
import { resolveWorkerRelease } from "./worker-release.mjs";

const USAGE = "Usage: bun run tag <beta|production> <editor|worker>";

function readPackage(root, path) {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}

export function resolveReleaseTag(root, channel, target) {
	if (
		!["beta", "production"].includes(channel) ||
		!["editor", "worker"].includes(target)
	) {
		throw new Error(USAGE);
	}

	if (target === "editor") {
		const { build, version } = readPackage(root, "apps/desktop/package.json");
		const tag = `editor-v${version}${channel === "beta" ? `-beta.${build?.buildVersion}` : ""}`;
		resolveEditorRelease(root, tag);
		return tag;
	}

	const { buildNumber, version } = readPackage(root, "apps/server/package.json");
	const tag = `worker-v${version}${channel === "beta" ? `-beta.${buildNumber}` : ""}`;
	resolveWorkerRelease(root, tag);
	return tag;
}

async function promptForRelease() {
	const channel = await select({
		message: "Select a release channel",
		options: [
			{ label: "Beta", value: "beta" },
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

	return { channel, target };
}

async function main() {
	let [channel, target, ...extraArgs] = process.argv.slice(2);
	if (extraArgs.length > 0 || Boolean(channel) !== Boolean(target)) {
		throw new Error(USAGE);
	}
	if (!channel) {
		const selection = await promptForRelease();
		if (!selection) return;
		({ channel, target } = selection);
	}

	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const root = resolve(scriptDirectory, "..");
	const tag = resolveReleaseTag(root, channel, target);
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
