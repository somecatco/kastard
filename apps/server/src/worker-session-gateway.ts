import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { connect } from "node:net";
import {
	createWorkerAuthenticationChallenge,
	createWorkerSessionCapability,
	deriveWorkerAuthenticationKey,
	serializeWorkerAuthenticationChallenge,
	verifyWorkerClientProof,
	verifyWorkerSessionCapability,
} from "@kastard/common/session-auth";
import { type Connection, Server, utils } from "ssh2";

const AUTHENTICATION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const AUTHENTICATION_CODE_LENGTH = 16;
const AUTHENTICATION_FAILURE_RESET_MS = 10 * 60_000;
const AUTHENTICATION_RETRY_BASE_DELAY_MS = 500;
const AUTHENTICATION_RETRY_MAX_DELAY_MS = 30_000;
const AUTHENTICATION_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_CLIENTS = 16;
const MAX_CONCURRENT_CLIENTS_PER_IP = 4;
const MAX_CONCURRENT_TCP_CONNECTIONS = 64;
const MAX_TRACKED_CLIENT_IPS = 1_024;
const WORKER_API_HOST = "127.0.0.1";
const WORKER_API_PORT = 5278;

type Logger = Pick<typeof console, "info" | "error">;

type AuthenticationFailureState = {
	failures: number;
	lastFailedAt: number;
	retryAt: number;
};

export type WorkerSessionGatewayOptions = {
	listenHost?: string;
	listenPort?: number;
	targetHost?: string;
	targetPort?: number;
	publicAddress?: string;
	authenticationTimeoutMs?: number;
	now?: () => number;
	createCode?: () => string;
	logger?: Logger;
	onSessionCapabilityChange?: (capability: string | null) => void;
};

export class WorkerSessionGateway {
	private readonly listenHost: string;
	private readonly listenPort: number;
	private readonly targetHost: string;
	private readonly targetPort: number;
	private readonly configuredPublicAddress: string | undefined;
	private readonly authenticationTimeoutMs: number;
	private readonly now: () => number;
	private readonly createCode: () => string;
	private readonly logger: Logger;
	private readonly onSessionCapabilityChange: (capability: string | null) => void;
	private readonly hostKey: string;
	private readonly publicHostKey: Buffer;
	private readonly clients = new Set<Connection>();
	private readonly clientCountsByIp = new Map<string, number>();
	private readonly authenticationFailuresByIp = new Map<
		string,
		AuthenticationFailureState
	>();
	private server: Server | null = null;
	private activeClient: Connection | null = null;
	private code = "";
	private authenticationKey: Buffer | null = null;

	constructor(options: WorkerSessionGatewayOptions = {}) {
		this.listenHost = options.listenHost ?? "0.0.0.0";
		this.listenPort = options.listenPort ?? 22;
		this.targetHost = options.targetHost ?? "127.0.0.1";
		this.targetPort = options.targetPort ?? 5278;
		this.configuredPublicAddress = options.publicAddress;
		this.authenticationTimeoutMs =
			options.authenticationTimeoutMs ?? AUTHENTICATION_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
		this.createCode = options.createCode ?? createAuthenticationCode;
		this.logger = options.logger ?? console;
		this.onSessionCapabilityChange =
			options.onSessionCapabilityChange ?? (() => undefined);
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		this.hostKey = privateKey.export({ type: "sec1", format: "pem" }).toString();
		const parsed = utils.parseKey(this.hostKey);
		if (parsed instanceof Error) throw parsed;
		this.publicHostKey = parsed.getPublicSSH();
	}

