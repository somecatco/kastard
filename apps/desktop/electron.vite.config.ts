import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {
		build: { externalizeDeps: { exclude: ["@kastard/common"] } },
	},
	preload: {
		build: { externalizeDeps: { exclude: ["@kastard/common"] } },
	},
	renderer: {
		resolve: {
			alias: {
				"@": resolve("src/renderer/src"),
			},
		},
		plugins: [react(), tailwindcss()],
	},
});
