import { useLayoutEffect } from "react";
import type {
	ConnectionState,
	WorkerLogsResult,
	WorkerSessionState,
} from "../../../shared/api";
import { createDesktopApiMock, type DesktopApiMock } from "../desktop-api-mock";
import { completeSyncScenario, type StoryWorkerScenario } from "./worker-scenarios";

let storyDesktopApiMock: DesktopApiMock;
let activeStoryId: string | undefined;

function installStoryDesktopApiMock(): void {
	storyDesktopApiMock = createDesktopApiMock();
	storyDesktopApiMock.api.workerSession.retry = async () => ({ ok: true });
	storyDesktopApiMock.api.connection.copyWorkerLogs = async () => ({ ok: true });
	(globalThis as typeof globalThis & { kastard: DesktopApiMock["api"] }).kastard =
		storyDesktopApiMock.api;
}

export function activateStoryDesktopApiMock(storyId: string): void {
	if (storyId === activeStoryId) return;
	activeStoryId = storyId;
	installStoryDesktopApiMock();
}

export function configureStoryWorker(
	connection: ConnectionState,
	scenario: StoryWorkerScenario = completeSyncScenario,
): void {
	const connected = connection.status === "connected";
	storyDesktopApiMock.setWorkerSessionState({
		connection,
		systemMetrics: { status: "disconnected" },
		backend: connected
			? scenario.backend
			: { status: "disconnected", editorComfyVersion: "0.34.0" },
		comfy: connected ? scenario.comfy : { status: "disconnected" },
		customNodes: connected ? scenario.nodes : { status: "disconnected" },
		models: connected ? scenario.models : { status: "disconnected" },
		verification:
			connected &&
			(scenario.setup.status === "succeeded" || scenario.setup.status === "failed")
				? (scenario.setup.verification ?? null)
				: null,
		setup: connected ? scenario.setup : { status: "idle" },
	} satisfies WorkerSessionState);
}

export function useConfigureStoryWorker(
	connection: ConnectionState,
	scenario: StoryWorkerScenario = completeSyncScenario,
): void {
	useLayoutEffect(
		() => configureStoryWorker(connection, scenario),
		[connection, scenario],
	);
}

export function configureStoryWorkerLogs(result: WorkerLogsResult): void {
	storyDesktopApiMock.setWorkerLogsResult(result);
}

installStoryDesktopApiMock();
