import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type {
	ComfyRuntimeState,
	ConnectionState,
	KastardApi,
	WorkerBackendState,
	WorkerComfyState,
	WorkerCustomNodeSyncState,
	WorkerModelSyncState,
	WorkerSessionState,
	WorkerSetupState,
} from "../../shared/api";
import {
	connectedState,
	createDesktopApiMock,
	type DesktopApiMock,
	defaultComfyVersionState,
} from "./desktop-api-mock";

export { connectedState };
export const comfyVersionState = defaultComfyVersionState;

let desktopApiMock: DesktopApiMock;

export function emitWorkerSession(patch: Partial<WorkerSessionState>): void {
	desktopApiMock.emitWorkerSession(patch);
}

export function emitConnection(state: ConnectionState): void {
	desktopApiMock.emitConnection(state);
}

export function emitWorkerBackend(state: WorkerBackendState): void {
	desktopApiMock.emitWorkerSession({ backend: state });
}

export function emitWorkerComfy(state: WorkerComfyState): void {
	desktopApiMock.emitWorkerSession({ comfy: state });
}

export function emitWorkerCustomNodes(state: WorkerCustomNodeSyncState): void {
	desktopApiMock.emitWorkerSession({ customNodes: state });
}

export function emitWorkerModels(state: WorkerModelSyncState): void {
	desktopApiMock.emitWorkerSession({ models: state });
}

export function emitWorkerSetup(state: WorkerSetupState): void {
	desktopApiMock.emitWorkerSetup(state);
}

export function emitComfyRuntime(state: ComfyRuntimeState): void {
	desktopApiMock.emitComfyRuntime(state);
}

export function openSettingsFromMenu(): void {
	desktopApiMock.openSettingsFromMenu();
}

export function hasOpenSettingsListener(): boolean {
	return desktopApiMock.hasOpenSettingsListener();
}

export function getWorkerSessionState(): WorkerSessionState {
	return desktopApiMock.getWorkerSessionState();
}

export function setSyncAfterConnect(value: boolean): void {
	desktopApiMock.setSyncAfterConnect(value);
}

export async function openConnectionDetails(): Promise<HTMLElement> {
	fireEvent.click(screen.getByRole("button", { name: /^Connected/ }));
	return screen.findByRole("dialog", { name: "Connection details" });
}

export function openSettingsSection(
	name: "General" | "ComfyUI" | "Connection" | "Model Providers" | "Help" | "About",
): HTMLElement {
	const navigation = screen.getByRole("navigation", { name: "Settings sections" });
	const button = within(navigation).getByRole("button", { name });
	fireEvent.click(button);
	return button;
}

function addVitestSpies(api: KastardApi): void {
	for (const group of Object.values(api)) {
		for (const [name, implementation] of Object.entries(group)) {
			if (typeof implementation === "function") {
				(group as Record<string, unknown>)[name] = vi.fn(
					implementation as (...args: never[]) => unknown,
				);
			}
		}
	}
	vi.mocked(api.workerSession.retry).mockResolvedValue({ ok: true });
	vi.mocked(api.workerSession.startSetup).mockResolvedValue({ ok: true });
	vi.mocked(api.workerSession.cancelSetup).mockResolvedValue({ ok: true });
	vi.mocked(api.workerSession.restartComfy).mockResolvedValue({ ok: true });
	vi.mocked(api.connection.copyServerLogs).mockResolvedValue({ ok: true });
	vi.mocked(api.editorDirectories.open).mockResolvedValue({ ok: true });
}

afterEach(() => {
	cleanup();
	document.documentElement.classList.remove("dark");
	vi.useRealTimers();
});

beforeEach(() => {
	desktopApiMock = createDesktopApiMock();
	addVitestSpies(desktopApiMock.api);
	window.kastard = desktopApiMock.api;
});
