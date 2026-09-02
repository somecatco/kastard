import type { KastardApi } from "../../shared/api";

declare global {
	interface Window {
		kastard: KastardApi;
	}
}
