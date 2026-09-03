// @vitest-environment node

import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import {
	openWorkerWorkflowEvents,
	type WorkerWorkflowEventConnection,
} from "./workflow-events";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test("receives live data and reconnects the same Worker job", async () => {
	const server = createServer();
	const sockets = new WebSocketServer({ noServer: true });
	let connections = 0;
	const authorizations: Array<string | undefined> = [];
	const paths: string[] = [];
	server.on("upgrade", (request, socket, head) => {
		authorizations.push(request.headers.authorization);
		paths.push(request.url ?? "");
		sockets.handleUpgrade(request, socket, head, (webSocket) => {
			sockets.emit("connection", webSocket, request);
		});
	});
	sockets.on("connection", (socket) => {
		connections += 1;
		socket.send(
			JSON.stringify({
				sequence: connections,
				message: {
					type: "progress",
					data: { prompt_id: JOB_ID, value: connections, max: 2 },
				},
			}),
		);
		if (connections === 1) {
			socket.send(new Uint8Array([4, 1, 2, 3]));
			setTimeout(() => socket.close(), 10);
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	let connection: WorkerWorkflowEventConnection | null = null;
	cleanups.push(async () => {
		connection?.close();
		for (const socket of sockets.clients) socket.terminate();
		sockets.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const messages: unknown[] = [];
	const previews: Uint8Array[] = [];
	connection = await openWorkerWorkflowEvents(
		{
			workerApiUrl: `http://127.0.0.1:${address.port}`,
			sessionCapability: "test-session-capability",
		},
		JOB_ID,
		{
			onMessage: (message) => messages.push(message),
			onPreview: (preview) => previews.push(preview),
		},
	);
	await waitFor(() => connections === 2);

	expect(paths).toEqual([
		`/workflow-jobs/${JOB_ID}/events`,
		`/workflow-jobs/${JOB_ID}/events`,
	]);
	expect(authorizations).toEqual([
		"Bearer test-session-capability",
		"Bearer test-session-capability",
	]);
	expect(messages).toEqual([
		{ type: "progress", data: { prompt_id: JOB_ID, value: 1, max: 2 } },
		{ type: "progress", data: { prompt_id: JOB_ID, value: 2, max: 2 } },
	]);
	expect(previews.map((preview) => [...preview])).toEqual([[4, 1, 2, 3]]);
});

test("does not reconnect after the initial event stream handshake fails", async () => {
	const server = createServer();
	let upgrades = 0;
	server.on("upgrade", (_request, socket) => {
		upgrades += 1;
		socket.destroy();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

	await expect(
		openWorkerWorkflowEvents(
			{
				workerApiUrl: `http://127.0.0.1:${address.port}`,
				sessionCapability: "test-session-capability",
			},
			JOB_ID,
			{ onMessage: () => undefined, onPreview: () => undefined },
		),
	).rejects.toBeInstanceOf(Error);
	await new Promise((resolve) => setTimeout(resolve, 1_100));

	expect(upgrades).toBe(1);
});

const JOB_ID = "11111111-1111-4111-8111-111111111111";

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for reconnection.");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
