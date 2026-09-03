// @vitest-environment node

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { LocalComfyUiTransport } from "./local";

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

test("reads every Local ComfyUI Jobs page through rewritten upstream headers", async () => {
	const ids = ["job-one", "job-two", "job-three"];
	const requests: Array<{
		offset: number;
		limit: number;
		host: string;
		origin: string;
	}> = [];
	const upstream = await listen(
		createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://local-comfy");
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const jobs = ids.slice(offset, offset + 2).map((id) => ({
				id,
				status: "completed",
			}));
			requests.push({
				offset,
				limit: Number(url.searchParams.get("limit")),
				host: request.headers.host ?? "",
				origin: request.headers.origin ?? "",
			});
			response.setHeader("Content-Type", "application/json");
			response.end(
				JSON.stringify({
					jobs,
					pagination: {
						offset,
						limit: 2,
						total: ids.length,
						has_more: offset + jobs.length < ids.length,
					},
				}),
			);
		}),
	);
	const local = new LocalComfyUiTransport(
		() => upstream,
		() => null,
	);

	expect(await local.readJobs(gatewayRequest("/api/jobs?offset=9&limit=1"))).toEqual({
		jobs: ids.map((id) => ({ id, status: "completed" })),
	});
	expect(requests).toEqual([
		{
			offset: 0,
			limit: 1_000,
			host: new URL(upstream).host,
			origin: new URL(upstream).origin,
		},
		{
			offset: 2,
			limit: 1_000,
			host: new URL(upstream).host,
			origin: new URL(upstream).origin,
		},
	]);
});

function gatewayRequest(url: string): IncomingMessage {
	return Object.assign(Readable.from([]), {
		url,
		method: "GET",
		headers: { host: "127.0.0.1:1234", origin: "http://127.0.0.1:1234" },
	}) as unknown as IncomingMessage;
}

async function listen(server: Server): Promise<string> {
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}/`;
}
