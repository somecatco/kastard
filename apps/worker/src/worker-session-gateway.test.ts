import { expect, test } from "bun:test";
import {
	connect as connectSocket,
	createServer,
	type Server as NetServer,
	type Socket,
} from "node:net";
import {
	createWorkerClientProof,
	deriveWorkerAuthenticationKey,
	parseWorkerAuthenticationChallenge,
	verifyWorkerServerProof,
} from "@kastard/common/session-auth";
import {
	Client,
	type KeyboardInteractiveAuthMethod,
	type KeyboardInteractiveCallback,
	type Prompt,
} from "ssh2";
import {
	isWorkerSessionAuthorized,
	WorkerSessionGateway,
	workerPublicAddress,
} from "./worker-session-gateway";

const AUTHENTICATION_CODE = "ABCD-EFGH-JKLM-NPQR";

test("resolves provider session addresses from their mapped port environment", () => {
	expect(
		workerPublicAddress({
			RUNPOD_PUBLIC_IP: "203.0.113.10",
			RUNPOD_TCP_PORT_22: "22001",
		}),
	).toBe("203.0.113.10:22001");
	expect(
		workerPublicAddress({ PUBLIC_IPADDR: "198.51.100.2", VAST_TCP_PORT_22: "30444" }),
	).toBe("198.51.100.2:30444");
	expect(
		workerPublicAddress({ KASTARD_PUBLIC_ADDRESS: "worker.example.com:22001" }),
	).toBe("worker.example.com:22001");
	expect(() => workerPublicAddress({ RUNPOD_PUBLIC_IP: "203.0.113.10" })).toThrow(
		"RunPod Worker address is incomplete",
	);
	expect(() => workerPublicAddress({})).toThrow("KASTARD_PUBLIC_ADDRESS must be set");
});

test("replaces the active encrypted connection after authenticating the same code", async () => {
	const target = createServer((socket) => socket.pipe(socket));
	await listen(target);
	const targetAddress = target.address();
	if (targetAddress === null || typeof targetAddress === "string") {
		throw new Error("Test target did not listen on TCP.");
	}
	const code = AUTHENTICATION_CODE;
	let createCodeCalls = 0;
	let now = 1_000;
	const capabilities: Array<string | null> = [];
	const infoLogs: string[] = [];
	const gateway = new WorkerSessionGateway({
		listenHost: "127.0.0.1",
		listenPort: 0,
		targetPort: targetAddress.port,
		publicAddress: "203.0.113.10:22001",
		createCode: () => {
			createCodeCalls += 1;
			return code;
		},
		now: () => now,
		logger: {
			info(message) {
				infoLogs.push(String(message));
			},
			error() {},
		},
		onSessionCapabilityChange: (capability) => capabilities.push(capability),
	});
	const gatewayPort = await gateway.start();
	expect(gateway.getAuthenticationState()).toMatchObject({
		code,
		active: false,
	});
	expect(createCodeCalls).toBe(1);
	expect(infoLogs).toContain(
		[
			"",
			"Kastard connection ready",
			"Enter these values in Kastard → Connect:",
			"",
			"Worker address: 203.0.113.10:22001",
			`Authentication code: ${code}`,
		].join("\n"),
	);

	const firstClient = await connectClient(gatewayPort, code);
	const firstCapability = capabilities.at(-1);
	expect(typeof firstCapability).toBe("string");
	if (typeof firstCapability !== "string") {
		throw new Error("Missing session capability.");
	}
	expect(isWorkerSessionAuthorized(`Bearer ${firstCapability}`, firstCapability)).toBe(
		true,
	);
	expect(isWorkerSessionAuthorized("Bearer wrong", firstCapability)).toBe(false);
	expect(isWorkerSessionAuthorized(null, firstCapability)).toBe(false);
	expect(gateway.getAuthenticationState()).toMatchObject({ code, active: true });
	expect(infoLogs).toContain("Editor connected.");
	expect(await forwardEcho(firstClient, 5278, "first")).toBe("first");

	now += 24 * 60 * 60_000;
	const firstClientClosed = new Promise<void>((resolve) =>
		firstClient.once("close", resolve),
	);
	const replacementClient = await connectClient(gatewayPort, code);
	await firstClientClosed;
	const replacementCapability = capabilities.at(-1);
	expect(typeof replacementCapability).toBe("string");
	if (typeof replacementCapability !== "string") {
		throw new Error("Missing replacement session capability.");
	}
	expect(replacementCapability).not.toBe(firstCapability);
	expect(capabilities).toEqual([firstCapability, replacementCapability]);
	expect(
		isWorkerSessionAuthorized(`Bearer ${firstCapability}`, replacementCapability),
	).toBe(false);
	expect(gateway.getAuthenticationState()).toMatchObject({ code, active: true });
	expect(await forwardEcho(replacementClient, 5278, "replacement")).toBe("replacement");

	replacementClient.end();
	await new Promise<void>((resolve) => replacementClient.once("close", resolve));
	await waitFor(() => !gateway.getAuthenticationState().active);
	expect(capabilities.at(-1)).toBeNull();
	expect(infoLogs).toContain(
		"Editor disconnected. Reconnect with the same authentication code.",
	);
	expect(createCodeCalls).toBe(1);

	const reconnectedClient = await connectClient(gatewayPort, code);
	expect(gateway.getAuthenticationState()).toMatchObject({ code, active: true });
	reconnectedClient.end();
	await new Promise<void>((resolve) => reconnectedClient.once("close", resolve));

	await gateway.stop();
	await close(target);
});

