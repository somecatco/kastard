#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROFILES = ["cu128", "cu130"];
const LAYERS = ["cuda-core", "cuda-auxiliary", "framework", "application"];
const FRAMEWORK_PACKAGES = new Set(["torch", "torchaudio", "torchvision", "triton"]);
const REQUIREMENT_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)==/gm;
const PREBUNDLE_LOCK = "vendor/comfyui-worker-prebundle-lock.txt";

function normalizePackageName(name) {
	return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function layerForPackage(name) {
	if (/^nvidia-(?:cublas|cudnn)(?:-|$)/.test(name)) return "cuda-core";
	if (name.startsWith("nvidia-")) return "cuda-auxiliary";
	if (FRAMEWORK_PACKAGES.has(name)) return "framework";
	return "application";
}

export function parseCompiledRequirements(content, path = "requirements.txt") {
	const normalizedContent = content.replace(/\r\n/g, "\n");
	const matches = [...normalizedContent.matchAll(REQUIREMENT_PATTERN)];
	if (matches.length === 0) throw new Error(`${path} contains no pinned requirements.`);

	const prefix = normalizedContent.slice(0, matches[0].index);
	for (const line of prefix.split("\n")) {
		if (line !== "" && !line.startsWith("#")) {
			throw new Error(`${path} contains unsupported content before its requirements.`);
		}
	}

	const seen = new Set();
	return matches.map((match, index) => {
		const name = normalizePackageName(match[1]);
		if (seen.has(name))
			throw new Error(`${path} contains duplicate requirement ${name}.`);
		seen.add(name);
		const end = matches[index + 1]?.index ?? normalizedContent.length;
		return {
			block: `${normalizedContent
				.slice(match.index, end)
				.split("\n")
				.filter((line) => !line.trimStart().startsWith("#"))
				.join("\n")
				.trimEnd()}\n`,
			name,
		};
	});
}

export function renderRuntimeLayers(content, profile, path = "requirements.txt") {
	if (!PROFILES.includes(profile))
		throw new Error(`Unsupported Worker runtime profile: ${profile}.`);
	const grouped = Object.fromEntries(LAYERS.map((layer) => [layer, []]));
	for (const requirement of parseCompiledRequirements(content, path)) {
		grouped[layerForPackage(requirement.name)].push(requirement.block);
	}

	return Object.fromEntries(
		LAYERS.map((layer) => {
			if (grouped[layer].length === 0) {
				throw new Error(`${path} does not contain any ${layer} requirements.`);
			}
			const source = `vendor/comfyui-worker-${profile}-lock.txt`;
			return [
				layer,
				`# Generated from ${source} by scripts/worker-runtime-layers.mjs.\n# Do not edit directly.\n${grouped[layer].join("")}`,
			];
		}),
	);
}

function outputPath(root, profile, layer) {
	return join(root, "vendor", `comfyui-worker-${profile}-layer-${layer}.txt`);
}

export function runtimeImageFingerprint(root, profile) {
	if (!PROFILES.includes(profile))
		throw new Error(`Unsupported Worker runtime profile: ${profile}.`);
	const paths = [
		"apps/worker/Dockerfile.runtime",
		"scripts/verify-worker-runtime.py",
		PREBUNDLE_LOCK,
		`vendor/comfyui-worker-runtime-${profile}.json`,
		`vendor/comfyui-worker-${profile}-lock.txt`,
		`vendor/comfyui-worker-constraints-${profile}.txt`,
		...LAYERS.map((layer) => `vendor/comfyui-worker-${profile}-layer-${layer}.txt`),
	];
	const hash = createHash("sha256");
	for (const path of paths) {
		hash.update(path);
		hash.update("\0");
		hash.update(readFileSync(join(root, path)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function expectedOutputs(root) {
	const outputs = new Map();
	for (const profile of PROFILES) {
		const sourcePath = join(root, "vendor", `comfyui-worker-${profile}-lock.txt`);
		const layers = renderRuntimeLayers(
			readFileSync(sourcePath, "utf8"),
			profile,
			sourcePath,
		);
		for (const layer of LAYERS)
			outputs.set(outputPath(root, profile, layer), layers[layer]);
	}
	return outputs;
}

function unexpectedOutputs(root, expected) {
	const vendor = join(root, "vendor");
	const pattern = /^comfyui-worker-(?:cu128|cu130)-layer-[a-z-]+\.txt$/;
	return readdirSync(vendor)
		.filter((name) => pattern.test(name))
		.map((name) => join(vendor, name))
		.filter((path) => !expected.has(path));
}

export function writeRuntimeLayers(root) {
	const outputs = expectedOutputs(root);
	for (const path of unexpectedOutputs(root, outputs)) unlinkSync(path);
	for (const [path, content] of outputs) writeFileSync(path, content);
	return [...outputs.keys()];
}

export function checkRuntimeLayers(root) {
	const outputs = expectedOutputs(root);
	const stale = [];
	for (const [path, expected] of outputs) {
		let actual;
		try {
			actual = readFileSync(path, "utf8");
		} catch {
			stale.push(path);
			continue;
		}
		if (actual !== expected) stale.push(path);
	}
	stale.push(...unexpectedOutputs(root, outputs));
	if (stale.length > 0) {
		throw new Error(
			`Worker runtime layer files are stale: ${stale
				.map((path) => relative(root, path))
				.join(", ")}. Run bun scripts/worker-runtime-layers.mjs --write.`,
		);
	}
	return [...outputs.keys()];
}

function printHelp() {
	console.log(`Usage: bun scripts/worker-runtime-layers.mjs <--write | --check | --fingerprint <cu128|cu130>>

Generate or validate the hashed requirement files used for Worker runtime layers.`);
}

function main() {
	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const root = resolve(scriptDirectory, "..");
	const [command, ...extraArguments] = process.argv.slice(2);
	if (command === "--help" || command === "-h") {
		if (extraArguments.length > 0) throw new Error("Too many arguments.");
		printHelp();
		return;
	}
	if (command === "--write") {
		if (extraArguments.length > 0) throw new Error("Too many arguments.");
		const paths = writeRuntimeLayers(root);
		console.log(`Generated ${paths.length} Worker runtime layer files.`);
		return;
	}
	if (command === "--check") {
		if (extraArguments.length > 0) throw new Error("Too many arguments.");
		const paths = checkRuntimeLayers(root);
		console.log(`Validated ${paths.length} Worker runtime layer files.`);
		return;
	}
	if (command === "--fingerprint") {
		if (extraArguments.length !== 1)
			throw new Error("Pass one Worker runtime profile to --fingerprint.");
		console.log(runtimeImageFingerprint(root, extraArguments[0]));
		return;
	}
	throw new Error("Pass --write, --check, or --fingerprint.");
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
