import { describe, expect, test } from "bun:test";
import { ServerLogStore } from "./server-log";

describe("ServerLogStore", () => {
	test("returns only logs written after a cursor in event order", () => {
		let now = 0;
		const logs = new ServerLogStore({
			instanceId: "server-one",
			now: () => new Date(now++ * 1_000),
		});
		logs.write("info", "Before connection.");
		const cursor = logs.getCursor();

		logs.write("info", "Sync started.");
		logs.write("warning", "Retrying download.");

		expect(logs.readAfter(cursor)).toEqual({
			logs: [
				{
					id: "server-one:2",
					timestamp: "1970-01-01T00:00:01.000Z",
					level: "info",
					message: "Sync started.",
				},
				{
					id: "server-one:3",
					timestamp: "1970-01-01T00:00:02.000Z",
					level: "warning",
					message: "Retrying download.",
				},
			],
			cursor: "server-one:3",
			truncated: false,
		});
	});

	test("reports when the requested history is no longer retained", () => {
		const logs = new ServerLogStore({ maxEntries: 2, instanceId: "server-one" });
		const cursor = logs.getCursor();
		logs.write("info", "One");
		logs.write("info", "Two");
		logs.write("info", "Three");

		const snapshot = logs.readAfter(cursor);

		expect(snapshot.logs.map((entry) => entry.message)).toEqual(["Two", "Three"]);
		expect(snapshot.truncated).toBe(true);
	});

	test("treats logs from a restarted server as newer than the old cursor", () => {
		const logs = new ServerLogStore({ instanceId: "server-two" });
		logs.write("info", "Server restarted.");

		const snapshot = logs.readAfter("server-one:42");

		expect(snapshot.logs.map((entry) => entry.message)).toEqual(["Server restarted."]);
		expect(snapshot.truncated).toBe(false);
	});
});
