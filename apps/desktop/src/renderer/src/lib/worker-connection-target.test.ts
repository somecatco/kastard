import { expect, test } from "vitest";
import { buildWorkerAddress, connectionInputValue } from "./worker-connection-target";

test("preserves Worker host and port addresses", () => {
	expect(buildWorkerAddress("runpod", " 203.0.113.10:22001 ")).toBe(
		"203.0.113.10:22001",
	);
	expect(buildWorkerAddress("vastai", "203.0.113.10:34220")).toBe("203.0.113.10:34220");
	expect(buildWorkerAddress("other", " 84.1.117.74:41047 ")).toBe("84.1.117.74:41047");
});

test("restores the saved Worker address", () => {
	expect(connectionInputValue("runpod", "203.0.113.10:22001")).toBe(
		"203.0.113.10:22001",
	);
});
