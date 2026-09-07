// @vitest-environment node

import { expect, test, vi } from "vitest";
import type { ComfyRuntimeState } from "../shared/api";
import { EditorComfy } from "./editor-comfy";
import type { InstalledCustomNode } from "./editor-custom-nodes";

const url = "http://127.0.0.1:18188/";
const node = {
	name: "example-node",
	managerId: null,
	version: "abc123",
	repository: "https://github.com/example/example-node.git",
} satisfies InstalledCustomNode;

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function harness() {
	let state: ComfyRuntimeState = { status: "ready", url };
	let workerStatus: string | undefined;
	const runtime = {
		start: vi.fn(async () => url),
		restart: vi.fn(async (_signal: AbortSignal) => url),
		stop: vi.fn(async () => {}),
		getState: () => state,
	};
	const nodes = {
		installCustomNode: vi.fn(async () => ({
			node,
			nodes: [node],
			restartRequired: true,
		})),
		removeCustomNode: vi.fn(async (_name: string, _signal?: AbortSignal) => ({
			restartRequired: true,
		})),
		listCustomNodes: vi.fn(async () => [node]),
		cancelInstallation: vi.fn(async () => {}),
	};
	const sync = {
		get: vi.fn(async () => true),
		update: vi.fn(async (_name: string, _value: boolean) => {}),
		remove: vi.fn(async (): Promise<boolean | undefined> => true),
	};
	const gateway = { start: vi.fn(async () => url) };
	const modelPaths = {
		syncModels: vi.fn(async () => {}),
		settled: vi.fn(async () => {}),
	};
	const refresh = vi.fn();
	const editor = new EditorComfy({
		runtime,
		nodes,
		gateway,
		modelPaths,
		versions: null,
		getSyncStore: () => sync,
		getWorkerCustomNodeStatus: () => workerStatus,
		refreshCustomNodeTarget: refresh,
	});
	return {
		editor,
		runtime,
		nodes,
		sync,
		gateway,
		modelPaths,
		refresh,
		setState: (next: ComfyRuntimeState) => {
			state = next;
		},
		setWorkerStatus: (next: string) => {
			workerStatus = next;
		},
	};
}

test("protects installation through synchronization selection reads", async () => {
	const { editor, nodes, sync, runtime, refresh } = harness();
	const reading = deferred<boolean>();
	sync.get.mockReturnValueOnce(reading.promise);
	const installing = editor.installCustomNode(node.repository);
	await vi.waitFor(() => expect(sync.get).toHaveBeenCalled());
	await expect(editor.installCustomNode(node.repository)).rejects.toThrow(
		"Another custom-node change",
	);
	await expect(editor.removeCustomNode(node.name)).rejects.toThrow(
		"Another custom-node change",
	);
	await expect(editor.start()).rejects.toThrow("custom-node change");
	await expect(editor.restart()).rejects.toThrow("custom-node change");
	await expect(
		editor.selectVersion({ component: "frontend", version: null }),
	).rejects.toThrow("custom-node change");
	await expect(editor.updateNodeSync(node.name, false)).rejects.toThrow(
		"installation or deletion",
	);
	await expect(editor.nodesForSync()).rejects.toThrow("local change");
	expect(nodes.installCustomNode).toHaveBeenCalledOnce();
	expect(runtime.restart).not.toHaveBeenCalled();
	reading.resolve(false);
	await expect(installing).resolves.toMatchObject({ node: { sync: false } });
	expect(refresh).toHaveBeenCalledOnce();
	await expect(editor.restart()).resolves.toBe(url);
});

test("keeps deletion protected until a failed removal's selection is restored", async () => {
	const { editor, nodes, sync } = harness();
	nodes.removeCustomNode.mockRejectedValueOnce(new Error("Removal failed."));
	const restoring = deferred();
	sync.update.mockReturnValueOnce(restoring.promise);
	const removal = editor.removeCustomNode(node.name);
	const rejected = expect(removal).rejects.toThrow("Removal failed.");
	await vi.waitFor(() => expect(sync.update).toHaveBeenCalledWith(node.name, true));
	await expect(editor.restart()).rejects.toThrow("custom-node change");
	restoring.resolve();
	await rejected;
	await expect(editor.removeCustomNode(node.name)).resolves.toEqual({
		restartRequired: true,
	});
});

