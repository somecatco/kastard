import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	timeout: 300_000,
	use: {
		trace: "retain-on-failure",
	},
});
