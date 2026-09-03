import { expect, test } from "bun:test";
import { shutdownWorker } from "./worker-shutdown";

test("cancels worker activity and exits even when cleanup fails", async () => {
	const actions: string[] = [];

	await shutdownWorker({
		runtime: {
			stop: () => {
				actions.push("runtime");
			},
		},
		customNodes: {
			getState: () => ({ status: "unavailable" }),
			cancel: () => {
				actions.push("custom-nodes");
				throw new Error("Custom nodes are not initialized.");
			},
		},
		models: {
			getState: () => ({ status: "idle" }),
			cancel: () => {
				actions.push("models");
			},
		},
		stopServer: () => {
			actions.push("server");
		},
		exit: () => {
			actions.push("exit");
		},
	});

	expect(actions).toEqual(["runtime", "custom-nodes", "models", "server", "exit"]);
});

test("waits for asynchronous cancellation before exiting", async () => {
	let modelStatus = "syncing";
	let exited = false;

	await shutdownWorker({
		runtime: null,
		customNodes: {
			getState: () => ({ status: "ready" }),
			cancel: () => {},
		},
		models: {
			getState: () => ({ status: modelStatus }),
			cancel: () => {
				setTimeout(() => {
					modelStatus = "canceled";
				}, 2);
			},
		},
		stopServer: () => {},
		exit: () => {
			exited = true;
		},
		timeoutMs: 100,
		pollMs: 1,
	});

	expect(modelStatus).toBe("canceled");
	expect(exited).toBe(true);
});

test("exits after the cleanup timeout", async () => {
	let exited = false;

	await shutdownWorker({
		runtime: null,
		customNodes: {
			getState: () => ({ status: "syncing" }),
			cancel: () => {},
		},
		models: {
			getState: () => ({ status: "idle" }),
			cancel: () => {},
		},
		stopServer: () => {},
		exit: () => {
			exited = true;
		},
		timeoutMs: 2,
		pollMs: 1,
	});

	expect(exited).toBe(true);
});