test("reports both removal and selection recovery failures", async () => {
	const { editor, nodes, sync } = harness();
	nodes.removeCustomNode.mockRejectedValueOnce(new Error("Removal failed."));
	sync.update.mockRejectedValueOnce(new Error("Storage failed."));
	await expect(editor.removeCustomNode(node.name)).rejects.toThrow(
		"Removal: Removal failed. Restore: Storage failed.",
	);
	await expect(editor.start()).resolves.toBe(url);
});

test.each(["loading", "syncing", "canceling"])(
	"rejects local node changes while Worker synchronization is %s",
	async (status) => {
		const { editor, setWorkerStatus, nodes } = harness();
		setWorkerStatus(status);
		await expect(editor.installCustomNode(node.repository)).rejects.toThrow(
			"Worker synchronization",
		);
		await expect(editor.removeCustomNode(node.name)).rejects.toThrow(
			"Worker synchronization",
		);
		expect(nodes.installCustomNode).not.toHaveBeenCalled();
		expect(nodes.removeCustomNode).not.toHaveBeenCalled();
	},
);

test("allows recovery deletion only for a custom-node startup failure", async () => {
	const { editor, setState } = harness();
	setState({
		status: "error",
		message: "A node could not import.",
		reason: "custom-node",
	});
	await expect(editor.removeCustomNode(node.name)).resolves.toEqual({
		restartRequired: true,
	});
	await expect(editor.installCustomNode(node.repository)).rejects.toThrow(
		"while ComfyUI is ready",
	);
	setState({ status: "error", message: "Backend failed." });
	await expect(editor.removeCustomNode(node.name)).rejects.toThrow(
		"while ComfyUI is ready",
	);
});

test("shares a manual restart and admits another after failure", async () => {
	const { editor, runtime } = harness();
	const restarting = deferred<string>();
	runtime.restart.mockReturnValueOnce(restarting.promise);
	const first = editor.restart();
	const rejected = expect(first).rejects.toThrow("Startup failed.");
	expect(editor.restart()).toBe(first);
	await vi.waitFor(() => expect(runtime.restart).toHaveBeenCalledOnce());
	await expect(editor.installCustomNode(node.repository)).rejects.toThrow(
		"starting or restarting",
	);
	restarting.reject(new Error("Startup failed."));
	await rejected;
	await expect(editor.restart()).resolves.toBe(url);
	expect(runtime.restart).toHaveBeenCalledTimes(2);
});

test("rejects node changes while the gateway is preparing a start", async () => {
	const { editor, gateway } = harness();
	const starting = deferred<string>();
	gateway.start.mockReturnValueOnce(starting.promise);
	const start = editor.start();
	await expect(editor.removeCustomNode(node.name)).rejects.toThrow(
		"starting or restarting",
	);
	starting.resolve(url);
	await start;
	await expect(editor.removeCustomNode(node.name)).resolves.toEqual({
		restartRequired: true,
	});
});

test("stops admission immediately and prevents a late gateway start from launching ComfyUI", async () => {
	const { editor, gateway, runtime } = harness();
	const starting = deferred<string>();
	gateway.start.mockReturnValueOnce(starting.promise);
	const start = editor.start();
	const rejected = expect(start).rejects.toThrow("shutting down");
	const shutdown = editor.shutdown();
	expect(editor.shutdown()).toBe(shutdown);
	await expect(editor.start()).rejects.toThrow("shutting down");
	await expect(editor.installCustomNode(node.repository)).rejects.toThrow(
		"shutting down",
	);
	starting.resolve(url);
	await Promise.all([shutdown, rejected]);
	expect(runtime.start).not.toHaveBeenCalled();
	expect(runtime.stop).toHaveBeenCalledOnce();
});

