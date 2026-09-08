// @vitest-environment node

import { expect, test, vi } from "vitest";
import { runCommand } from "./process";

test.skipIf(process.platform === "win32")(
	"settles cancellation when the terminated process group cannot be inspected",
	async () => {
		const controller = new AbortController();
		let ready = false;
		let failure: unknown;
		const command = runCommand(
			process.execPath,
			["-e", "console.log('ready'); setInterval(() => {}, 1000);"],
			{
				cwd: process.cwd(),
				env: process.env,
				onOutput: () => {
					ready = true;
				},
				signal: controller.signal,
				terminationTimeoutMs: 1,
			},
		).catch((error) => {
			failure = error;
		});
		await vi.waitFor(() => expect(ready).toBe(true));
		const kill = process.kill.bind(process);
		const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid < 0 && signal === 0)
				throw Object.assign(new Error("Access denied."), { code: "EPERM" });
			return kill(pid, signal);
		});
		try {
			controller.abort(new Error("Command canceled."));
			await vi.waitFor(
				() => expect(failure).toMatchObject({ message: "Command canceled." }),
				{ timeout: 3_000 },
			);
		} finally {
			probe.mockRestore();
			controller.abort();
			await command;
		}
	},
);
