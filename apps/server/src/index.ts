import { join } from "node:path";
import { createServerApp } from "./app";
import {
	BackendProvisioner,
	BackendProvisionerController,
	readWorkerRuntime,
} from "./backend-provisioner";
import { ComfyRuntime, ComfyRuntimeController } from "./comfy-runtime";
import {
	CustomNodeProvisioner,
	CustomNodeProvisionerController,
} from "./custom-node-provisioner";
import { ModelProvisioner, ModelProvisionerController } from "./model-provisioner";
import { ServerLogStore } from "./server-log";
import { SystemStatusMonitor } from "./system-status";
import {
	isWorkerSessionAuthorized,
	WorkerSessionGateway,
	workerPublicAddress,
} from "./worker-session-gateway";
import { shutdownWorker } from "./worker-shutdown";
import { WorkflowEventHub } from "./workflow-events";
import { WorkflowJobExecutor } from "./workflow-job";

const logs = new ServerLogStore();
const backendProvisioner = new BackendProvisionerController();
const customNodeProvisioner = new CustomNodeProvisionerController();
const modelProvisioner = new ModelProvisionerController();
const comfyRuntime = new ComfyRuntimeController();
const systemStatus = new SystemStatusMonitor({
	diskPath: process.env.KASTARD_COMFYUI_ROOT ?? process.cwd(),
});
systemStatus.start();
let activeComfyRuntime: ComfyRuntime | null = null;
let activeRootDirectory: string | null = null;
const workflowEvents = new WorkflowEventHub();
const workflowJobs = new WorkflowJobExecutor({
	getRootDirectory: () => activeRootDirectory,
	getRuntimeUrl: () => activeComfyRuntime?.getInternalUrl() ?? null,
	getRuntimeGeneration: () => activeComfyRuntime?.getGeneration() ?? null,
	logs,
	events: workflowEvents,
});
let sessionCapability: string | null = null;
const app = createServerApp(
	logs,
	backendProvisioner,
	customNodeProvisioner,
	modelProvisioner,
	comfyRuntime,
	systemStatus,
	workflowJobs,
);
const port = parsePort(process.env.PORT);
const publicAddress = workerPublicAddress(process.env);
type WorkflowSocketData = {
	jobId: string;
	unsubscribe?: () => void;
};
const server = Bun.serve<WorkflowSocketData>({
	hostname: "127.0.0.1",
	port,
	fetch(request, server) {
		const url = new URL(request.url);
		if (
			url.pathname !== "/health" &&
			!isWorkerSessionAuthorized(
				request.headers.get("Authorization"),
				sessionCapability,
			)
		) {
			return Response.json({ error: "Unauthorized Worker session." }, { status: 401 });
		}
		const match =
			request.method === "GET"
				? url.pathname.match(/^\/workflow-jobs\/([^/]+)\/events$/)
				: null;
		if (match === null) return app.fetch(request);
		const jobId = match[1];
		if (jobId === undefined) {
			return Response.json({ error: "Invalid workflow job ID." }, { status: 400 });
		}
		try {
			workflowJobs.validateEventSubscription(jobId);
		} catch {
			return Response.json({ error: "Invalid workflow job ID." }, { status: 400 });
		}
		if (server.upgrade(request, { data: { jobId } })) return;
		return Response.json(
			{ error: "A WebSocket upgrade is required." },
			{ status: 426 },
		);
	},
	websocket: {
		open(socket) {
			socket.data.unsubscribe = workflowJobs.subscribeEvents(socket.data.jobId, {
				sendText: (message) => socket.send(message),
				sendBinary: (message) => socket.send(message),
			});
		},
		message() {},
		close(socket) {
			socket.data.unsubscribe?.();
		},
	},
});
const internalPort = server.port;
if (internalPort === undefined) {
	throw new Error("Kastard Worker API did not bind to a TCP port.");
}
const sessionGateway = new WorkerSessionGateway({
	listenHost: process.env.KASTARD_SESSION_HOST ?? "0.0.0.0",
	listenPort: parseSessionPort(process.env.KASTARD_SESSION_PORT),
	targetPort: internalPort,
	publicAddress,
	onSessionCapabilityChange: (capability) => {
		sessionCapability = capability;
	},
});