test("waits for installation cancellation and its selection postprocessing", async () => {
	const { editor, nodes, sync, refresh } = harness();
	const installation = deferred<Awaited<ReturnType<typeof nodes.installCustomNode>>>();
	nodes.installCustomNode.mockReturnValueOnce(installation.promise);
	const canceled = deferred();
	nodes.cancelInstallation.mockReturnValueOnce(canceled.promise);
	const installing = editor.installCustomNode(node.repository);
	const rejected = expect(installing).rejects.toThrow("Canceled.");
	let stopped = false;
	const shutdown = editor.shutdown().then(() => {
		stopped = true;
	});
	installation.reject(new Error("Canceled."));
	await rejected;
	expect(stopped).toBe(false);
	canceled.resolve();
	await shutdown;
	expect(refresh).not.toHaveBeenCalled();
	expect(sync.get).not.toHaveBeenCalled();
});

test("waits for deletion recovery after shutdown cancels the Manager request", async () => {
	const { editor, nodes, sync } = harness();
	const restoring = deferred();
	sync.update.mockReturnValueOnce(restoring.promise);
	nodes.removeCustomNode.mockImplementationOnce(
		(_name, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("Canceled.")), {
					once: true,
				});
			}),
	);
	const removal = editor.removeCustomNode(node.name);
	const rejected = expect(removal).rejects.toThrow("Canceled.");
	await vi.waitFor(() => expect(nodes.removeCustomNode).toHaveBeenCalled());
	let stopped = false;
	const shutdown = editor.shutdown().then(() => {
		stopped = true;
	});
	await vi.waitFor(() => expect(sync.update).toHaveBeenCalled());
	expect(stopped).toBe(false);
	restoring.resolve();
	await Promise.all([rejected, shutdown]);
});

test("allows an admitted model operation to finish recovery before shutdown resolves", async () => {
	const { editor, modelPaths } = harness();
	const publication = deferred();
	modelPaths.syncModels.mockReturnValueOnce(publication.promise);
	let recovered = false;
	const updating = editor.updateModels(async (publish) => {
		try {
			await publish([]);
		} catch {
			await publish([]);
			recovered = true;
		}
	});
	const shutdown = editor.shutdown();
	await expect(editor.updateModels(async () => {})).rejects.toThrow("shutting down");
	publication.reject(new Error("Path replacement failed."));
	await Promise.all([updating, shutdown]);
	expect(recovered).toBe(true);
	expect(modelPaths.syncModels).toHaveBeenCalledTimes(2);
});

test("attaches the recovery reason only when a runtime start was attempted", async () => {
	const { editor, runtime, gateway, setState } = harness();
	setState({ status: "error", message: "Node import failed.", reason: "custom-node" });
	gateway.start.mockRejectedValueOnce(new Error("Gateway unavailable."));
	await expect(editor.start()).rejects.not.toHaveProperty("reason");
	runtime.start.mockRejectedValueOnce(new Error("Node import failed."));
	await expect(editor.start()).rejects.toMatchObject({
		message: "Node import failed.",
		reason: "custom-node",
	});
});

test.each(["install", "remove"] as const)(
	"refreshes the Worker target with readable inventory after a local node %s",
	async (operation) => {
		const { editor, nodes, refresh } = harness();
		const target = deferred<Awaited<ReturnType<EditorComfy["nodesForSync"]>>>();
		refresh.mockImplementation(() => {
			void editor.nodesForSync().then(target.resolve, target.reject);
		});
		const expected = expect(target.promise).resolves.toEqual(
			operation === "install" ? [{ ...node, sync: true }] : [],
		);
		if (operation === "install") await editor.installCustomNode(node.repository);
		else {
			nodes.listCustomNodes.mockResolvedValueOnce([]);
			await editor.removeCustomNode(node.name);
		}
		await expected;
	},
);