	async start(): Promise<number> {
		if (this.server !== null)
			throw new Error("Worker session gateway is already started.");
		const server = new Server(
			{
				hostKeys: [this.hostKey],
				keepaliveInterval: 15_000,
				keepaliveCountMax: 3,
			},
			(client, info) => this.handleClient(client, info.ip),
		);
		server.maxConnections = MAX_CONCURRENT_TCP_CONNECTIONS;
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.listenPort, this.listenHost);
		});
		server.on("error", (error: Error) =>
			this.logger.error(`Worker session gateway failed: ${error.message}`),
		);
		this.issueCode();
		return this.boundPort();
	}

	async stop(): Promise<void> {
		this.clearAuthenticationKey();
		this.onSessionCapabilityChange(null);
		for (const client of this.clients) client.end();
		this.clients.clear();
		this.clientCountsByIp.clear();
		this.authenticationFailuresByIp.clear();
		this.activeClient = null;
		const server = this.server;
		this.server = null;
		if (server === null) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	getAuthenticationState(): { code: string; active: boolean } {
		return {
			code: this.code,
			active: this.activeClient !== null,
		};
	}

	private handleClient(client: Connection, clientIp: string): void {
		client.on("error", () => undefined);
		const clientCount = this.clientCountsByIp.get(clientIp) ?? 0;
		if (
			this.clients.size >= MAX_CONCURRENT_CLIENTS ||
			clientCount >= MAX_CONCURRENT_CLIENTS_PER_IP
		) {
			this.logger.error(`Rejected excess Worker session from ${clientIp}.`);
			client.end();
			return;
		}
		this.clients.add(client);
		this.clientCountsByIp.set(clientIp, clientCount + 1);
		let clientIsCounted = true;
		const releaseClient = (): void => {
			if (!clientIsCounted) return;
			clientIsCounted = false;
			this.clients.delete(client);
			const remainingClientCount = (this.clientCountsByIp.get(clientIp) ?? 1) - 1;
			if (remainingClientCount === 0) this.clientCountsByIp.delete(clientIp);
			else this.clientCountsByIp.set(clientIp, remainingClientCount);
		};
		const authenticationDeadline = setTimeout(() => {
			releaseClient();
			this.logger.error(`Closed unauthenticated Worker session from ${clientIp}.`);
			client.end();
		}, this.authenticationTimeoutMs);
		authenticationDeadline.unref?.();
		client.on("session", (_accept, reject) => reject());
		client.on("openssh.streamlocal", (_accept, reject) => reject());
		client.on("request", (_accept, reject) => reject?.());
		client.on("tcpip", (accept, reject, info) => {
			if (
				this.activeClient !== client ||
				info.destIP !== WORKER_API_HOST ||
				info.destPort !== WORKER_API_PORT
			) {
				this.logger.error(
					`Rejected Worker API tunnel request to ${info.destIP}:${info.destPort}.`,
				);
				reject();
				return;
			}
			const channel = accept();
			const upstream = connect(this.targetPort, this.targetHost);
			upstream.once("connect", () => channel.pipe(upstream).pipe(channel));
			upstream.once("error", (error) => {
				this.logger.error(`Worker API tunnel failed: ${error.message}`);
				channel.destroy();
			});
			channel.once("error", () => upstream.destroy());
			channel.once("close", () => upstream.destroy());
		});
		client.on("authentication", (context) => {
			if (!clientIsCounted) {
				context.reject(["keyboard-interactive"]);
				return;
			}
			if (context.method !== "keyboard-interactive" || context.username !== "kastard") {
				context.reject(["keyboard-interactive"]);
				return;
			}
			if (this.authenticationIsRateLimited(clientIp)) {
				this.logger.error(`Rejected rate-limited Worker session from ${clientIp}.`);
				context.reject(["keyboard-interactive"]);
				return;
			}
			const authenticationKey = this.authenticationKey;
			if (authenticationKey === null) {
				context.reject(["keyboard-interactive"]);
				return;
			}
			const challenge = createWorkerAuthenticationChallenge(
				authenticationKey,
				this.publicHostKey,
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
					const response = responses[0];
					if (!clientIsCounted || this.authenticationKey !== authenticationKey) {
						context.reject(["keyboard-interactive"]);
						return;
					}
					if (
						response === undefined ||
						!verifyWorkerClientProof(
							response,
							authenticationKey,
							this.publicHostKey,
							challenge.nonce,
						)
					) {
						this.recordAuthenticationFailure(clientIp);
						context.reject(["keyboard-interactive"]);
						return;
					}
					this.authenticationFailuresByIp.delete(clientIp);
					clearTimeout(authenticationDeadline);
					const previousClient = this.activeClient;
					this.activeClient = client;
					this.onSessionCapabilityChange(
						createWorkerSessionCapability(
							authenticationKey,
							this.publicHostKey,
							challenge.nonce,
						),
					);
					context.accept();
					if (previousClient !== null && previousClient !== client) {
						previousClient.end();
					}
				},
			);
		});
		client.on("ready", () => {
			clearTimeout(authenticationDeadline);
			if (this.activeClient !== client) {
				client.end();
				return;
			}
			this.logger.info("Editor connected.");
		});
		client.once("close", () => {
			clearTimeout(authenticationDeadline);
			releaseClient();
			if (this.activeClient !== client) return;
			this.activeClient = null;
			this.onSessionCapabilityChange(null);
			this.logger.info(
				"Editor disconnected. Reconnect with the same authentication code.",
			);
		});
	}

	private issueCode(): void {
		this.clearAuthenticationKey();
		this.code = this.createCode();
		this.authenticationKey = deriveWorkerAuthenticationKey(
			this.code,
			this.publicHostKey,
		);
		const address = this.configuredPublicAddress ?? `127.0.0.1:${this.boundPort()}`;
		this.logger.info(
			[
				"",
				"Kastard connection ready",
				"Enter these values in Kastard → Connect:",
				"",
				`Worker address: ${address}`,
				`Authentication code: ${this.code}`,
			].join("\n"),
		);
	}

	private authenticationIsRateLimited(clientIp: string): boolean {
		const now = this.now();
		this.pruneAuthenticationFailures(now);
		const state = this.authenticationFailuresByIp.get(clientIp);
		return state !== undefined && now < state.retryAt;
	}

	private recordAuthenticationFailure(clientIp: string): void {
		const now = this.now();
		this.pruneAuthenticationFailures(now);
		const previous = this.authenticationFailuresByIp.get(clientIp);
		const failures = (previous?.failures ?? 0) + 1;
		const delay = Math.min(
			AUTHENTICATION_RETRY_BASE_DELAY_MS * 2 ** Math.min(failures - 1, 16),
			AUTHENTICATION_RETRY_MAX_DELAY_MS,
		);
		if (previous !== undefined) this.authenticationFailuresByIp.delete(clientIp);
		while (this.authenticationFailuresByIp.size >= MAX_TRACKED_CLIENT_IPS) {
			const oldestClientIp = this.authenticationFailuresByIp.keys().next().value;
			if (oldestClientIp === undefined) break;
			this.authenticationFailuresByIp.delete(oldestClientIp);
		}
		this.authenticationFailuresByIp.set(clientIp, {
			failures,
			lastFailedAt: now,
			retryAt: now + delay,
		});
		this.logger.error(`Worker authentication failed from ${clientIp}.`);
	}

	private pruneAuthenticationFailures(now: number): void {
		for (const [clientIp, state] of this.authenticationFailuresByIp) {
			if (now - state.lastFailedAt >= AUTHENTICATION_FAILURE_RESET_MS) {
				this.authenticationFailuresByIp.delete(clientIp);
			}
		}
	}

	private clearAuthenticationKey(): void {
		this.authenticationKey?.fill(0);
		this.authenticationKey = null;
	}

	private boundPort(): number {
		const address = this.server?.address();
		if (address === null || address === undefined || typeof address === "string") {
			throw new Error("Worker session gateway is not listening.");
		}
		return address.port;
	}
}