console.info(
	`[internal] Worker API listening on http://${server.hostname}:${server.port}`,
);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await sessionGateway.start();
void initializeBackendProvisioner();

async function initializeBackendProvisioner(): Promise<void> {
	try {
		const rootDirectory = requireEnvironment("KASTARD_COMFYUI_ROOT");
		const runtimePython =
			process.env.KASTARD_RUNTIME_PYTHON ?? "/opt/kastard/runtime/bin/python";
		const runtimeManifest =
			process.env.KASTARD_RUNTIME_MANIFEST ??
			join(import.meta.dir, "../../../vendor/comfyui-worker-runtime-cu130.json");
		let backend: BackendProvisioner | null = null;
		backend = await BackendProvisioner.create({
			rootDirectory,
			runtime: await readWorkerRuntime(runtimeManifest),
			logs,
			onReady: () =>
				backend === null
					? undefined
					: initializeCustomNodeProvisioner(rootDirectory, runtimePython, backend),
			onReplace: () => activeComfyRuntime?.stop(),
			isBusy: () => workflowJobs.hasActiveJob(),
		});
		activeRootDirectory = rootDirectory;
		await workflowJobs.initialize();
		backendProvisioner.attach(backend);
		activeComfyRuntime = new ComfyRuntime({
			rootDirectory,
			runtimePython,
			backend,
			logs,
			isBusy: () => workflowJobs.hasActiveJob(),
		});
		comfyRuntime.attach(activeComfyRuntime);
		logs.write("info", "Backend provisioning is available.");
		await initializeWorkerProvisioners(rootDirectory, runtimePython, backend);
	} catch (error) {
		activeRootDirectory = null;
		const message = errorMessage(error);
		backendProvisioner.fail(message);
		customNodeProvisioner.fail(message);
		modelProvisioner.fail(message);
		comfyRuntime.fail(message);
		logs.write("error", `Backend provisioning is unavailable: ${message}`);
	}
}

function shutdown(): void {
	systemStatus.stop();
	const runtime = activeComfyRuntime;
	activeComfyRuntime = null;
	activeRootDirectory = null;
	void shutdownWorker({
		runtime,
		customNodes: customNodeProvisioner,
		models: modelProvisioner,
		stopServer: async () => {
			server.stop(true);
			await sessionGateway.stop();
		},
		exit: () => process.exit(0),
	});
}

async function initializeWorkerProvisioners(
	rootDirectory: string,
	runtimePython: string,
	backend: BackendProvisioner,
): Promise<void> {
	await Promise.all([
		initializeCustomNodeProvisioner(rootDirectory, runtimePython, backend),
		initializeModelProvisioner(rootDirectory, runtimePython),
	]);
}

async function initializeCustomNodeProvisioner(
	rootDirectory: string,
	runtimePython: string,
	backend: BackendProvisioner,
): Promise<void> {
	try {
		customNodeProvisioner.attach(
			await CustomNodeProvisioner.create({
				rootDirectory,
				runtimePython,
				backend,
				logs,
			}),
		);
	} catch (error) {
		const message = errorMessage(error);
		customNodeProvisioner.fail(message);
		logs.write("error", `Custom node synchronization is unavailable: ${message}`);
	}
}

async function initializeModelProvisioner(
	rootDirectory: string,
	runtimePython: string,
): Promise<void> {
	try {
		modelProvisioner.attach(
			await ModelProvisioner.create({
				rootDirectory,
				runtimePython,
				logs,
			}),
		);
	} catch (error) {
		const message = errorMessage(error);
		modelProvisioner.fail(message);
		logs.write("error", `Model synchronization is unavailable: ${message}`);
	}
}

function parsePort(value: string | undefined): number {
	if (value === undefined) return 5278;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid PORT: ${value}`);
	}
	return port;
}

function parseSessionPort(value: string | undefined): number {
	if (value === undefined) return 22;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid KASTARD_SESSION_PORT: ${value}`);
	}
	return port;
}

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new Error(`${name} must be configured.`);
	}
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
