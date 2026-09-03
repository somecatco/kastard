import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const composeFile = join(repositoryRoot, "compose.local-worker.yaml");

switch (process.argv[2]) {
	case "up":
		await compose("up", "--detach", "--build", "--wait", "worker");
		await verifyWorker();
		break;
	case "down":
		await compose("down", "--remove-orphans");
		break;
	default:
		console.error("Usage: bun scripts/local-worker.ts <up|down>");
		process.exit(1);
}

async function verifyWorker(): Promise<void> {
	await compose(
		"exec",
		"-T",
		"worker",
		"bun",
		"-e",
		[
			'const base = "http://127.0.0.1:5278";',
			'const health = await fetch(base + "/health");',
			'if (!health.ok) throw new Error("health returned HTTP " + health.status);',
			'const backend = await fetch(base + "/comfyui");',
			'if (backend.status !== 401) throw new Error("unauthenticated backend returned HTTP " + backend.status);',
		].join(" "),
	);
	const logs = await composeOutput("logs", "--no-color", "worker");
	const address = [...logs.matchAll(/Worker address: (\S+)/g)].at(-1)?.[1];
	const code = [...logs.matchAll(/Authentication code: (\S+)/g)].at(-1)?.[1];
	if (address === undefined || code === undefined) {
		throw new Error("Local Worker session details were not found in the Worker log.");
	}
	console.info(`Local CPU Worker is ready. Worker address: ${address}`);
	console.info(`Authentication code: ${code}`);
}

async function compose(...arguments_: string[]): Promise<void> {
	const subprocess = Bun.spawn(
		["docker", "compose", "--file", composeFile, ...arguments_],
		{
			cwd: repositoryRoot,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const exitCode = await subprocess.exited;
	if (exitCode !== 0) throw composeError(arguments_, exitCode);
}

async function composeOutput(...arguments_: string[]): Promise<string> {
	const subprocess = Bun.spawn(
		["docker", "compose", "--file", composeFile, ...arguments_],
		{
			cwd: repositoryRoot,
			stdout: "pipe",
			stderr: "inherit",
		},
	);
	const output = await new Response(subprocess.stdout).text();
	const exitCode = await subprocess.exited;
	if (exitCode !== 0) throw composeError(arguments_, exitCode);
	return output;
}

function composeError(arguments_: string[], exitCode: number): Error {
	return new Error(
		`docker compose ${arguments_.join(" ")} exited with code ${exitCode}.`,
	);
}
