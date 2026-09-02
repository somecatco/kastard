import { describe, expect, it } from "vitest";
import type {
	ComfyVersionState,
	DesktopAppInfo,
	WorkerSessionState,
} from "../../../shared/api";
import { formatDebugInfo } from "./debug-info";

const APP_INFO: DesktopAppInfo = {
	version: "0.1.0",
	buildNumber: "12",
	channel: "beta",
	environment: {
		os: "darwin",
		osVersion: "25.0.0",
		arch: "arm64",
		electronVersion: "43.4.0",
		chromeVersion: "144.0.7559.220",
		nodeVersion: "24.13.0",
	},
};

const COMFY_VERSIONS: ComfyVersionState = {
	selection: { frontend: null, backend: "0.34.0", manager: null },
	bundled: { frontend: "v1.52.1", backend: "0.33.1", manager: "4.2.2" },
	recommendedFrontend: "v1.51.0",
	recommendedManager: "4.3.0",
	install: { status: "idle" },
};

const WORKER_SESSION: WorkerSessionState = {
	connection: {
		status: "connected",
		provider: "other",
		serverUrl: "https://user:secret@worker.example.com:8443/api?token=hidden#details",
		connectedAt: 1_787_542_000_000,
		worker: {
			version: "0.1.0",
			buildNumber: "15",
			channel: "production",
		},
	},
	systemMetrics: { status: "loading" },
	backend: {
		status: "ready",
		editorComfyVersion: "0.34.0",
		version: "0.34.0",
		runtime: {
			cudaVersion: "12.8",
			pythonVersion: "3.12.13",
			torchVersion: "2.11.0+cu128",
			torchvisionVersion: "0.26.0+cu128",
			torchaudioVersion: "2.11.0+cu128",
			uvVersion: "0.12.4",
		},
	},
	comfy: { status: "ready" },
	customNodes: { status: "ready", nodes: [], unsupportedNodes: [] },
	models: { status: "synced", models: [] },
	verification: null,
	setup: { status: "idle" },
	workflow: null,
};

describe("formatDebugInfo", () => {
	it("formats an Editor and connected Worker snapshot without its endpoint", () => {
		const report = formatDebugInfo({
			appInfo: { ok: true, data: APP_INFO },
			comfyVersions: { ok: true, data: COMFY_VERSIONS },
			workerSession: { ok: true, data: WORKER_SESSION },
		});

		expect(report).toBe(
			[
				"Application",
				"App Version: 0.1.0",
				"App Build: 12",
				"Channel: Beta",
				"Platform: macOS 25.0.0 · arm64",
				"Runtime: Electron 43.4.0 · Chrome 144.0.7559.220 · Node 24.13.0",
				"",
				"Editor ComfyUI",
				"Frontend: v1.52.1 (bundled)",
				"Backend: 0.34.0 (selected)",
				"Backend Recommended Frontend: v1.51.0",
				"",
				"Worker",
				"Connection: connected",
				"Version: 0.1.0",
				"Build: 15",
				"Channel: Production",
				"Backend: ready",
				"Expected Backend Version: 0.34.0",
				"Backend Version: 0.34.0",
				"ComfyUI: ready",
				"System Metrics: loading",
				"Custom Nodes: ready",
				"Models: synced",
				"Setup: idle",
				"Verification: not-run",
				"Compute: CUDA 12.8",
				"Python: 3.12.13",
				"PyTorch: 2.11.0+cu128",
				"Torchvision: 0.26.0+cu128",
				"Torchaudio: 2.11.0+cu128",
				"uv: 0.12.4",
			].join("\n"),
		);
		expect(report).not.toContain("worker.example.com");
		expect(report).not.toContain("secret");
		expect(report).not.toContain("token");
		expect(report).not.toContain("Generated:");
	});

	it("keeps a useful report when every live source is unavailable", () => {
		expect(
			formatDebugInfo({
				appInfo: { ok: false },
				comfyVersions: { ok: false },
				workerSession: { ok: false },
			}),
		).toBe(
			[
				"Application: unavailable",
				"",
				"Editor ComfyUI: unavailable",
				"",
				"Worker: unavailable",
			].join("\n"),
		);
	});

	it("reports a CPU Worker without inventing a CUDA version", () => {
		const report = formatDebugInfo({
			appInfo: { ok: true, data: APP_INFO },
			comfyVersions: { ok: true, data: COMFY_VERSIONS },
			workerSession: {
				ok: true,
				data: {
					...WORKER_SESSION,
					backend: {
						status: "ready",
						editorComfyVersion: "0.34.0",
						version: "0.34.0",
						runtime: {
							computeBackend: "cpu",
							cudaVersion: null,
							pythonVersion: "3.13.12",
							torchVersion: "2.13.0+cpu",
							torchvisionVersion: "0.28.0+cpu",
							torchaudioVersion: "2.11.0+cpu",
							uvVersion: "0.12.4",
						},
					},
				},
			},
		});

		expect(report).toContain("Compute: CPU");
		expect(report).not.toContain("CUDA");
	});

	it("reports a disconnected Worker without inventing runtime details", () => {
		const report = formatDebugInfo({
			appInfo: { ok: true, data: APP_INFO },
			comfyVersions: { ok: true, data: COMFY_VERSIONS },
			workerSession: {
				ok: true,
				data: {
					connection: {
						status: "disconnected",
						recentProvider: "other",
						recentServerUrl: "https://worker.example.com/path?credential=hidden",
					},
					systemMetrics: { status: "disconnected" },
					backend: { status: "disconnected", editorComfyVersion: "0.34.0" },
					comfy: { status: "disconnected" },
					customNodes: { status: "disconnected" },
					models: { status: "disconnected" },
					verification: null,
					setup: { status: "idle" },
				},
			},
		});

		expect(report).toContain("Connection: disconnected");
		expect(report).not.toContain("worker.example.com");
		expect(report).not.toContain("credential");
		expect(report).not.toContain("CUDA:");
	});
});
