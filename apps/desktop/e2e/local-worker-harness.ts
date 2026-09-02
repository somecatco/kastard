import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import type { ModelLibraryInput } from "../src/shared/api";

const repositoryRoot = resolve(process.cwd(), "../..");
const composeFile = join(repositoryRoot, "compose.local-worker.yaml");
const localWorkerScript = join(repositoryRoot, "scripts/local-worker.ts");

export const LOCAL_WORKER_E2E_MODEL = {
	name: "Kastard local Worker E2E model",
	sourceUrl:
		"https://huggingface.co/kastard/e2e/blob/0000000000000000000000000000000000000000/kastard-e2e.safetensors",
	path: "checkpoints/kastard-e2e.safetensors",
	sync: true,
	artifact: {
		provider: "huggingface",
		modelId: "kastard/e2e",
		versionId: "0000000000000000000000000000000000000000",
		versionLabel: "local-e2e",
		fileId: "kastard-e2e.safetensors",
		fileName: "kastard-e2e.safetensors",
		sizeBytes: 1,
	},
} satisfies ModelLibraryInput;

export type LocalWorker = {
	seedModel: () => Promise<void>;
	start: () => Promise<{ address: string; authenticationCode: string }>;
	stop: () => Promise<void>;
	logs: () => Promise<string>;
	cleanup: () => Promise<void>;
};

export async function createLocalWorker(): Promise<LocalWorker> {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		throw new Error("Local Worker E2E requires macOS on Apple Silicon.");
	}
	await run("docker", ["info", "--format", "{{.ServerVersion}}"], process.env);

	const id = randomUUID().replaceAll("-", "").slice(0, 12);
	const port = await availablePort();
	const environment = {
		...process.env,
		KASTARD_LOCAL_WORKER_DATA_VOLUME: `kastard-local-worker-e2e-data-${id}`,
		KASTARD_LOCAL_WORKER_IMAGE: `kastard-worker-e2e:${id}`,
		KASTARD_LOCAL_WORKER_PORT: String(port),
		KASTARD_LOCAL_WORKER_PROJECT_NAME: `kastard-local-worker-e2e-${id}`,
		KASTARD_LOCAL_WORKER_UV_CACHE_VOLUME: `kastard-local-worker-e2e-uv-${id}`,
	};
	const composeExec = (...arguments_: string[]) =>
		run(
			"docker",
			["compose", "--file", composeFile, "exec", "-T", "worker", ...arguments_],
			environment,
		);

	return {
		seedModel: async () => {
			await composeExec("mkdir", "-p", "/workspace/kastard/models/checkpoints");
			await composeExec(
				"truncate",
				"-s",
				String(LOCAL_WORKER_E2E_MODEL.artifact.sizeBytes),
				`/workspace/kastard/models/${LOCAL_WORKER_E2E_MODEL.path}`,
			);
		},
		start: async () => {
			const output = await run("bun", [localWorkerScript, "up"], environment);
			const address = [...output.matchAll(/Worker address: (\S+)/g)].at(-1)?.[1];
			const authenticationCode = [...output.matchAll(/Authentication code: (\S+)/g)].at(
				-1,
			)?.[1];
			if (address === undefined || authenticationCode === undefined) {
				throw new Error(`Local Worker session details were not found.\n${output}`);
			}
			return { address, authenticationCode };
		},
		stop: () => run("bun", [localWorkerScript, "down"], environment).then(() => {}),
		logs: () =>
			run(
				"docker",
				["compose", "--file", composeFile, "logs", "--no-color", "worker"],
				environment,
			),
		cleanup: async () => {
			await run(
				"docker",
				[
					"compose",
					"--file",
					composeFile,
					"down",
					"--volumes",
					"--remove-orphans",
					"--rmi",
					"all",
				],
				environment,
			);
		},
	};
}

async function availablePort(): Promise<number> {
	const server = createNetServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("Could not allocate a local Worker port.");
	}
	const port = address.port;
	server.close();
	await once(server, "close");
	return port;
}
async function run(
	command: string,
	arguments_: string[],
	environment: NodeJS.ProcessEnv,
): Promise<string> {
	const subprocess = spawn(command, arguments_, {
		cwd: repositoryRoot,
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const append = (chunk: Buffer): void => {
		output += chunk.toString();
	};
	subprocess.stdout.on("data", append);
	subprocess.stderr.on("data", append);
	const [code, signal] = (await once(subprocess, "close")) as [
		number | null,
		NodeJS.Signals | null,
	];
	if (code !== 0) {
		throw new Error(
			`${[command, ...arguments_].join(" ")} failed (${signal ?? code}).\n${output}`,
		);
	}
	return output;
}
