// @vitest-environment node

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import {
	createWorkerAuthenticationChallenge,
	deriveWorkerAuthenticationKey,
	serializeWorkerAuthenticationChallenge,
	verifyWorkerClientProof,
} from "@kastard/common/session-auth";
import { type Connection, Server as SshServer, utils } from "ssh2";
import { expect, test, vi } from "vitest";
import { WorkerSessionGateway } from "../../../../server/src/worker-session-gateway";
import { connectWorkerTunnel, normalizeWorkerAddress } from "./tunnel";

const AUTHENTICATION_CODE = "ABCD-EFGH-JKLM-NPQR";

test("normalizes Worker host and port addresses", () => {
	expect(normalizeWorkerAddress(" worker.example.com:22001 ")).toBe(
		"worker.example.com:22001",
	);
	expect(normalizeWorkerAddress("[2001:db8::1]:22001")).toBe("[2001:db8::1]:22001");
});

test("rejects addresses outside the session host and port contract", () => {
	expect(() => normalizeWorkerAddress("https://worker.example.com:22001")).toThrow(
		"host:port",
	);
	expect(() => normalizeWorkerAddress("worker.example.com")).toThrow("host:port");
	expect(() => normalizeWorkerAddress("worker.example.com:0")).toThrow("invalid port");
	expect(() => normalizeWorkerAddress("user@worker.example.com:22001")).toThrow(
		"host:port",
	);
});

test("forwards HTTP through an authenticated Worker session", async () => {
	const target = createHttpServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end('{"status":"ok"}');
	});
	await new Promise<void>((resolve, reject) => {
		target.once("error", reject);
		target.listen(0, "127.0.0.1", () => {
			target.off("error", reject);
			resolve();
		});
	});
	const targetAddress = target.address();
	if (targetAddress === null || typeof targetAddress === "string") {
		throw new Error("Test HTTP server did not listen on TCP.");
	}
	const gateway = new WorkerSessionGateway({
		listenHost: "127.0.0.1",
		listenPort: 0,
		targetPort: targetAddress.port,
		createCode: () => AUTHENTICATION_CODE,
		logger: { info() {}, error() {} },
	});
	const gatewayPort = await gateway.start();
	let tunnel: Awaited<ReturnType<typeof connectWorkerTunnel>> | null = null;
	try {
		tunnel = await connectWorkerTunnel(`127.0.0.1:${gatewayPort}`, AUTHENTICATION_CODE);
		const response = await fetch(`${tunnel.endpointUrl}/health`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	} finally {
		await tunnel?.close();
		await gateway.stop();
		await new Promise<void>((resolve) => target.close(() => resolve()));
	}
});

test("explains authentication rejection without blaming an active session", async () => {
	const gateway = new WorkerSessionGateway({
		listenHost: "127.0.0.1",
		listenPort: 0,
		createCode: () => AUTHENTICATION_CODE,
		logger: { info() {}, error() {} },
	});
	const gatewayPort = await gateway.start();
	try {
		await expect(
			connectWorkerTunnel(`127.0.0.1:${gatewayPort}`, "WXYZ-2345-ABCD-EFGH"),
		).rejects.toThrow(
			"Worker authentication failed. Check the Worker address and authentication code, then retry shortly.",
		);
	} finally {
		await gateway.stop();
	}
});

test("contains a rejected SSH channel to the originating HTTP request", async () => {
	const code = AUTHENTICATION_CODE;
	const testServer = await startTestSshServer(code, (client) => {
		client.on("tcpip", (_accept, reject) => reject());
	});

	try {
		const tunnel = await connectWorkerTunnel(`127.0.0.1:${testServer.port}`, code);
		try {
			await expect(fetch(`${tunnel.endpointUrl}/health`)).rejects.toThrow();
		} finally {
			await tunnel.close();
		}
	} finally {
		await testServer.close();
	}
});

