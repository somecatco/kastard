import {
	type IncomingMessage,
	request as requestHttp,
	type ServerResponse,
} from "node:http";
import { request as requestHttps } from "node:https";
import WebSocket, { type RawData } from "ws";

const MAX_UPSTREAM_JSON_BYTES = 256 * 1024 * 1024;
const UPSTREAM_JOBS_PAGE_SIZE = 1_000;

type UpstreamResponse = { statusCode: number; body: Buffer };

export class LocalComfyUiTransport {
	constructor(
		private readonly getUpstreamUrl: () => string | null,
		private readonly getGatewayUrl: () => string | null,
	) {}

	isAvailable(): boolean {
		return this.getUpstreamUrl() !== null;
	}

	async readJson(
		request: IncomingMessage,
		prepareUrl?: (url: URL) => void,
	): Promise<unknown | null> {
		const result = await this.request(request, { prepareUrl });
		if (result === null || result.statusCode >= 400) return null;
		try {
			return JSON.parse(result.body.toString("utf8"));
		} catch {
			return null;
		}
	}

	async readJobs(request: IncomingMessage): Promise<unknown | null> {
		if (!this.isAvailable()) return null;
		const jobs: unknown[] = [];
		let offset = 0;
		while (true) {
			const page = await this.readJson(request, (url) => {
				url.searchParams.set("offset", String(offset));
				url.searchParams.set("limit", String(UPSTREAM_JOBS_PAGE_SIZE));
			});
			if (
				!isRecord(page) ||
				!Array.isArray(page.jobs) ||
				!isRecord(page.pagination) ||
				typeof page.pagination.has_more !== "boolean"
			) {
				return null;
			}
			const total = page.pagination.total;
			if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
				return null;
			}
			jobs.push(...page.jobs);
			if (!page.pagination.has_more) return { jobs };
			if (page.jobs.length === 0 || offset + page.jobs.length >= total) return null;
			offset += page.jobs.length;
		}
	}

	request(
		request: IncomingMessage,
		options: {
			body?: Buffer;
			prepareUrl?: ((url: URL) => void) | undefined;
		} = {},
	): Promise<UpstreamResponse | null> {
		const upstreamUrl = this.getUpstreamUrl();
		if (upstreamUrl === null) return Promise.resolve(null);
		const upstream = new URL(request.url ?? "/", upstreamUrl);
		options.prepareUrl?.(upstream);
		const headers = upstreamHeaders(request, upstreamUrl);
		if (options.body !== undefined) {
			delete headers["transfer-encoding"];
			headers["content-length"] = String(options.body.byteLength);
		}
		const send = upstream.protocol === "https:" ? requestHttps : requestHttp;
		return new Promise((resolve) => {
			let settled = false;
			const finish = (result: UpstreamResponse | null): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const proxy = send(
				upstream,
				{ method: request.method, headers },
				(upstreamResponse) => {
					const chunks: Buffer[] = [];
					let size = 0;
					upstreamResponse.on("data", (chunk: Buffer) => {
						size += chunk.byteLength;
						if (size > MAX_UPSTREAM_JSON_BYTES) {
							upstreamResponse.destroy();
							finish(null);
							return;
						}
						chunks.push(chunk);
					});
					upstreamResponse.once("end", () => {
						finish({
							statusCode: upstreamResponse.statusCode ?? 502,
							body: Buffer.concat(chunks),
						});
					});
					upstreamResponse.once("error", () => finish(null));
				},
			);
			proxy.once("error", () => finish(null));
			proxy.end(options.body);
		});
	}

	proxyHttp(request: IncomingMessage, response: ServerResponse): void {
		const upstreamUrl = this.getUpstreamUrl();
		if (upstreamUrl === null) {
			writeJson(response, 503, { error: "Local ComfyUI is not ready." });
			return;
		}
		const upstream = new URL(request.url ?? "/", upstreamUrl);
		const send = upstream.protocol === "https:" ? requestHttps : requestHttp;
		const proxy = send(
			upstream,
			{ method: request.method, headers: upstreamHeaders(request, upstreamUrl) },
			(upstreamResponse) => {
				const responseHeaders = { ...upstreamResponse.headers };
				const gatewayUrl = this.getGatewayUrl();
				if (typeof responseHeaders.location === "string" && gatewayUrl !== null) {
					responseHeaders.location = responseHeaders.location.replace(
						upstreamUrl,
						gatewayUrl,
					);
				}
				response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
				upstreamResponse.pipe(response);
			},
		);
		proxy.once("error", () => {
			if (!response.headersSent)
				writeJson(response, 502, { error: "Local ComfyUI failed." });
			else response.destroy();
		});
		request.pipe(proxy);
	}

	proxyWebSocket(
		client: WebSocket,
		request: IncomingMessage,
		transformText: (message: string) => string,
	): void {
		const upstreamUrl = this.getUpstreamUrl();
		if (upstreamUrl === null) {
			client.close(1013, "Local ComfyUI is not ready.");
			return;
		}
		const upstream = new URL(request.url ?? "/ws", upstreamUrl);
		upstream.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";
		const upstreamSocket = new WebSocket(upstream, {
			headers: { Origin: new URL(upstreamUrl).origin },
		});
		const pending: Array<{ data: RawData; binary: boolean }> = [];

		client.on("message", (data, binary) => {
			if (upstreamSocket.readyState === WebSocket.OPEN) {
				upstreamSocket.send(data, { binary });
			} else {
				pending.push({ data, binary });
			}
		});
		upstreamSocket.on("open", () => {
			for (const message of pending) {
				upstreamSocket.send(message.data, { binary: message.binary });
			}
			pending.length = 0;
		});
		upstreamSocket.on("message", (data, binary) => {
			if (client.readyState !== WebSocket.OPEN) return;
			client.send(binary ? data : transformText(data.toString()), { binary });
		});
		client.once("close", () => upstreamSocket.close());
		upstreamSocket.once("close", () => client.close());
		client.once("error", () => upstreamSocket.close());
		upstreamSocket.once("error", () => client.close(1011, "Local ComfyUI failed."));
	}
}

function upstreamHeaders(request: IncomingMessage, upstreamUrl: string) {
	const headers = { ...request.headers, host: new URL(upstreamUrl).host };
	if (headers.origin !== undefined) headers.origin = new URL(upstreamUrl).origin;
	return headers;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