test("keeps the active connection when replacement authentication fails", async () => {
	const target = createServer((socket) => socket.pipe(socket));
	await listen(target);
	const targetAddress = target.address();
	if (targetAddress === null || typeof targetAddress === "string") {
		throw new Error("Test target did not listen on TCP.");
	}
	const capabilities: Array<string | null> = [];
	const gateway = new WorkerSessionGateway({
		listenHost: "127.0.0.1",
		listenPort: 0,
		targetPort: targetAddress.port,
		createCode: () => AUTHENTICATION_CODE,
		logger: { info() {}, error() {} },
		onSessionCapabilityChange: (capability) => capabilities.push(capability),
	});
	const gatewayPort = await gateway.start();
	const activeClient = await connectClient(gatewayPort, AUTHENTICATION_CODE);
	const capability = capabilities.at(-1);
	if (typeof capability !== "string") throw new Error("Missing session capability.");

	await expect(connectClient(gatewayPort, "WXYZ-2345-ABCD-EFGH")).rejects.toThrow(
		"All configured authentication methods failed",
	);
	expect(gateway.getAuthenticationState().active).toBe(true);
	expect(capabilities).toEqual([capability]);
	expect(await forwardEcho(activeClient, 5278, "active")).toBe("active");

	activeClient.end();
	await new Promise<void>((resolve) => activeClient.once("close", resolve));
	await gateway.stop();
	await close(target);
});

test("rate limits repeated authentication attempts from one client IP", async () => {
	let now = 1_000;
	const gateway = new WorkerSessionGateway({
		listenHost: "127.0.0.1",
		listenPort: 0,
		now: () => now,
		createCode: () => AUTHENTICATION_CODE,
		logger: { info() {}, error() {} },
	});
	const gatewayPort = await gateway.start();

	await expect(connectClient(gatewayPort, "WXYZ-2345-ABCD-EFGH")).rejects.toThrow(
		"All configured authentication methods failed",
	);
	await expect(connectClient(gatewayPort, AUTHENTICATION_CODE)).rejects.toThrow(
		"All configured authentication methods failed",
	);

	now += 500;
	const client = await connectClient(gatewayPort, AUTHENTICATION_CODE);
	expect(gateway.getAuthenticationState().active).toBe(true);
	client.end();
	await new Promise<void>((resolve) => client.once("close", resolve));
	await gateway.stop();
});

test("releases unauthenticated clients after the authentication deadline", async () => {
	const gateway = new WorkerSessionGateway({
		listenHost: "127.0.0.1",
		listenPort: 0,
		authenticationTimeoutMs: 20,
		createCode: () => AUTHENTICATION_CODE,
		logger: { info() {}, error() {} },
	});
	const gatewayPort = await gateway.start();
	const pendingClient = await connectPendingClient(gatewayPort);

	await waitForClientClose(pendingClient);
	const client = await connectClient(gatewayPort, AUTHENTICATION_CODE);
	client.end();
	await new Promise<void>((resolve) => client.once("close", resolve));
	await gateway.stop();
});

test("limits concurrent clients per IP and releases their slots after close", async () => {
	const gateway = new WorkerSessionGateway({
		listenHost: "127.0.0.1",
		listenPort: 0,
		createCode: () => AUTHENTICATION_CODE,
		logger: { info() {}, error() {} },
	});
	const gatewayPort = await gateway.start();
	const pendingClients: Client[] = [];
	for (let index = 0; index < 4; index += 1) {
		pendingClients.push(await connectPendingClient(gatewayPort));
	}

	await expect(connectClient(gatewayPort, AUTHENTICATION_CODE)).rejects.toThrow();
	await Promise.all(
		pendingClients.map(
			(client) =>
				new Promise<void>((resolve) => {
					client.once("close", resolve);
					client.destroy();
				}),
		),
	);
	const client = await connectClientEventually(gatewayPort, AUTHENTICATION_CODE);
	client.end();
	await new Promise<void>((resolve) => client.once("close", resolve));
	await gateway.stop();
});

