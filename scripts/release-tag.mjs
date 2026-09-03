#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cancel, isCancel, select, text } from "@clack/prompts";
import { resolveEditorRelease } from "./editor-release.mjs";
import {
	readJsonAtRevision,
	readSourceRevision,
	verifyProductionLineage,
} from "./release-lineage.mjs";
import { resolveWorkerRelease } from "./worker-release.mjs";

const USAGE =
	"Usage: bun run tag [<release-tag> [preview-tag] | preview <editor|worker> | production <editor|worker> <version> [preview-tag]]";

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
		const { build } = readJsonAtRevision(
			root,
			"apps/desktop/package.json",
			sourceRevision,
		);
		const tag =
			channel === "preview"
				? `editor-preview.${build?.buildVersion}`
				: `editor-v${productVersion}`;
		resolveEditorRelease(root, tag, sourceRevision);
		return tag;
	}

	const { buildNumber } = readJsonAtRevision(
		root,
		"apps/worker/package.json",
		sourceRevision,
	);
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

export function resolvePreviewTag(root, tag) {
	let sourceRevision;
	try {
		sourceRevision = execFileSync("git", ["rev-parse", `refs/tags/${tag}^{commit}`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		throw new Error(`Preview tag ${JSON.stringify(tag)} does not exist.`);
	}

	const { release, target } = resolveEnteredReleaseTag(root, tag, sourceRevision);
	if (release.channel !== "preview") {
		throw new Error(`Tag ${JSON.stringify(tag)} is not a Preview tag.`);
	}
	return { sourceRevision, tag, target };
}

export function listPreviewTags(root, target) {
	if (!["editor", "worker"].includes(target)) throw new Error(USAGE);
	return execFileSync(
		"git",
		["tag", "--list", "--sort=-version:refname", `${target}-preview.*`],
		{ cwd: root, encoding: "utf8" },
	)
		.split("\n")
		.filter(Boolean)
		.flatMap((tag) => {
			try {
				const preview = resolvePreviewTag(root, tag);
				return preview.target === target ? [preview] : [];
			} catch {
				return [];
			}
		});
}

async function promptForPreview(root, target) {
	const previews = listPreviewTags(root, target);
	if (previews.length === 0) {
		throw new Error(`No valid ${target} Preview tags are available to promote.`);
	}
	const tag = await select({
		message: "Select a Preview to promote",
		options: previews.map((preview) => ({
			label: `${preview.tag} (${preview.sourceRevision.slice(0, 7)})`,
			value: preview.tag,
		})),
	});
	if (isCancel(tag)) {
		cancel("Tag creation cancelled.");
		return;
	}
	return resolvePreviewTag(root, tag);
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
		const entered = resolveEnteredReleaseTag(root, tag, sourceRevision);
		if (entered.release.channel === "production") {
			const preview = await promptForPreview(root, entered.target);
			if (!preview) return;
			return { sourceRevision: preview.sourceRevision, tag };
		}
		return { sourceRevision, tag };
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
	let productionSource;
	if (channel === "production") {
		productionSource = await promptForPreview(root, target);
		if (!productionSource) return;
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

	return {
		channel,
		productVersion,
		sourceRevision: productionSource?.sourceRevision ?? sourceRevision,
		target,
	};
}

export function resolveCliRelease(root, args, sourceRevision) {
	if (args[0] === "preview") {
		if (args.length !== 2) throw new Error(USAGE);
		return {
			sourceRevision,
			tag: resolveReleaseTag(root, "preview", args[1], undefined, sourceRevision),
		};
	}

	if (args[0] === "production") {
		if (args.length < 3 || args.length > 4) throw new Error(USAGE);
		const [, target, productVersion, previewTag] = args;
		const preview = previewTag ? resolvePreviewTag(root, previewTag) : undefined;
		if (preview && preview.target !== target) {
			throw new Error(`${preview.tag} cannot be promoted to ${target} Production.`);
		}
		const productionSourceRevision = preview?.sourceRevision ?? sourceRevision;
		return {
			sourceRevision: productionSourceRevision,
			tag: resolveReleaseTag(
				root,
				"production",
				target,
				productVersion,
				productionSourceRevision,
			),
		};
	}

	if (args.length < 1 || args.length > 2) throw new Error(USAGE);
	const [tag, previewTag] = args;
	if (!previewTag) return { sourceRevision, tag };

	const preview = resolvePreviewTag(root, previewTag);
	const entered = resolveEnteredReleaseTag(root, tag, preview.sourceRevision);
	if (entered.release.channel !== "production" || entered.target !== preview.target) {
		throw new Error(`${preview.tag} cannot be promoted as ${tag}.`);
	}
	return { sourceRevision: preview.sourceRevision, tag };
}

export function createReleaseTag(root, tag, sourceRevision) {
	const { release } = resolveEnteredReleaseTag(root, tag, sourceRevision);
	verifyProductionLineage(root, release);
	execFileSync("git", ["tag", tag, sourceRevision], {
		cwd: root,
		stdio: "inherit",
	});
}

async function main() {
	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const root = resolve(scriptDirectory, "..");
	const sourceRevision = readSourceRevision(root);
	const args = process.argv.slice(2);
	let tag;
	let tagSourceRevision = sourceRevision;
	if (args.length === 0) {
		const selection = await promptForRelease(root, sourceRevision);
		if (!selection) return;
		tagSourceRevision = selection.sourceRevision;
		tag =
			selection.tag ??
			resolveReleaseTag(
				root,
				selection.channel,
				selection.target,
				selection.productVersion,
				tagSourceRevision,
			);
	} else {
		const release = resolveCliRelease(root, args, sourceRevision);
		tag = release.tag;
		tagSourceRevision = release.sourceRevision;
	}

	createReleaseTag(root, tag, tagSourceRevision);
	console.log(
		`Created ${tag} at ${tagSourceRevision}.\nPush with: git push origin ${tag}`,
	);
}

const isDirectExecution =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
	main().catch((error) => {
		console.error(`error: ${error.message}`);
		process.exitCode = 1;
	});
}
