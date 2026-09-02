import type {
	ComfyVersionState,
	DesktopAppInfo,
	ReleaseChannel,
	WorkerRuntime,
	WorkerSessionState,
} from "../../../shared/api";
import { workerComputeLabel } from "./worker-runtime";

type DebugInfoSource<T> = { ok: true; data: T } | { ok: false };

type DebugInfoSnapshot = {
	appInfo: DebugInfoSource<DesktopAppInfo>;
	comfyVersions: DebugInfoSource<ComfyVersionState>;
	workerSession: DebugInfoSource<WorkerSessionState>;
};

const OS_LABELS: Record<string, string> = {
	darwin: "macOS",
	linux: "Linux",
	win32: "Windows",
};

const RELEASE_CHANNEL_LABELS: Record<ReleaseChannel, string> = {
	development: "Development",
	beta: "Beta",
	production: "Production",
};

function block(title: string, rows: [label: string, value: string][]): string {
	return [title, ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
}

export function desktopPlatformLabel(
	environment: DesktopAppInfo["environment"],
): string {
	return `${OS_LABELS[environment.os] ?? environment.os} ${environment.osVersion} · ${environment.arch}`;
}

export function desktopRuntimeLabel(
	environment: DesktopAppInfo["environment"],
): string {
	return `Electron ${environment.electronVersion} · Chrome ${environment.chromeVersion} · Node ${environment.nodeVersion}`;
}

export function releaseChannelLabel(channel: ReleaseChannel): string {
	return RELEASE_CHANNEL_LABELS[channel];
}

function editorBlock(source: DebugInfoSource<ComfyVersionState>): string {
	if (!source.ok) return "Editor ComfyUI: unavailable";
	const { selection, bundled, recommendedFrontend } = source.data;
	const rows: [string, string][] = [
		["Frontend", selectedVersionLabel(selection.frontend, bundled.frontend)],
		["Backend", selectedVersionLabel(selection.backend, bundled.backend)],
	];
	if (recommendedFrontend !== null) {
		rows.push(["Backend Recommended Frontend", recommendedFrontend]);
	}
	return block("Editor ComfyUI", rows);
}

function selectedVersionLabel(selected: string | null, bundled: string): string {
	return selected === null ? `${bundled} (bundled)` : `${selected} (selected)`;
}

function workerBlock(source: DebugInfoSource<WorkerSessionState>): string {
	if (!source.ok) return "Worker: unavailable";
	const {
		connection,
		backend,
		comfy,
		customNodes,
		models,
		verification,
		setup,
		workflow,
	} = source.data;
	const rows: [string, string][] = [["Connection", connection.status]];
	if (connection.status === "connected") {
		rows.push(
			["Version", connection.worker?.version ?? "unavailable"],
			["Build", connection.worker?.buildNumber ?? "unavailable"],
			[
				"Channel",
				connection.worker === undefined
					? "unavailable"
					: releaseChannelLabel(connection.worker.channel),
			],
		);
	}
	rows.push(
		["Backend", backend.status],
		["Expected Backend Version", backend.editorComfyVersion],
	);
	if ("version" in backend) rows.push(["Backend Version", backend.version]);
	if ("targetVersion" in backend) {
		rows.push(["Backend Target Version", backend.targetVersion]);
	}
	rows.push(
		["ComfyUI", comfy.status],
		["System Metrics", source.data.systemMetrics.status],
		["Custom Nodes", customNodes.status],
		["Models", models.status],
		["Setup", setup.status],
		["Verification", verification?.status ?? "not-run"],
	);
	if (workflow !== null && workflow !== undefined) {
		rows.push(
			["Workflow Phase", workflow.phase],
			["Workflow Cancellation", workflow.cancellation],
			["Workflow Last Status", workflow.lastConfirmedStatus ?? "unconfirmed"],
		);
	}
	if ("runtime" in backend) rows.push(...workerRuntimeRows(backend.runtime));
	return block("Worker", rows);
}

function workerRuntimeRows(runtime: WorkerRuntime): [label: string, value: string][] {
	return [
		["Compute", workerComputeLabel(runtime)],
		["Python", runtime.pythonVersion],
		["PyTorch", runtime.torchVersion],
		["Torchvision", runtime.torchvisionVersion],
		["Torchaudio", runtime.torchaudioVersion],
		["uv", runtime.uvVersion],
	];
}

export function formatDebugInfo({
	appInfo,
	comfyVersions,
	workerSession,
}: DebugInfoSnapshot): string {
	const application = appInfo.ok
		? block("Application", [
				["App Version", appInfo.data.version],
				["App Build", appInfo.data.buildNumber],
				["Channel", releaseChannelLabel(appInfo.data.channel)],
				["Platform", desktopPlatformLabel(appInfo.data.environment)],
				["Runtime", desktopRuntimeLabel(appInfo.data.environment)],
			])
		: "Application: unavailable";
	return [application, editorBlock(comfyVersions), workerBlock(workerSession)].join(
		"\n\n",
	);
}

async function capture<T>(read: () => Promise<T>): Promise<DebugInfoSource<T>> {
	try {
		return { ok: true, data: await read() };
	} catch {
		return { ok: false };
	}
}

export async function collectDebugInfo(): Promise<string> {
	const [appInfo, comfyVersionResult, workerSession] = await Promise.all([
		capture(() => window.kastard.appInfo.get()),
		capture(() => window.kastard.comfyVersions.getState()),
		capture(() =>
			window.kastard.workerSession.getSnapshot().then((snapshot) => snapshot.state),
		),
	]);
	const comfyVersions =
		comfyVersionResult.ok && comfyVersionResult.data.ok
			? { ok: true as const, data: comfyVersionResult.data.state }
			: { ok: false as const };
	return formatDebugInfo({
		appInfo,
		comfyVersions,
		workerSession,
	});
}
