import { type ChildProcess, spawn } from "node:child_process";
import { basename, join } from "node:path";

const LOG_TAIL_LENGTH = 12_000;
export type CommandOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	onOutput: (text: string) => void;
	signal?: AbortSignal;
	terminationTimeoutMs?: number;
};

export type RunCommand = (
	command: string,
	args: string[],
	options: CommandOptions,
) => Promise<void>;

export type StartProcess = (
	command: string,
	args: string[],
	options: Omit<CommandOptions, "onOutput">,
) => ChildProcess;

export function runCommand(
	command: string,
	args: string[],
	options: CommandOptions,
): Promise<void> {
	options.signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			// A separate process group lets cancellation include Git and package installer descendants.
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let processError: Error | null = null;
		let forceTimer: NodeJS.Timeout | undefined;
		let closeResult: { code: number | null; signal: NodeJS.Signals | null } | null =
			null;
		let aborted = false;
		let forceComplete = false;
		let settled = false;
		const finish = (): void => {
			if (closeResult === null || settled) return;
			if (aborted && !forceComplete && commandTreeRunning(child)) return;
			settled = true;
			if (forceTimer !== undefined) clearTimeout(forceTimer);
			options.signal?.removeEventListener("abort", abort);
			if (processError !== null) reject(processError);
			else if (closeResult.code === 0) resolve();
			else {
				reject(
					new Error(
						exitMessage(
							basename(command),
							closeResult.code,
							closeResult.signal,
							output,
						),
					),
				);
			}
		};
		const abort = (): void => {
			aborted = true;
			const reason = options.signal?.reason;
			processError ??=
				reason instanceof Error ? reason : new Error("Command was aborted.");
			const gracefulTermination = terminateCommandTree(child, "SIGTERM");
			if (process.platform === "win32") {
				void gracefulTermination.then(() => {
					forceComplete = true;
					finish();
				});
			}
			forceTimer = setTimeout(() => {
				forceTimer = undefined;
				void terminateCommandTree(child, "SIGKILL").then(() => {
					forceComplete = true;
					finish();
				});
			}, options.terminationTimeoutMs ?? 10_000);
			forceTimer.unref();
		};
		const record = (text: string): void => {
			output = `${output}${text}`.slice(-LOG_TAIL_LENGTH);
			options.onOutput(text);
		};
		child.stdout?.on("data", (chunk: Buffer | string) => {
			record(chunk.toString());
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			record(chunk.toString());
		});
		child.once("error", (error) => {
			processError ??= error;
		});
		child.once("close", (code, signal) => {
			closeResult = { code, signal };
			finish();
		});
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
	});
}

async function terminateCommandTree(
	child: ChildProcess,
	signal: NodeJS.Signals,
): Promise<void> {
	const pid = child.pid;
	if (pid === undefined) return;
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {}
		}
		if (signal === "SIGKILL") {
			const deadline = Date.now() + 2_000;
			while (commandTreeRunning(child) && Date.now() < deadline) await delay(10);
		}
		return;
	}
	const args = ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
	await new Promise<void>((resolve) => {
		const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
		const fallback = (): void => {
			try {
				child.kill(signal);
			} catch {}
			resolve();
		};
		killer.once("error", fallback);
		killer.once("close", (code) => {
			if (code !== 0) fallback();
			else resolve();
		});
		killer.unref();
	});
}

function commandTreeRunning(child: ChildProcess): boolean {
	const pid = child.pid;
	if (pid === undefined) return false;
	if (process.platform === "win32") return true;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function exitMessage(
	name: string,
	code: number | null,
	signal: NodeJS.Signals | null,
	output: string,
): string {
	const reason = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
	const details = output.trim();
	return details
		? `${name} exited with ${reason}. ${details}`
		: `${name} exited with ${reason}.`;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function environmentPython(
	environmentDirectory: string,
	platform: NodeJS.Platform,
): string {
	return platform === "win32"
		? join(environmentDirectory, "Scripts", "python.exe")
		: join(environmentDirectory, "bin", "python");
}
