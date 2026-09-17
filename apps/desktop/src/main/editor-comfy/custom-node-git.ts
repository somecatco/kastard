import { type ExecFileException, execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import {
	isGitCommit,
	normalizeGitHubRepository,
	ROOT_GIT_STATUS_ARGS,
} from "@kastard/common";
import type { CustomNodeEntry, CustomNodeErrorLog } from "../../shared/api";

const LOG_TAIL_LENGTH = 12_000;
export const NO_SUPPORTED_CUSTOM_NODE_SOURCE =
	"No Registry package or supported GitHub repository was found.";
const SYMLINK_CUSTOM_NODE_ISSUE =
	"Symbolic-link custom node directories cannot be reproduced on the Worker.";
const REPOSITORY_ROOT_ISSUE =
	"The custom node directory is not the root of its Git repository.";
const GITHUB_ORIGIN_ISSUE =
	"The Git repository does not have a supported GitHub origin.";
const HEAD_COMMIT_ISSUE = "The Git repository does not have a valid HEAD commit.";
const LOCAL_CHANGES_ISSUE =
	"Tracked or untracked local changes are not included in the Git commit.";
const GIT_METADATA_ISSUE = "The Git repository metadata could not be read.";

type GitCustomNodeInspection = Pick<
	CustomNodeEntry,
	"version" | "repository" | "workerSyncIssue" | "workerSyncErrorLog"
>;

export async function inspectGitHubRepository(
	directory: string,
	python: string,
	signal?: AbortSignal,
): Promise<GitCustomNodeInspection | null> {
	signal?.throwIfAborted();
	let entry: Stats;
	try {
		entry = await lstat(directory);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? null
			: { version: "unknown", ...metadataFailure([error]) };
	}
	if (entry.isSymbolicLink()) {
		return { version: "unknown", workerSyncIssue: SYMLINK_CUSTOM_NODE_ISSUE };
	}
	if (!entry.isDirectory()) {
		return { version: "unknown", workerSyncIssue: NO_SUPPORTED_CUSTOM_NODE_SOURCE };
	}
	const primary = await inspectWithGit(directory, signal);
	signal?.throwIfAborted();
	if (primary.workerSyncErrorLog === undefined) return primary;
	let partial = primary;
	try {
		const output = await commandOutput(
			python,
			["-I", "-B", "-c", PYGIT2_INSPECTION, directory],
			"Python (pygit2 repository inspection)",
			signal,
		);
		const metadata: unknown = JSON.parse(output);
		if (!isPythonMetadata(metadata)) {
			throw new Error("pygit2 returned invalid repository metadata.");
		}
		const repository = normalizeGitHubRepository(metadata.origin);
		partial = {
			...primary,
			...(repository === null ? {} : { repository: repository.url }),
			...(isGitCommit(metadata.commit) ? { version: metadata.commit } : {}),
		};
		if (metadata.errors.length > 0) {
			throw new Error(metadata.errors.map((error) => `pygit2 ${error}`).join("\n\n"));
		}
		if ((await realpath(directory)) !== (await realpath(metadata.root))) {
			return { version: "unknown", workerSyncIssue: REPOSITORY_ROOT_ISSUE };
		}
		return repositoryInspection(
			metadata.origin,
			metadata.commit,
			metadata.hasRootChanges,
		);
	} catch (error) {
		signal?.throwIfAborted();
		return { ...partial, ...metadataFailure([error], primary.workerSyncErrorLog) };
	}
}

async function inspectWithGit(
	directory: string,
	signal?: AbortSignal,
): Promise<GitCustomNodeInspection> {
	let topLevel: string;
	try {
		topLevel = await gitOutput(directory, ["rev-parse", "--show-toplevel"], signal);
	} catch (error) {
		return { version: "unknown", ...metadataFailure([error]) };
	}
	let actualDirectory: string;
	let repositoryRoot: string;
	try {
		[actualDirectory, repositoryRoot] = await Promise.all([
			realpath(directory),
			realpath(topLevel.trim()),
		]);
	} catch (error) {
		return { version: "unknown", ...metadataFailure([error]) };
	}
	if (actualDirectory !== repositoryRoot) {
		return { version: "unknown", workerSyncIssue: REPOSITORY_ROOT_ISSUE };
	}
	const [originResult, commitResult, statusResult] = await Promise.allSettled([
		gitOutput(
			directory,
			["config", "--get", "--default=", "remote.origin.url"],
			signal,
		),
		gitOutput(directory, ["rev-parse", "--revs-only", "HEAD"], signal),
		gitOutput(directory, [...ROOT_GIT_STATUS_ARGS], signal),
	]);
	if (
		originResult.status === "rejected" ||
		commitResult.status === "rejected" ||
		statusResult.status === "rejected"
	) {
		const failures = [originResult, commitResult, statusResult].filter(
			(result) => result.status === "rejected",
		);
		const repository =
			originResult.status === "fulfilled"
				? normalizeGitHubRepository(originResult.value.trim())
				: null;
		return {
			version:
				commitResult.status === "fulfilled" && isGitCommit(commitResult.value.trim())
					? commitResult.value.trim().toLowerCase()
					: "unknown",
			...(repository === null ? {} : { repository: repository.url }),
			...metadataFailure(failures.map((result) => result.reason)),
		};
	}
	return repositoryInspection(
		originResult.value,
		commitResult.value,
		statusResult.value.trim() !== "",
	);
}

function repositoryInspection(
	origin: string,
	commit: string,
	hasRootChanges: boolean,
): GitCustomNodeInspection {
	const repository = normalizeGitHubRepository(origin.trim());
	if (repository === null) {
		return { version: "unknown", workerSyncIssue: GITHUB_ORIGIN_ISSUE };
	}
	if (!isGitCommit(commit.trim())) {
		return {
			version: "unknown",
			repository: repository.url,
			workerSyncIssue: HEAD_COMMIT_ISSUE,
		};
	}
	return {
		version: commit.trim().toLowerCase(),
		repository: repository.url,
		...(hasRootChanges ? { workerSyncIssue: LOCAL_CHANGES_ISSUE } : {}),
	};
}

function gitOutput(
	directory: string,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	return commandOutput(
		"git",
		["--no-optional-locks", "-C", directory, ...args],
		`git ${args.join(" ")}`,
		signal,
	);
}

function commandOutput(
	command: string,
	args: string[],
	label: string,
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{
				env: gitEnvironment(process.env),
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
				timeout: 5_000,
				signal,
			},
			(error, stdout, stderr) => {
				if (error === null) resolve(stdout);
				else reject(new InspectionCommandError(label, error, stdout, stderr));
			},
		);
	});
}

