// @vitest-environment node

import type { ChildProcess } from "node:child_process";
import { expect, test, vi } from "vitest";
import type { ComfyStartupFailure } from "../../shared/api";
import { CommandExitError } from "./process";
import { ComfyRuntime } from "./runtime";
import { ComfyStartupError } from "./startup-log";
import { createManagedPython, FakeProcess, fixture } from "./test-fixture";

async function runtimeHarness() {
	const paths = await fixture();
	const children: FakeProcess[] = [];
	const startProcess = vi.fn(() => {
		const child = new FakeProcess();
		children.push(child);
		return child as unknown as ChildProcess;
	});
	const runCommand = vi.fn(
		async (
			_command: string,
			args: string[],
			options: { onOutput: (text: string) => void },
		) => {
			options.onOutput(`Preparing ${args[0]}.\n`);
			await createManagedPython(args);
		},
	);
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn().mockRejectedValue(new Error("Not ready.")),
		runCommand,
		startProcess,
		retryMs: 1,
		startupTimeoutMs: 5_000,
	});
	return { runtime, children, startProcess, runCommand, paths };
}

async function failedStart(start: Promise<string>): Promise<ComfyStartupFailure> {
	try {
		await start;
		throw new Error("Expected startup to fail.");
	} catch (error) {
		if (!(error instanceof ComfyStartupError)) throw error;
		return error.failure;
	}
}

test("retains preparation and both output streams, including output drained after exit", async () => {
	const { runtime, children } = await runtimeHarness();
	const failure = failedStart(runtime.start());
	await vi.waitFor(() => expect(children).toHaveLength(1));
	const child = children[0];
	if (!child) throw new Error("Missing backend process.");
	const text = Buffer.from("Extension café\n");
	child.stdout.write(text.subarray(0, 14));
	child.stdout.write(text.subarray(14));
	child.stderr.write("\u001b[31mInitialization failed.\u001b[0m\n");
	child.exitCode = 1;
	child.emit("exit", 1, null);
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	child.stderr.write("Final error details.\n");
	child.stdout.end();
	child.stderr.end();
	child.emit("close", 1, null);
	const result = await failure;
	expect(result).toEqual({
		message: "ComfyUI exited with code 1.",
		logs: "Preparing venv.\nPreparing pip.\nExtension café\nInitialization failed.\nFinal error details.\n",
		truncated: false,
	});
	expect(runtime.getState()).toMatchObject({ status: "error", startupFailure: result });
});

test("returns preparation failures with separate command output", async () => {
	const { runtime, runCommand, startProcess } = await runtimeHarness();
	runCommand.mockImplementationOnce(async (_command, _args, options) => {
		options.onOutput("Package download failed.\n");
		throw new CommandExitError("uv", 2, null, "Package download failed.");
	});
	expect(await failedStart(runtime.start())).toEqual({
		message: "uv exited with code 2.",
		logs: "Package download failed.\n",
		truncated: false,
	});
	expect(startProcess).not.toHaveBeenCalled();
});

test("shares a startup attempt and keeps retries separate from earlier output", async () => {
	const { runtime, children, runCommand, startProcess } = await runtimeHarness();
	const first = failedStart(runtime.start());
	const concurrent = failedStart(runtime.start());
	await vi.waitFor(() => expect(children).toHaveLength(1));
	const firstChild = children[0];
	if (!firstChild) throw new Error("Missing first process.");
	firstChild.stderr.write("First attempt failed.\n");
	firstChild.exit(1);
	const firstFailure = await first;
	expect(await concurrent).toEqual(firstFailure);
	expect(startProcess).toHaveBeenCalledOnce();

	const second = failedStart(runtime.start());
	await vi.waitFor(() => expect(children).toHaveLength(2));
	runCommand.mock.calls[0]?.[2].onOutput("Late preparation output.\n");
	firstChild.stderr.emit("data", Buffer.from("Late backend output.\n"));
	children[1]?.stderr.write("Second attempt failed.\n");
	children[1]?.exit(2);
	expect(await second).toEqual({
		message: "ComfyUI exited with code 2.",
		logs: "Second attempt failed.\n",
		truncated: false,
	});
	expect(firstFailure.logs).toContain("First attempt failed.");
});

test("bounds startup output by bytes and preserves custom-node recovery after truncation", async () => {
	const { runtime, children } = await runtimeHarness();
	const failure = failedStart(runtime.start());
	await vi.waitFor(() => expect(children).toHaveLength(1));
	const child = children[0];
	if (!child) throw new Error("Missing backend process.");
	child.stderr.write("(IMPORT FAILED): example-node\n");
	child.stdout.write("é".repeat(600_000));
	child.stderr.write("\nFinal error.\n");
	child.exit(1);
	const result = await failure;
	expect(result.truncated).toBe(true);
	expect(Buffer.byteLength(result.logs)).toBeLessThanOrEqual(1024 * 1024);
	expect(result.logs.startsWith("é")).toBe(true);
	expect(result.logs.endsWith("\nFinal error.\n")).toBe(true);
	expect(runtime.getState()).toMatchObject({ status: "error", reason: "custom-node" });
});

test("reports an error even when startup produces no output", async () => {
	const { runtime, runCommand } = await runtimeHarness();
	runCommand.mockRejectedValueOnce(new Error("Python could not be launched."));
	expect(await failedStart(runtime.start())).toEqual({
		message: "Python could not be launched.",
		logs: "",
		truncated: false,
	});
});

test("retains startup output when readiness times out", async () => {
	const paths = await fixture();
	const child = new FakeProcess();
	const runtime = new ComfyRuntime({
		...paths,
		platform: "darwin",
		arch: "arm64",
		allocatePort: async () => 18_188,
		fetch: vi.fn().mockRejectedValue(new Error("Not ready.")),
		runCommand: async (_command, args) => createManagedPython(args),
		startProcess: () => {
			queueMicrotask(() => child.stdout.write("Waiting for initialization.\n"));
			return child as unknown as ChildProcess;
		},
		retryMs: 1,
		startupTimeoutMs: 10,
	});
	expect(await failedStart(runtime.start())).toEqual({
		message: "ComfyUI did not start within 10ms.",
		logs: "Waiting for initialization.\n",
		truncated: false,
	});
	expect(child.signalCode).toBe("SIGTERM");
});

test("reports partial output when an exited process keeps its output streams open", async () => {
	const { runtime, children } = await runtimeHarness();
	const failure = failedStart(runtime.start());
	await vi.waitFor(() => expect(children).toHaveLength(1));
	const child = children[0];
	if (!child) throw new Error("Missing backend process.");
	child.stderr.write("Available failure details.\n");
	child.exitCode = 1;
	child.emit("exit", 1, null);
	expect(await failure).toEqual({
		message: "ComfyUI exited with code 1.",
		logs: "Preparing venv.\nPreparing pip.\nAvailable failure details.\n",
		truncated: true,
	});
	child.stdout.end();
	child.stderr.end();
	child.emit("close", 1, null);
});