test("settles when SSH closes while the local listener is opening", async () => {
	const code = AUTHENTICATION_CODE;
	const testServer = await startTestSshServer(code, (client) => {
		client.once("ready", () => client.end());
	});
	vi.resetModules();
	vi.doMock("node:net", async (importOriginal) => {
		const actual = await importOriginal<typeof import("node:net")>();
		return {
			...actual,
			createServer: (...args: unknown[]) => {
				const server = Reflect.apply(actual.createServer, actual, args);
				const listen = server.listen.bind(server);
				server.listen = ((...listenArgs: unknown[]) => {
					const callbackIndex = listenArgs.findIndex(
						(argument: unknown) => typeof argument === "function",
					);
					if (callbackIndex >= 0) {
						const callback = listenArgs[callbackIndex] as () => void;
						listenArgs[callbackIndex] = () => setTimeout(callback, 50);
					}
					return Reflect.apply(listen, server, listenArgs);
				}) as typeof server.listen;
				return server;
			},
		};
	});

	try {
		const { connectWorkerTunnel: connectWithDelayedListener } = await import(
			"./tunnel"
		);
		await expect(
			connectWithDelayedListener(`127.0.0.1:${testServer.port}`, code),
		).rejects.toThrow("The Worker ended the session");
	} finally {
		vi.doUnmock("node:net");
		vi.resetModules();
		await testServer.close();
	}
});

test("notifies a subscriber that attaches after SSH closes", async () => {
	const code = AUTHENTICATION_CODE;
	const testServer = await startTestSshServer(code, () => undefined);
	const tunnel = await connectWorkerTunnel(`127.0.0.1:${testServer.port}`, code);
	let unsubscribe = (): void => undefined;
	const closed = new Promise<void>((resolve) => {
		unsubscribe = tunnel.onClose(() => {
			unsubscribe();
			resolve();
		});
	});

	try {
		await testServer.disconnectClients();
		await closed;
		const listener = vi.fn();
		const unsubscribeLateListener = tunnel.onClose(listener);

		expect(listener).toHaveBeenCalledOnce();
		unsubscribeLateListener();
	} finally {
		await tunnel.close();
		await testServer.close();
	}
});

async function startTestSshServer(
	code: string,
	configureClient: (client: Connection) => void,
): Promise<{
	port: number;
	disconnectClients: () => Promise<void>;
	close: () => Promise<void>;
}> {
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const hostKey = privateKey.export({ type: "sec1", format: "pem" }).toString();
	const parsedHostKey = utils.parseKey(hostKey);
	if (parsedHostKey instanceof Error) throw parsedHostKey;
	const publicHostKey = parsedHostKey.getPublicSSH();
	const authenticationKey = deriveWorkerAuthenticationKey(code, publicHostKey);
	const clients = new Set<Connection>();
	const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
		clients.add(client);
		client.on("error", () => undefined);
		client.once("close", () => clients.delete(client));
		configureClient(client);
		client.on("authentication", (context) => {
			if (context.method !== "keyboard-interactive") {
				context.reject(["keyboard-interactive"]);
				return;
			}
			const challenge = createWorkerAuthenticationChallenge(
				authenticationKey,
				publicHostKey,
				randomBytes(32),
			);
			context.prompt(
				[
					{
						prompt: serializeWorkerAuthenticationChallenge(challenge),
						echo: false,
					},
				],
				"Kastard Worker",
				(responses) => {
					if (
						responses[0] !== undefined &&
						verifyWorkerClientProof(
							responses[0],
							authenticationKey,
							publicHostKey,
							challenge.nonce,
						)
					) {
						context.accept();
						return;
					}
					context.reject(["keyboard-interactive"]);
				},
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Test SSH server did not listen on TCP.");
	}

	return {
		port: address.port,
		disconnectClients: async () => {
			const disconnected = [...clients].map(
				(client) =>
					new Promise<void>((resolve) => {
						client.once("close", resolve);
					}),
			);
			for (const client of clients) client.end();
			await Promise.all(disconnected);
		},
		close: async () => {
			for (const client of clients) client.end();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			authenticationKey.fill(0);
		},
	};
}
