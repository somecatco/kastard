import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": resolve("src/renderer/src"),
		},
	},
	test: {
		environment: "happy-dom",
		setupFiles: ["./src/renderer/src/test-setup.ts"],
		include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
		coverage: {
			reporter: ["text", "html"],
		},
	},
});
