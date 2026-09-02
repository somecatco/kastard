import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { withComfyQueueStatus } from "./compat";
import { LocalComfyUiTransport } from "./local";
import type { WorkerWorkflowEvent, WorkerWorkflowLiveEvent } from "./worker-port";
import { ComfyGatewayWorkflow, type ComfyGatewayWorkflowOptions } from "./workflow";

type ComfyGatewayOptions = ComfyGatewayWorkflowOptions & {
	listenPort?: number;
	persistPort?: (port: number) => Promise<void>;
	getUpstreamUrl: () => string | null;
};

export class ComfyGateway {
	private server: Server | null = null;
	private webSockets: WebSocketServer | null = null;
	private url: string | null = null;
	private startPromise: Promise<string> | null = null;
	private readonly clientIds = new Map<WebSocket, string>();
	private readonly local: LocalComfyUiTransport;
	private readonly workflow: ComfyGatewayWorkflow;
	private listenPort: number;

	constructor(private readonly options: ComfyGatewayOptions) {
		this.listenPort = options.listenPort ?? 0;
		this.local = new LocalComfyUiTransport(options.getUpstreamUrl, () => this.url);
		this.workflow = new ComfyGatewayWorkflow(options, this.local, {
			send: (clientId, value) => this.send(clientId, value),
			sendBinary: (clientId, value) => this.sendBinary(clientId, value),
		});
	}

	getUrl(): string | null {
		return this.url;
	}

	start(): Promise<string> {
		if (this.url !== null) return Promise.resolve(this.url);
		this.startPromise ??= this.startListening().finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	sendStarted(jobId: string, clientId: string | null): void {
		this.workflow.sendStarted(jobId, clientId);
	}

	sendQueueStatus(queue = this.options.getQueue()): void {
		this.workflow.sendQueueStatus(queue);
	}

	sendLive(event: WorkerWorkflowLiveEvent): void {
		this.workflow.sendLive(event);
	}

	sendTerminal(event: WorkerWorkflowEvent): void {
		this.workflow.sendTerminal(event);
	}

	async stop(): Promise<void> {
		if (this.startPromise !== null) await this.startPromise.catch(() => undefined);
		for (const client of this.webSockets?.clients ?? []) client.close();
		this.clientIds.clear();
		this.workflow.reset();
		this.webSockets?.close();
		this.webSockets = null;
		const server = this.server;
		this.server = null;
		this.url = null;
		if (server === null) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private async startListening(): Promise<string> {
		const webSockets = new WebSocketServer({ noServer: true });
		webSockets.on("connection", (client, request) => {
			client.once("close", () => this.clientIds.delete(client));
			this.local.proxyWebSocket(client, request, (message) =>
				this.prepareLocalWebSocketMessage(client, message),
			);
		});
		const server = createServer((request, response) => {
			void this.handleRequest(request, response);
		});
		server.on("upgrade", (request, socket, head) => {
			if (!isAllowedGatewayRequest(request, this.url)) {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				return;
			}
			webSockets.handleUpgrade(request, socket, head, (client) => {
				webSockets.emit("connection", client, request);
			});
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(this.listenPort, "127.0.0.1", () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
		} catch (error) {
			webSockets.close();
			throw gatewayListenError(error, this.listenPort);
		}
		const address = server.address() as AddressInfo;
		try {
			await this.options.persistPort?.(address.port);
		} catch (error) {
			webSockets.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			throw error;
		}
		this.listenPort = address.port;
		this.server = server;
		this.webSockets = webSockets;
		this.url = `http://127.0.0.1:${address.port}/`;
		return this.url;
	}

	private async handleRequest(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		if (!isAllowedGatewayRequest(request, this.url)) {
			response.writeHead(403);
			response.end();
			return;
		}
		const url = new URL(request.url ?? "/", "http://gateway");
		if (await this.workflow.handle(request, response, url)) return;
		this.local.proxyHttp(request, response);
	}

	private prepareLocalWebSocketMessage(client: WebSocket, message: string): string {
		this.captureClientId(client, message);
		return withComfyQueueStatus(message, this.options.getQueue());
	}

	private captureClientId(client: WebSocket, message: string): void {
		try {
			const value: unknown = JSON.parse(message);
			if (
				isRecord(value) &&
				value.type === "status" &&
				isRecord(value.data) &&
				typeof value.data.sid === "string"
			) {
				this.clientIds.set(client, value.data.sid);
			}
		} catch {
			return;
		}
	}

	private send(clientId: string | null, value: unknown): void {
		const clients = [...(this.webSockets?.clients ?? [])].filter(
			(client) => client.readyState === WebSocket.OPEN,
		);
		const matching =
			clientId === null
				? clients
				: clients.filter((client) => this.clientIds.get(client) === clientId);
		const message = JSON.stringify(value);
		for (const client of matching) client.send(message);
	}

	private sendBinary(clientId: string | null, value: Uint8Array): void {
		const clients = [...(this.webSockets?.clients ?? [])].filter(
			(client) => client.readyState === WebSocket.OPEN,
		);
		const matching =
			clientId === null
				? clients
				: clients.filter((client) => this.clientIds.get(client) === clientId);
		for (const client of matching) client.send(value, { binary: true });
	}
}

function isAllowedGatewayRequest(
	request: IncomingMessage,
	gatewayUrl: string | null,
): boolean {
	if (gatewayUrl === null) return false;
	const expectedHost = new URL(gatewayUrl).host.toLowerCase();
	if (request.headers.host?.toLowerCase() !== expectedHost) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const { origin } = request.headers;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host.toLowerCase() === expectedHost;
	} catch {
		return false;
	}
}

function gatewayListenError(error: unknown, port: number): Error {
	if (isErrorCode(error, "EADDRINUSE") && port !== 0) {
		return new Error(`The saved ComfyUI Gateway port ${port} is already in use.`);
	}
	return new Error(
		`Could not start the ComfyUI Gateway. ${error instanceof Error ? error.message : String(error)}`,
	);
}

function isErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
