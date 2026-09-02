import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {
		build: { externalizeDeps: { exclude: ["@kastard/common"] } },
		define: {
			__KASTARD_PRODUCT_VERSION__: JSON.stringify(
				process.env.KASTARD_PRODUCT_VERSION ?? "",
			),
			__KASTARD_SOURCE_REVISION__: JSON.stringify(
				process.env.KASTARD_SOURCE_REVISION ?? "",
			),
		},
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