class InspectionCommandError extends Error {
	readonly log: CustomNodeErrorLog;
	constructor(
		command: string,
		error: ExecFileException,
		stdout: string,
		stderr: string,
	) {
		super(GIT_METADATA_ISSUE, { cause: error });
		const output = boundedErrorLog(
			[stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""]
				.filter(Boolean)
				.join("\n\n"),
		);
		this.log = {
			text: [
				`Command: ${command}`,
				typeof error.code === "number"
					? `Exit code: ${error.code}`
					: error.code
						? `Error code: ${error.code}`
						: "",
				error.signal ? `Signal: ${error.signal}` : "",
				error.killed ? "The process was terminated before completion." : "",
				output.text || stripVTControlCharacters(error.message),
			]
				.filter(Boolean)
				.join("\n\n"),
			truncated: output.truncated,
		};
	}
}

function boundedErrorLog(text: string): CustomNodeErrorLog {
	const clean = stripVTControlCharacters(text);
	let start = Math.max(0, clean.length - LOG_TAIL_LENGTH);
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(clean[start] ?? "")) start += 1;
	return { text: clean.slice(start), truncated: start > 0 };
}

function metadataFailure(
	errors: unknown[],
	previous?: CustomNodeErrorLog,
): Pick<CustomNodeEntry, "workerSyncIssue" | "workerSyncErrorLog"> {
	const logs = errors.map((error) =>
		error instanceof InspectionCommandError
			? error.log
			: boundedErrorLog(error instanceof Error ? error.message : String(error)),
	);
	if (previous !== undefined) logs.unshift(previous);
	return {
		workerSyncIssue: GIT_METADATA_ISSUE,
		workerSyncErrorLog: {
			text: logs.map((log) => log.text).join("\n\n"),
			truncated: logs.some((log) => log.truncated),
		},
	};
}

function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
	};
	for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP"]) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

type PythonMetadata = {
	root: string;
	origin: string;
	commit: string;
	hasRootChanges: boolean;
	errors: string[];
};

function isPythonMetadata(value: unknown): value is PythonMetadata {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return (
		["root", "origin", "commit"].every((key) => typeof data[key] === "string") &&
		typeof data.hasRootChanges === "boolean" &&
		Array.isArray(data.errors) &&
		data.errors.every((error) => typeof error === "string")
	);
}

const PYGIT2_INSPECTION = `
import json
import os
import sys
import pygit2

result = {"root": "", "origin": "", "commit": "", "hasRootChanges": False, "errors": []}

def read(name, operation):
    try:
        result[name] = operation()
    except Exception as error:
        result["errors"].append(f"{name}: {type(error).__name__}: {error}")

def origin():
    try:
        return repo.config["remote.origin.url"]
    except KeyError:
        return ""

def has_root_changes():
    index = repo.index
    tree = None if repo.head_is_unborn else repo.head.peel(pygit2.Commit).tree
    type_changes = pygit2.enums.FileStatus.INDEX_TYPECHANGE | pygit2.enums.FileStatus.WT_TYPECHANGE | pygit2.enums.FileStatus.CONFLICTED
    for path, status in repo.status(untracked_files="all", ignored=False).items():
        if status & type_changes:
            return True
        modes = []
        try:
            modes.append(index[path].mode)
        except KeyError:
            pass
        if tree is not None:
            try:
                modes.append(tree[path].filemode)
            except KeyError:
                pass
        # Match git status --ignore-submodules=all, including staged gitlinks.
        if pygit2.enums.FileMode.COMMIT not in modes:
            return True
    return False

try:
    for level in (pygit2.enums.ConfigLevel.SYSTEM, pygit2.enums.ConfigLevel.GLOBAL, pygit2.enums.ConfigLevel.XDG):
        pygit2.settings.search_path[level] = ""
    repo = pygit2.Repository(sys.argv[1])
    if repo.workdir is None:
        raise ValueError("The Git repository does not have a working directory.")
    result["root"] = repo.workdir
    if os.path.realpath(repo.workdir) == os.path.realpath(sys.argv[1]):
        read("origin", origin)
        read("commit", lambda: "" if repo.head_is_unborn else str(repo.head.target))
        read("hasRootChanges", has_root_changes)
except Exception as error:
    result["errors"].append(f"repository: {type(error).__name__}: {error}")

print(json.dumps(result))
`;