export function workerPublicAddress(environment: NodeJS.ProcessEnv): string {
	const address =
		providerAddress(environment, "RUNPOD_PUBLIC_IP", "RUNPOD_TCP_PORT_22", "RunPod") ??
		providerAddress(environment, "PUBLIC_IPADDR", "VAST_TCP_PORT_22", "Vast.ai") ??
		optionalAddress(environment.KASTARD_PUBLIC_ADDRESS);
	if (address === undefined) {
		throw new Error(
			"KASTARD_PUBLIC_ADDRESS must be set to the externally reachable host:port outside RunPod or Vast.ai.",
		);
	}
	return address;
}

export function isWorkerSessionAuthorized(
	authorization: string | null,
	capability: string | null,
): boolean {
	if (authorization === null || capability === null) return false;
	const prefix = "Bearer ";
	if (!authorization.startsWith(prefix)) return false;
	return verifyWorkerSessionCapability(authorization.slice(prefix.length), capability);
}

function providerAddress(
	environment: NodeJS.ProcessEnv,
	hostName: string,
	portName: string,
	provider: string,
): string | undefined {
	const host = environment[hostName];
	const port = environment[portName];
	if (host === undefined && port === undefined) return undefined;
	if (host === undefined || port === undefined) {
		throw new Error(`${provider} Worker address is incomplete.`);
	}
	return normalizeAddress(`${host}:${port}`);
}

function optionalAddress(value: string | undefined): string | undefined {
	return value === undefined || value.trim() === ""
		? undefined
		: normalizeAddress(value);
}

function normalizeAddress(value: string): string {
	const trimmed = value.trim();
	const url = new URL(`ssh://${trimmed}`);
	if (
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.hostname === "" ||
		url.port === ""
	) {
		throw new Error("Worker address must contain only a host and port.");
	}
	const port = Number(url.port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("Worker address contains an invalid port.");
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function createAuthenticationCode(): string {
	let compact = "";
	for (let index = 0; index < AUTHENTICATION_CODE_LENGTH; index += 1) {
		compact += AUTHENTICATION_ALPHABET[randomInt(AUTHENTICATION_ALPHABET.length)];
	}
	return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12)}`;
}