test("limits TCP connections before the SSH version exchange", async () => {
	const gateway = new WorkerSessionGateway({
		listenHost: "127.0.0.1",
		listenPort: 0,
		logger: { info() {}, error() {} },
	});
	const gatewayPort = await gateway.start();
	const clients = await Promise.all(
		Array.from({ length: 64 }, () => connectRawClient(gatewayPort)),
	);
	const excessClient = await connectRawClient(gatewayPort);

	await waitForSocketClose(excessClient);
	await Promise.all(
		clients.map(
			(client) =>
				new Promise<void>((resolve) => {
					client.once("close", resolve);
					client.destroy();
				}),
		),
	);
	await gateway.stop();
});

function connectClient(port: number, code: string): Promise<Client> {
	const client = new Client();
	let hostKey: Buffer | null = null;
	const authentication: KeyboardInteractiveAuthMethod = {
		type: "keyboard-interactive",
		username: "kastard",
		prompt: (
			_name: string,
			_instructions: string,
			_language: string,
			prompts: Prompt[],
			finish: KeyboardInteractiveCallback,
		) => {
			const challenge = parseWorkerAuthenticationChallenge(prompts[0]?.prompt ?? "");
			const authenticationKey =
				hostKey === null ? null : deriveWorkerAuthenticationKey(code, hostKey);
			if (
				challenge === null ||
				hostKey === null ||
				authenticationKey === null ||
				!verifyWorkerServerProof(challenge, authenticationKey, hostKey)
			) {
				finish([]);
				return;
			}
			finish([createWorkerClientProof(authenticationKey, hostKey, challenge.nonce)]);
			authenticationKey.fill(0);
		},
	};
	return new Promise((resolve, reject) => {
		client.once("ready", () => resolve(client));
		client.once("error", reject);
		client.once("close", () => reject(new Error("SSH client closed before ready.")));
		client.connect({
			host: "127.0.0.1",
			port,
			username: "kastard",
			readyTimeout: 1_000,
			hostVerifier: (key: Buffer) => {
				hostKey = Buffer.from(key);
				return true;
			},
			authHandler: [authentication],
		});
	});
}

function connectPendingClient(port: number): Promise<Client> {
	const client = new Client();
	return new Promise((resolve, reject) => {
		let settled = false;
		const onError = (error: Error): void => {
			if (!settled) reject(error);
		};
		client.on("error", onError);
		client.once("close", () => {
			if (!settled)
				reject(new Error("Pending SSH client closed before authentication."));
		});
		const authentication: KeyboardInteractiveAuthMethod = {
			type: "keyboard-interactive",
			username: "kastard",
			prompt: () => {
				settled = true;
				resolve(client);
			},
		};
		client.connect({
			host: "127.0.0.1",
			port,
			username: "kastard",
			readyTimeout: 1_000,
			hostVerifier: () => true,
			authHandler: [authentication],
		});
	});
}

function connectRawClient(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const client = connectSocket(port, "127.0.0.1");
		client.once("connect", () => resolve(client));
		client.once("error", reject);
	});
}

async function connectClientEventually(port: number, code: string): Promise<Client> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			return await connectClient(port, code);
		} catch (error) {
			lastError = error;
			await Bun.sleep(1);
		}
	}
	throw lastError;
}

async function waitForClientClose(client: Client): Promise<void> {
	await Promise.race([
		new Promise<void>((resolve) => client.once("close", resolve)),
		Bun.sleep(1_000).then(() => {
			throw new Error("Timed out waiting for pending SSH client to close.");
		}),
	]);
}

async function waitForSocketClose(client: Socket): Promise<void> {
	if (client.destroyed) return;
	await Promise.race([
		new Promise<void>((resolve) => client.once("close", resolve)),
		Bun.sleep(1_000).then(() => {
			throw new Error("Timed out waiting for excess TCP client to close.");
		}),
	]);
}

function forwardEcho(client: Client, port: number, input: string): Promise<string> {
	return new Promise((resolve, reject) => {
		client.forwardOut("127.0.0.1", 1, "127.0.0.1", port, (error, channel) => {
			if (error !== undefined) {
				reject(error);
				return;
			}
			channel.setEncoding("utf8");
			channel.once("data", (data: string) => {
				channel.end();
				resolve(data);
			});
			channel.once("error", reject);
			channel.write(input);
		});
	});
}

function listen(server: NetServer): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function close(server: NetServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for Worker session state.");
}
