#!/usr/bin/env node
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cancel, isCancel, select } from "@clack/prompts";

const BUILD_NUMBER_FIELDS = {
	editor: {
		path: "apps/desktop/package.json",
		property: "buildVersion",
		read: (value) => value?.build?.buildVersion,
	},
	worker: {
		path: "apps/worker/package.json",
		property: "buildNumber",
		read: (value) => value?.buildNumber,
	},
};

const TARGETS = Object.keys(BUILD_NUMBER_FIELDS);
const BUILD_NUMBER_PATTERN = /^[1-9]\d*$/;

function readJson(path) {
	let content;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error.message}`);
	}

	try {
		return { content, value: JSON.parse(content) };
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error.message}`);
	}
}

function parseBuildNumber(raw, path) {
	if (typeof raw !== "string" || !BUILD_NUMBER_PATTERN.test(raw)) {
		throw new Error(
			`${path} must contain a positive integer build number, received ${JSON.stringify(raw)}.`,
		);
	}
	const buildNumber = Number(raw);
	if (!Number.isSafeInteger(buildNumber)) {
		throw new Error(`${path} build number exceeds JavaScript's safe integer range.`);
	}
	return buildNumber;
}

function selectedFields(target) {
	if (target === "all") {
		return TARGETS.map((name) => [name, BUILD_NUMBER_FIELDS[name]]);
	}
	const field = BUILD_NUMBER_FIELDS[target];
	if (!field) {
		throw new Error(
			`Unknown target: ${target}. Expected ${[...TARGETS, "all"].join(", ")}.`,
		);
	}
	return [[target, field]];
}

function readState(root, target) {
	return selectedFields(target).map(([name, field]) => {
		const path = join(root, field.path);
		const json = readJson(path);
		const rawBuildNumber = field.read(json.value);
		const buildNumber = parseBuildNumber(rawBuildNumber, field.path);
		return { ...field, ...json, buildNumber, name, path, rawBuildNumber };
	});
}

function replaceBuildNumber(state, nextBuildNumber) {
	const pattern = new RegExp(
		`^(\\s*"${state.property}"\\s*:\\s*")([^"]*)("[^\\r\\n]*)$`,
		"gm",
	);
	const matches = [...state.content.matchAll(pattern)].filter(
		(match) => match[2] === state.rawBuildNumber,
	);
	if (matches.length !== 1) {
		throw new Error(
			`${state.path} must contain one editable ${state.property} property.`,
		);
	}

	const match = matches[0];
	const replacement = `${match[1]}${nextBuildNumber}${match[3]}`;
	return `${state.content.slice(0, match.index)}${replacement}${state.content.slice(match.index + match[0].length)}`;
}

function writePreparedUpdates(updates) {
	const prepared = updates.map((update, index) => ({
		...update,
		temporaryPath: `${update.path}.build-number-${process.pid}-${index}.tmp`,
	}));
	const replaced = [];

	try {
		for (const update of prepared) {
			writeFileSync(update.temporaryPath, update.content, {
				mode: statSync(update.path).mode,
			});
		}
		for (const update of prepared) {
			renameSync(update.temporaryPath, update.path);
			replaced.push(update);
		}
	} catch (error) {
		for (const update of replaced) writeFileSync(update.path, update.originalContent);
		throw error;
	} finally {
		for (const update of prepared) rmSync(update.temporaryPath, { force: true });
	}
}

export function checkBuildNumbers(root, target = "all") {
	return Object.fromEntries(
		readState(root, target).map(({ buildNumber, name }) => [name, buildNumber]),
	);
}

export function incrementBuildNumbers(root, target) {
	const state = readState(root, target);
	const updates = state.map((entry) => {
		const nextBuildNumber = entry.buildNumber + 1;
		if (!Number.isSafeInteger(nextBuildNumber)) {
			throw new Error(`${entry.path} build number cannot be incremented safely.`);
		}
		return {
			content: replaceBuildNumber(entry, nextBuildNumber),
			name: entry.name,
			nextBuildNumber,
			originalBuildNumber: entry.buildNumber,
			originalContent: entry.content,
			path: entry.path,
		};
	});

	writePreparedUpdates(updates);
	return updates.map(({ name, nextBuildNumber, originalBuildNumber }) => ({
		name,
		nextBuildNumber,
		originalBuildNumber,
	}));
}

function printHelp() {
	console.log(`Usage: bun increment-build-number
       node scripts/increment-build-number.mjs <editor | worker | all>
       node scripts/increment-build-number.mjs --check [editor | worker | all]

Increment one Kastard build number, or both atomically.

  --check  Verify the selected build number, or every build number by default`);
}

async function main() {
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const root = resolve(scriptDir, "..");
	let [command, target, ...extraArgs] = process.argv.slice(2);
	if (extraArgs.length > 0) throw new Error("Too many arguments.");

	if (command === "--help" || command === "-h") {
		if (target) throw new Error("Help does not accept a target.");
		printHelp();
		return;
	}
	if (command === "--check") {
		const buildNumbers = checkBuildNumbers(root, target ?? "all");
		console.log(
			`Build numbers are valid: ${Object.entries(buildNumbers)
				.map(([name, buildNumber]) => `${name}=${buildNumber}`)
				.join(", ")}`,
		);
		return;
	}
	if (!command) {
		command = await select({
			message: "Select a build number target",
			options: [
				{ label: "Editor", value: "editor" },
				{ label: "Worker", value: "worker" },
				{ label: "Editor and Worker", value: "all" },
			],
		});
		if (isCancel(command)) {
			cancel("Build number increment cancelled.");
			return;
		}
	}
	if (target) throw new Error("Only one increment target is supported.");

	for (const result of incrementBuildNumbers(root, command)) {
		console.log(
			`${result.name}: ${result.originalBuildNumber} -> ${result.nextBuildNumber}`,
		);
	}
}

const isDirectExecution =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
	main().catch((error) => {
		console.error(`error: ${error.message}`);
		process.exitCode = 1;
	});
}
