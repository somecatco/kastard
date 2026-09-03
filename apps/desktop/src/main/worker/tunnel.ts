import { createServer, type Server, type Socket } from "node:net";
import {
	createWorkerClientProof,
	createWorkerSessionCapability,
	deriveWorkerAuthenticationKey,
	normalizeWorkerAuthenticationCode,
	parseWorkerAuthenticationChallenge,
	verifyWorkerServerProof,
} from "@kastard/common/session-auth";
import {
	Client,
	type KeyboardInteractiveAuthMethod,
	type KeyboardInteractiveCallback,
	type Prompt,
} from "ssh2";

const WORKER_USERNAME = "kastard";
const WORKER_API_HOST = "127.0.0.1";
const WORKER_API_PORT = 5278;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export type WorkerTunnel = {
	endpointUrl: string;
	workerAddress: string;
	sessionCapability: string;
	close: () => Promise<void>;
	onClose: (listener: () => void) => () => void;
};

export async function connectWorkerTunnel(
	addressInput: string,
	authenticationCodeInput: string,
	signal?: AbortSignal,
): Promise<WorkerTunnel> {
	const address = parseWorkerAddress(addressInput);
	const authenticationCode = normalizeWorkerAuthenticationCode(authenticationCodeInput);
	if (authenticationCode === null) {
		throw new Error(
			"Enter the sixteen-character authentication code shown by the Worker.",
		);
	}
	if (signal?.aborted) throw signal.reason;

	const client = new Client();
	let hostKey: Buffer | null = null;
	let authenticationFailed = false;
	let sessionCapability: string | null = null;
	const abort = (): void => {
		client.destroy();
	};
	signal?.addEventListener("abort", abort, { once: true });
	const authMethod: KeyboardInteractiveAuthMethod = {
		type: "keyboard-interactive",
		username: WORKER_USERNAME,
		prompt: (
			_name: string,
			_instructions: string,
			_language: string,
			prompts: Prompt[],
			finish: KeyboardInteractiveCallback,
		) => {
			const response = authenticationResponse(prompts, authenticationCode, hostKey);
			if (response === null) authenticationFailed = true;
			if (response !== null) sessionCapability = response.sessionCapability;
			finish(response === null ? [] : [response.clientProof]);
		},
	};

	try {
		await new Promise<void>((resolve, reject) => {
			client.once("ready", resolve);
			client.once("error", reject);
			client.once("close", () => reject(new Error("The Worker ended the session.")));
			client.connect({
				host: address.host,
				port: address.port,
				username: WORKER_USERNAME,
				readyTimeout: DEFAULT_CONNECTION_TIMEOUT_MS,
				keepaliveInterval: 15_000,
				keepaliveCountMax: 3,
				hostVerifier: (key: Buffer) => {
					hostKey = Buffer.from(key);
					return true;
				},
				authHandler: [authMethod],
			});
		});
	} catch (error) {
		client.destroy();
		if (signal?.aborted) throw signal.reason;
		if (authenticationFailed || isAuthenticationError(error)) {
			throw new Error(
				"Worker authentication failed. Check the Worker address and authentication code, then retry shortly.",
			);
		}
		throw new Error(
			`Could not open the encrypted Worker session. ${errorMessage(error)}`,
		);
	} finally {
		signal?.removeEventListener("abort", abort);
	}

	if (sessionCapability === null) {
		client.destroy();
		throw new Error("The Worker did not establish a session capability.");
	}
	return createLocalTunnel(client, address.display, sessionCapability);
}

export function normalizeWorkerAddress(value: string): string {
	return parseWorkerAddress(value).display;
}

function authenticationResponse(
	prompts: Prompt[],
	code: string,
	hostKey: Buffer | null,
): { clientProof: string; sessionCapability: string } | null {
	if (prompts.length !== 1 || hostKey === null) return null;
	const challenge = parseWorkerAuthenticationChallenge(prompts[0]?.prompt ?? "");
	if (challenge === null) return null;
	const authenticationKey = deriveWorkerAuthenticationKey(code, hostKey);
	try {
		if (!verifyWorkerServerProof(challenge, authenticationKey, hostKey)) return null;
		return {
			clientProof: createWorkerClientProof(authenticationKey, hostKey, challenge.nonce),
			sessionCapability: createWorkerSessionCapability(
				authenticationKey,
				hostKey,
				challenge.nonce,
			),
		};
	} finally {
		authenticationKey.fill(0);
	}
}

async function createLocalTunnel(
	client: Client,
	workerAddress: string,
	sessionCapability: string,
): Promise<WorkerTunnel> {
	const sockets = new Set<Socket>();
	const closeListeners = new Set<() => void>();
	let closing = false;
	let closed = false;
	const localServer = createServer((socket) => {
		let activeChannel: { destroy: () => void } | null = null;
		sockets.add(socket);
		socket.once("error", () => activeChannel?.destroy());
		socket.once("close", () => {
			sockets.delete(socket);
			activeChannel?.destroy();
		});
		client.forwardOut(
			socket.remoteAddress ?? WORKER_API_HOST,
			socket.remotePort ?? 0,
			WORKER_API_HOST,
			WORKER_API_PORT,
			(error, channel) => {
				if (error !== undefined) {
					socket.destroy();
					return;
				}
				activeChannel = channel;
				if (socket.destroyed) {
					channel.destroy();
					return;
				}
				channel.once("error", () => socket.destroy());
				socket.pipe(channel).pipe(socket);
			},
		);
	});
	localServer.on("error", () => undefined);
	client.once("close", () => {
		closed = true;
		closeLocalServer(localServer, sockets);
		if (!closing) {
			for (const listener of closeListeners) listener();
		}
	});
	try {
		await listenOnLoopback(localServer);
	} catch (error) {
		client.end();
		throw new Error(`Could not open the local Worker tunnel. ${errorMessage(error)}`);
	}
	if (closed) {
		closeLocalServer(localServer, sockets);
		throw new Error(
			"Could not open the local Worker tunnel. The Worker ended the session.",
		);
	}

	const address = localServer.address();
	if (address === null || typeof address === "string") {
		client.end();
		throw new Error("Could not determine the local Worker tunnel address.");
	}

	return {
		endpointUrl: `http://${WORKER_API_HOST}:${address.port}`,
		workerAddress,
		sessionCapability,
		close: async () => {
			if (closed) return;
			closing = true;
			closeLocalServer(localServer, sockets);
			client.end();
			await new Promise<void>((resolve) => {
				if (closed) {
					resolve();
					return;
				}
				client.once("close", resolve);
			});
		},
		onClose: (listener) => {
			if (closed) {
				listener();
				return () => undefined;
			}
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
	};
}

function listenOnLoopback(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, WORKER_API_HOST, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeLocalServer(server: Server, sockets: Set<Socket>): void {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	if (server.listening) server.close();
}

function parseWorkerAddress(value: string): {
	host: string;
	port: number;
	display: string;
} {
	let url: URL;
	try {
		const input = value.trim();
		if (input === "" || /^[a-z][a-z\d+.-]*:\/\//i.test(input)) throw new Error();
		url = new URL(`ssh://${input}`);
	} catch {
		throw new Error("Enter a Worker address as host:port.");
	}
	if (
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.hostname === "" ||
		url.port === ""
	) {
		throw new Error("Enter a Worker address as host:port.");
	}
	const port = Number(url.port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("The Worker address contains an invalid port.");
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	return {
		host,
		port,
		display: `${host.includes(":") ? `[${host}]` : host}:${port}`,
	};
}

function isAuthenticationError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"level" in error &&
		(error as { level?: unknown }).level === "client-authentication"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
