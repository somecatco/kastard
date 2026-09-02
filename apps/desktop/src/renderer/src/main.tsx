import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { applyTheme } from "./lib/theme";

applyTheme(window.kastard.theme.initial);

const root = document.getElementById("root");

if (root === null) {
	throw new Error("Kastard renderer root is missing.");
}

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
