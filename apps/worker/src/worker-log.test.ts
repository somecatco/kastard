import { describe, expect, test } from "bun:test";
import { WorkerLogStore } from "./worker-log";

describe("WorkerLogStore", () => {
	test("returns only logs written after a cursor in event order", () => {
		let now = 0;
		const logs = new WorkerLogStore({
			instanceId: "worker-one",
			now: () => new Date(now++ * 1_000),
		});
		logs.write("info", "Before connection.");
		const cursor = logs.getCursor();

		logs.write("info", "Sync started.");
		logs.write("warning", "Retrying download.");

		expect(logs.readAfter(cursor)).toEqual({
			logs: [
				{
					id: "worker-one:2",
					timestamp: "1970-01-01T00:00:01.000Z",
					level: "info",
					message: "Sync started.",
				},
				{
					id: "worker-one:3",
					timestamp: "1970-01-01T00:00:02.000Z",
					level: "warning",
					message: "Retrying download.",
				},
			],
			cursor: "worker-one:3",
			truncated: false,
		});
	});

	test("reports when the requested history is no longer retained", () => {
		const logs = new WorkerLogStore({ maxEntries: 2, instanceId: "worker-one" });
		const cursor = logs.getCursor();
		logs.write("info", "One");
		logs.write("info", "Two");
		logs.write("info", "Three");

		const snapshot = logs.readAfter(cursor);

		expect(snapshot.logs.map((entry) => entry.message)).toEqual(["Two", "Three"]);
		expect(snapshot.truncated).toBe(true);
	});

	test("treats logs from a restarted Worker as newer than the old cursor", () => {
		const logs = new WorkerLogStore({ instanceId: "worker-two" });
		logs.write("info", "Worker restarted.");

		const snapshot = logs.readAfter("worker-one:42");

		expect(snapshot.logs.map((entry) => entry.message)).toEqual(["Worker restarted."]);
		expect(snapshot.truncated).toBe(false);
	});
});
