import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	test as base,
	type ElectronApplication,
	_electron as electron,
	expect,
} from "@playwright/test";

export type TestWorker = {
	process: ChildProcessWithoutNullStreams;
	url: string;
	address: string;
	authenticationCode: string;
	backendRoot: string;
	waitForDisconnect: () => Promise<void>;
};

type WorkerFixtures = {
	comfyDataRoot: string;
};

type TestFixtures = {
	testRoot: string;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
	// biome-ignore lint/correctness/noEmptyPattern: The test fixture has no dependencies.
	testRoot: async ({}, use) => {
		const root = await mkdtemp(join(tmpdir(), "kastard-e2e-"));
		try {
			await use(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	comfyDataRoot: [
		// biome-ignore lint/correctness/noEmptyPattern: The worker fixture has no dependencies.
		async ({}, use) => {
			const root = await mkdtemp(join(tmpdir(), "kastard-comfy-e2e-"));
			try {
				await use(root);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		{ scope: "worker" },
	],
});

export { expect };

export async function launchDesktop(
	comfyDataRoot: string,
	userDataDirectory: string,
	env: NodeJS.ProcessEnv = {},
): Promise<ElectronApplication> {
	await mkdir(userDataDirectory, { recursive: true });
	return electron.launch({
		args: [process.cwd()],
		env: {
			...process.env,
			...env,
			KASTARD_E2E_COMFY_DATA_DIR: comfyDataRoot,
			KASTARD_E2E_HIDDEN_WINDOW: "1",
			KASTARD_E2E_USER_DATA_DIR: userDataDirectory,
		},
	});
}

export async function startWorker(): Promise<TestWorker> {
	const backendRoot = await mkdtemp(join(tmpdir(), "kastard-worker-backend-e2e-"));
	const sessionPort = await availablePort();
	const workerProcess = spawn(
		"bun",
		["run", resolve(process.cwd(), "../worker/src/index.ts")],
		{
			env: {
				...process.env,
				KASTARD_COMFYUI_ROOT: backendRoot,
				KASTARD_RUNTIME_PYTHON: "python3",
				KASTARD_SESSION_HOST: "127.0.0.1",
				KASTARD_SESSION_PORT: String(sessionPort),
				KASTARD_PUBLIC_ADDRESS: `127.0.0.1:${sessionPort}`,
				PORT: "0",
			},
			stdio: "pipe",
		},
	);
	let output = "";
	let latestAuthenticationCode = "";
	let observedDisconnects = 0;
	const disconnectWaiters = new Set<() => void>();
	return new Promise<TestWorker>((resolveWorker, rejectWorker) => {
		const timeout = setTimeout(() => {
			workerProcess.kill();
			rejectWorker(new Error(`Kastard Worker did not start.\n${output}`));
		}, 10_000);
		const inspect = (chunk: Buffer): void => {
			output += chunk.toString();
			const codes = [...output.matchAll(/Authentication code: (\S+)/g)];
			latestAuthenticationCode = codes.at(-1)?.[1] ?? latestAuthenticationCode;
			const disconnects = [...output.matchAll(/Editor disconnected\./g)].length;
			if (disconnects > observedDisconnects) {
				observedDisconnects = disconnects;
				for (const resolve of disconnectWaiters) resolve();
				disconnectWaiters.clear();
			}
			const port = output.match(
				/\[internal\] Worker API listening on http:\/\/127\.0\.0\.1:(\d+)/,
			)?.[1];
			const address = [...output.matchAll(/Worker address: (\S+)/g)].at(-1)?.[1];
			if (!port || address === undefined || latestAuthenticationCode === "") return;
			clearTimeout(timeout);
			resolveWorker({
				process: workerProcess,
				url: `http://127.0.0.1:${port}`,
				address,
				authenticationCode: latestAuthenticationCode,
				backendRoot,
				waitForDisconnect: () =>
					new Promise<void>((resolveDisconnect) => {
						disconnectWaiters.add(resolveDisconnect);
					}),
			});
		};
		workerProcess.stdout.on("data", inspect);
		workerProcess.stderr.on("data", inspect);
		workerProcess.once("exit", (code) => {
			clearTimeout(timeout);
			rejectWorker(new Error(`Kastard Worker exited with ${code}.\n${output}`));
		});
	});
}

async function availablePort(): Promise<number> {
	const server = createNetServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("Could not allocate a Worker session port.");
	}
	const port = address.port;
	server.close();
	await once(server, "close");
	return port;
}

export async function stopWorker(worker: TestWorker): Promise<void> {
	const workerProcess = worker.process;
	if (workerProcess.exitCode === null) {
		workerProcess.kill("SIGTERM");
		await new Promise<void>((resolveExit) => {
			const forceTimer = setTimeout(() => workerProcess.kill("SIGKILL"), 5_000);
			workerProcess.once("exit", () => {
				clearTimeout(forceTimer);
				resolveExit();
			});
		});
	}
	await rm(worker.backendRoot, { recursive: true, force: true });
}

export async function closeDesktop(desktop: ElectronApplication): Promise<void> {
	const appProcess = desktop.process();
	const exited =
		appProcess.exitCode === null ? once(appProcess, "exit") : Promise.resolve();
	await desktop.evaluate(async ({ app, dialog, session }) => {
		dialog.showMessageBoxSync = () => 1;
		await session.defaultSession.flushStorageData();
		app.quit();
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const didExit = await Promise.race([
		exited.then(() => true),
		new Promise<false>((resolveTimeout) => {
			timeout = setTimeout(() => resolveTimeout(false), 15_000);
		}),
	]);
	if (timeout !== undefined) clearTimeout(timeout);
	if (didExit) return;
	const windows = await desktop.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().map((window) => ({
			destroyed: window.isDestroyed(),
			visible: window.isVisible(),
		})),
	);
	throw new Error(`Desktop did not exit after app.quit(): ${JSON.stringify(windows)}`);
}
