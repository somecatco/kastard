import {
	isReleaseChannel,
	parseWorkerComfyMemoryCleanupRequest,
	type WorkerConnectionResponse,
	type WorkerConnectionStartResponse,
	type WorkerIdentity,
	type WorkflowJobRejection,
} from "@kastard/common";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import serverPackage from "../package.json" with { type: "json" };
import {
	type BackendProvisionerApi,
	BackendProvisionerUnavailableError,
	BackendProvisioningError,
} from "./backend-provisioner";
import {
	type ComfyRuntimeApi,
	ComfyRuntimeStartError,
	ComfyRuntimeUnavailableError,
} from "./comfy-runtime";
import {
	type CustomNodeProvisionerApi,
	CustomNodeProvisionerUnavailableError,
	CustomNodeSyncError,
} from "./custom-node-provisioner";
import {
	type ModelProvisionerApi,
	ModelProvisionerUnavailableError,
	ModelSyncError,
} from "./model-provisioner";
import { ServerLogStore } from "./server-log";
import { SyncVerificationError, verifySynchronization } from "./sync-verification";
import type { SystemStatusApi } from "./system-status";
import { type WorkflowJobApi, WorkflowJobError } from "./workflow-job";

const COMFY_RUNTIME_SYNC_CONFLICT =
	"Worker ComfyUI must finish starting or restarting before synchronization.";

export function readWorkerIdentity(
	environment: Record<string, string | undefined> = process.env,
): WorkerIdentity {
	const channel = environment.KASTARD_CHANNEL ?? "development";
	if (!isReleaseChannel(channel)) {
		throw new Error(`Invalid KASTARD_CHANNEL: ${channel}.`);
	}
	return {
		version: serverPackage.version,
		buildNumber: serverPackage.buildNumber,
		channel,
	};
}

export function createServerApp(
	serverLogs = new ServerLogStore(),
	backendProvisioner?: BackendProvisionerApi,
	customNodeProvisioner?: CustomNodeProvisionerApi,
	modelProvisioner?: ModelProvisionerApi,
	comfyRuntime?: ComfyRuntimeApi,
	systemStatus?: SystemStatusApi,
	workflowJobs?: WorkflowJobApi,
): Hono {
	const app = new Hono();
	const worker = readWorkerIdentity();
	let comfyRestartActive = false;

	app.use("*", secureHeaders());
	app.use("*", async (context, next) => {
		context.header("Cache-Control", "no-store");
		await next();
	});

	app.get("/health", (context) => context.json({ status: "ok" }));
	app.get("/connection", (context) =>
		context.json({ status: "connected", worker } satisfies WorkerConnectionResponse),
	);
	app.get("/system/status", (context) => {
		if (systemStatus === undefined) {
			return context.json(
				{ error: "System status monitoring is not configured." },
				503,
			);
		}
		return context.json(systemStatus.getState());
	});
	app.post("/connection", (context) => {
		const logCursor = serverLogs.getCursor();
		serverLogs.write("info", "Editor connected.");
		return context.json({
			status: "connected",
			logCursor,
			worker,
		} satisfies WorkerConnectionStartResponse);
	});
	app.get("/logs", (context) => {
		const cursor = context.req.query("after");
		if (cursor === undefined) {
			return context.json({ error: "A server log cursor is required." }, 400);
		}
		try {
			return context.json(serverLogs.readAfter(cursor));
		} catch {
			return context.json({ error: "Invalid server log cursor." }, 400);
		}
	});
	app.get("/comfyui", (context) => {
		if (backendProvisioner === undefined) {
			return context.json({ error: "Backend provisioning is not configured." }, 503);
		}
		return context.json(backendProvisioner.getState());
	});
	app.post("/comfyui/prepare", async (context) => {
		if (backendProvisioner === undefined) {
			return context.json({ error: "Backend provisioning is not configured." }, 503);
		}
		try {
			const target: unknown = await context.req.json();
			if (comfyRestartActive) {
				return context.json(
					{
						error:
							"Worker ComfyUI must finish restarting before preparing its backend.",
					},
					409,
				);
			}
			return context.json(backendProvisioner.prepare(target), 202);
		} catch (error) {
			if (error instanceof BackendProvisioningError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			if (error instanceof SyntaxError) {
				return context.json({ error: "Invalid JSON request body." }, 400);
			}
			throw error;
		}
	});
	app.get("/comfyui/runtime", (context) => {
		if (comfyRuntime === undefined) {
			return context.json({ error: "ComfyUI execution is not configured." }, 503);
		}
		return context.json(comfyRuntime.getState());
	});
	app.post("/comfyui/runtime", (context) => {
		if (comfyRuntime === undefined) {
			return context.json({ error: "ComfyUI execution is not configured." }, 503);
		}
		if (customNodeSynchronizationActive(customNodeProvisioner)) {
			return context.json(
				{
					error:
						"Worker custom node synchronization must finish before starting ComfyUI.",
				},
				409,
			);
		}
		if (modelRedownloadActive(modelProvisioner)) {
			return context.json(
				{ error: "Worker model redownload must finish before starting ComfyUI." },
				409,
			);
		}
		try {
			return context.json(comfyRuntime.start(), 202);
		} catch (error) {
			if (error instanceof ComfyRuntimeStartError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			throw error;
		}
	});
	app.post("/comfyui/runtime/restart", async (context) => {
		if (comfyRuntime === undefined) {
			return context.json({ error: "ComfyUI execution is not configured." }, 503);
		}
		if (comfyRestartActive) {
			return context.json({ error: "Worker ComfyUI is already restarting." }, 409);
		}
		if (workflowJobs?.hasActiveJob()) {
			return context.json(
				{ error: "Worker ComfyUI cannot restart while a workflow is running." },
				409,
			);
		}
		if (backendPreparationActive(backendProvisioner)) {
			return context.json(
				{ error: "Worker backend preparation must finish before restarting ComfyUI." },
				409,
			);
		}
		if (synchronizationActive(customNodeProvisioner, modelProvisioner)) {
			return context.json(
				{ error: "Worker synchronization must finish before restarting ComfyUI." },
				409,
			);
		}
		comfyRestartActive = true;
		try {
			return context.json(await comfyRuntime.restart(), 202);
		} catch (error) {
			if (error instanceof ComfyRuntimeStartError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			throw error;
		} finally {
			comfyRestartActive = false;
		}
	});
	app.post("/comfyui/runtime/free", async (context) => {
		if (comfyRuntime === undefined) {
			return context.json({ error: "ComfyUI execution is not configured." }, 503);
		}
		try {
			const request = parseWorkerComfyMemoryCleanupRequest(await context.req.json());
			if (request === null) {
				return context.json({ error: "Invalid ComfyUI memory cleanup request." }, 400);
			}
			await comfyRuntime.freeMemory(request);
			return context.json({});
		} catch (error) {
			if (error instanceof SyntaxError) {
				return context.json({ error: "Invalid JSON request body." }, 400);
			}
			throw error;
		}
	});
	app.put("/workflow-jobs/:jobId/inputs/:inputId", async (context) => {
		if (workflowJobs === undefined) {
			return context.json(
				{ error: "Worker workflow execution is not configured." },
				503,
			);
		}
		const size = Number(context.req.header("Content-Length"));
		const sha256 = context.req.header("X-Kastard-Input-SHA256") ?? "";
		if (!Number.isSafeInteger(size) || size < 0) {
			return context.json({ error: "Invalid workflow input size." }, 400);
		}
		try {
			await workflowJobs.uploadInput(
				context.req.param("jobId"),
				context.req.param("inputId"),
				context.req.raw.body,
				size,
				sha256,
			);
			return context.body(null, 204);
		} catch (error) {
			if (error instanceof WorkflowJobError) {
				return context.json(
					{ error: error.message, retryable: error.retryable },
					error.statusCode,
				);
			}
			throw error;
		}
	});
	app.delete("/workflow-jobs/:jobId/inputs", async (context) => {
		if (workflowJobs === undefined) {
			return context.json(
				{ error: "Worker workflow execution is not configured." },
				503,
			);
		}
		try {
			await workflowJobs.discardInputs(context.req.param("jobId"));
			return context.body(null, 204);
		} catch (error) {
			if (error instanceof WorkflowJobError) {
				return context.json(
					{ error: error.message, retryable: error.retryable },
					error.statusCode,
				);
			}
			throw error;
		}
	});
	app.put("/workflow-jobs/:jobId", async (context) => {
		if (workflowJobs === undefined) {
			return context.json(
				{
					accepted: false,
					error: "Worker workflow execution is not configured.",
					retryable: false,
				} satisfies WorkflowJobRejection,
				503,
			);
		}
		try {
			const request: unknown = await context.req.json();
			if (customNodeSynchronizationActive(customNodeProvisioner)) {
				return context.json(
					{
						accepted: false,
						error:
							"The Worker must finish synchronizing its custom nodes before starting a workflow.",
						retryable: true,
					} satisfies WorkflowJobRejection,
					409,
				);
			}
			if (modelRedownloadActive(modelProvisioner)) {
				return context.json(
					{
						accepted: false,
						error:
							"The Worker must finish redownloading its model before starting a workflow.",
						retryable: true,
					} satisfies WorkflowJobRejection,
					409,
				);
			}
			return context.json(
				await workflowJobs.submit(context.req.param("jobId"), request),
				202,
			);
		} catch (error) {
			if (error instanceof WorkflowJobError) {
				return context.json(
					{
						accepted: false,
						error: error.message,
						retryable: error.retryable,
					} satisfies WorkflowJobRejection,
					error.statusCode,
				);
			}
			if (error instanceof SyntaxError) {
				return context.json(
					{
						accepted: false,
						error: "Invalid JSON request body.",
						retryable: false,
					} satisfies WorkflowJobRejection,
					400,
				);
			}
			throw error;
		}
	});
	app.delete("/workflow-jobs/:jobId", async (context) => {
		if (workflowJobs === undefined) {
			return context.json(
				{ error: "Worker workflow execution is not configured." },
				503,
			);
		}
		try {
			return context.json(await workflowJobs.cancel(context.req.param("jobId")), 202);
		} catch (error) {
			if (error instanceof WorkflowJobError) {
				return context.json(
					{ error: error.message, retryable: error.retryable },
					error.statusCode,
				);
			}
			throw error;
		}
	});
	app.get("/workflow-jobs/:jobId", (context) => {
		if (workflowJobs === undefined) {
			return context.json(
				{ error: "Worker workflow execution is not configured." },
				503,
			);
		}
		const state = workflowJobs.get(context.req.param("jobId"));
		return state === null
			? context.json({ error: "Workflow job not found." }, 404)
			: context.json(state);
	});
	app.get("/workflow-jobs/:jobId/results", (context) => {
		if (workflowJobs === undefined) {
			return context.json(
				{ error: "Worker workflow execution is not configured." },
				503,
			);
		}
		const result = workflowJobs.getResults(context.req.param("jobId"));
		return result === null
			? context.json({ error: "Workflow result not found." }, 404)
			: context.json(result);
	});
	app.get("/workflow-jobs/:jobId/results/:fileId", (context) => {
		if (workflowJobs === undefined) {
			return context.json(
				{ error: "Worker workflow execution is not configured." },
				503,
			);
		}
		const result = workflowJobs.getResultFile(
			context.req.param("jobId"),
			context.req.param("fileId"),
		);
		if (result === null) {
			return context.json({ error: "Workflow result file not found." }, 404);
		}
		return new Response(Bun.file(result.path), {
			headers: {
				"Cache-Control": "no-store",
				"Content-Length": String(result.size),
				"Content-Type": result.contentType,
				"X-Kastard-Result-SHA256": result.sha256,
			},
		});
	});
	app.get("/sync", (context) => {
		if (customNodeProvisioner === undefined) {
			return context.json(
				{ error: "Custom node synchronization is not configured." },
				503,
			);
		}
		return context.json(customNodeProvisioner.getState());
	});
	app.post("/sync", async (context) => {
		if (customNodeProvisioner === undefined) {
			return context.json(
				{ error: "Custom node synchronization is not configured." },
				503,
			);
		}
		try {
			const request: unknown = await context.req.json();
			if (comfyBlocksSynchronization(comfyRuntime, comfyRestartActive)) {
				return context.json({ error: COMFY_RUNTIME_SYNC_CONFLICT }, 409);
			}
			return context.json(customNodeProvisioner.sync(request), 202);
		} catch (error) {
			if (error instanceof CustomNodeSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			if (error instanceof SyntaxError) {
				return context.json({ error: "Invalid JSON request body." }, 400);
			}
			throw error;
		}
	});
	app.post("/sync/reinstall", async (context) => {
		if (customNodeProvisioner === undefined) {
			return context.json(
				{ error: "Custom node synchronization is not configured." },
				503,
			);
		}
		try {
			const request: unknown = await context.req.json();
			if (comfyBlocksSynchronization(comfyRuntime, comfyRestartActive)) {
				return context.json({ error: COMFY_RUNTIME_SYNC_CONFLICT }, 409);
			}
			return context.json(customNodeProvisioner.reinstall(request), 202);
		} catch (error) {
			if (error instanceof CustomNodeSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			if (error instanceof SyntaxError) {
				return context.json({ error: "Invalid JSON request body." }, 400);
			}
			throw error;
		}
	});
	app.post("/sync/remove", async (context) => {
		if (customNodeProvisioner === undefined) {
			return context.json(
				{ error: "Custom node synchronization is not configured." },
				503,
			);
		}
		try {
			const request: unknown = await context.req.json();
			if (workflowJobs?.hasActiveJob()) {
				return context.json(
					{
						error: "Worker custom nodes cannot be removed while a workflow is running.",
					},
					409,
				);
			}
			if (comfyBlocksSynchronization(comfyRuntime, comfyRestartActive)) {
				return context.json({ error: COMFY_RUNTIME_SYNC_CONFLICT }, 409);
			}
			return context.json(customNodeProvisioner.remove(request), 202);
		} catch (error) {
			if (error instanceof CustomNodeSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			if (error instanceof SyntaxError) {
				return context.json({ error: "Invalid JSON request body." }, 400);
			}
			throw error;
		}
	});
	app.delete("/sync", (context) => {
		if (customNodeProvisioner === undefined) {
			return context.json(
				{ error: "Custom node synchronization is not configured." },
				503,
			);
		}
		try {
			return context.json(customNodeProvisioner.cancel(), 202);
		} catch (error) {
			if (error instanceof CustomNodeSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			throw error;
		}
	});
	app.delete("/sync/:operationId", (context) => {
		if (customNodeProvisioner === undefined) {
			return context.json(
				{ error: "Custom node synchronization is not configured." },
				503,
			);
		}
		try {
			return context.json(
				customNodeProvisioner.cancel(context.req.param("operationId")),
				202,
			);
		} catch (error) {
			if (error instanceof CustomNodeSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			throw error;
		}
	});
	app.post("/sync/verify", async (context) => {
		if (
			backendProvisioner === undefined ||
			customNodeProvisioner === undefined ||
			modelProvisioner === undefined
		) {
			return context.json(
				{ error: "Synchronization verification is not configured." },
				503,
			);
		}
		try {
			const request: unknown = await context.req.json();
			return context.json(
				await verifySynchronization(
					request,
					backendProvisioner,
					customNodeProvisioner,
					modelProvisioner,
				),
			);
		} catch (error) {
			if (error instanceof SyncVerificationError) {
				return context.json({ error: error.message }, 400);
			}
			if (error instanceof ModelSyncError || error instanceof CustomNodeSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			if (error instanceof SyntaxError) {
				return context.json({ error: "Invalid JSON request body." }, 400);
			}
			throw error;
		}
	});
	app.get("/models/sync", (context) => {
		if (modelProvisioner === undefined) {
			return context.json({ error: "Model synchronization is not configured." }, 503);
		}
		return context.json(modelProvisioner.getState());
	});
	app.post("/models/sync", async (context) => {
		if (modelProvisioner === undefined) {
			return context.json({ error: "Model synchronization is not configured." }, 503);
		}
		try {
			const request: unknown = await context.req.json();
			if (comfyBlocksModelSynchronization(comfyRuntime, comfyRestartActive)) {
				return context.json({ error: COMFY_RUNTIME_SYNC_CONFLICT }, 409);
			}
			return context.json(modelProvisioner.sync(request), 202);
		} catch (error) {
			if (error instanceof ModelSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			if (error instanceof SyntaxError) {
				return context.json({ error: "Invalid JSON request body." }, 400);
			}
			throw error;
		}
	});
	app.post("/models/redownload", async (context) => {
		if (modelProvisioner === undefined) {
			return context.json({ error: "Model synchronization is not configured." }, 503);
		}
		try {
			const request: unknown = await context.req.json();
			if (workflowJobs?.hasActiveJob()) {
				return context.json(
					{
						error: "Worker models cannot be redownloaded while a workflow is running.",
					},
					409,
				);
			}
			if (comfyBlocksSynchronization(comfyRuntime, comfyRestartActive)) {
				return context.json({ error: COMFY_RUNTIME_SYNC_CONFLICT }, 409);
			}
			return context.json(modelProvisioner.redownload(request), 202);
		} catch (error) {
			if (error instanceof ModelSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			if (error instanceof SyntaxError) {
				return context.json({ error: "Invalid JSON request body." }, 400);
			}
			throw error;
		}
	});
	app.delete("/models/sync", (context) => {
		if (modelProvisioner === undefined) {
			return context.json({ error: "Model synchronization is not configured." }, 503);
		}
		try {
			return context.json(modelProvisioner.cancel(), 202);
		} catch (error) {
			if (error instanceof ModelSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			throw error;
		}
	});
	app.delete("/models/sync/:operationId", (context) => {
		if (modelProvisioner === undefined) {
			return context.json({ error: "Model synchronization is not configured." }, 503);
		}
		try {
			return context.json(
				modelProvisioner.cancel(context.req.param("operationId")),
				202,
			);
		} catch (error) {
			if (error instanceof ModelSyncError) {
				return context.json({ error: error.message }, error.statusCode);
			}
			throw error;
		}
	});

	app.notFound((context) => context.json({ error: "Not found." }, 404));
	app.onError((error, context) => {
		if (error instanceof BackendProvisionerUnavailableError) {
			return context.json({ error: error.message, retryable: error.retryable }, 503);
		}
		if (error instanceof CustomNodeProvisionerUnavailableError) {
			return context.json({ error: error.message, retryable: error.retryable }, 503);
		}
		if (error instanceof ModelProvisionerUnavailableError) {
			return context.json({ error: error.message, retryable: error.retryable }, 503);
		}
		if (error instanceof ComfyRuntimeUnavailableError) {
			return context.json({ error: error.message, retryable: error.retryable }, 503);
		}
		serverLogs.write("error", "A server request failed.");
		console.error("Kastard server request failed:", error);
		return context.json({ error: "Internal server error." }, 500);
	});
	return app;
}

function synchronizationActive(
	customNodes: CustomNodeProvisionerApi | undefined,
	models: ModelProvisionerApi | undefined,
): boolean {
	return (
		customNodeSynchronizationActive(customNodes) || modelSynchronizationActive(models)
	);
}

function customNodeSynchronizationActive(
	customNodes: CustomNodeProvisionerApi | undefined,
): boolean {
	const customNodeStatus = customNodes?.getState().status;
	return customNodeStatus === "syncing" || customNodeStatus === "canceling";
}

function modelSynchronizationActive(models: ModelProvisionerApi | undefined): boolean {
	const modelStatus = models?.getState().status;
	return (
		modelStatus === "checking" ||
		modelStatus === "syncing" ||
		modelStatus === "canceling"
	);
}

function modelRedownloadActive(models: ModelProvisionerApi | undefined): boolean {
	if (models === undefined) return false;
	try {
		const state = models.getState();
		return (
			state.operationKind === "redownload" &&
			(state.status === "checking" ||
				state.status === "syncing" ||
				state.status === "canceling")
		);
	} catch (error) {
		if (error instanceof ModelProvisionerUnavailableError) return false;
		throw error;
	}
}

function backendPreparationActive(backend: BackendProvisionerApi | undefined): boolean {
	if (backend === undefined) return false;
	try {
		return backend.getState().status === "preparing";
	} catch (error) {
		if (error instanceof BackendProvisionerUnavailableError) return false;
		throw error;
	}
}

function comfyBlocksSynchronization(
	runtime: ComfyRuntimeApi | undefined,
	restartActive: boolean,
): boolean {
	if (restartActive) return true;
	if (runtime === undefined) return false;
	try {
		const status = runtime.getState().status;
		return status === "starting" || (status !== "ready" && runtime.isActive());
	} catch (error) {
		if (error instanceof ComfyRuntimeUnavailableError) return false;
		throw error;
	}
}

function comfyBlocksModelSynchronization(
	runtime: ComfyRuntimeApi | undefined,
	restartActive: boolean,
): boolean {
	if (restartActive) return true;
	if (runtime === undefined) return false;
	try {
		const status = runtime.getState().status;
		return status !== "starting" && status !== "ready" && runtime.isActive();
	} catch (error) {
		if (error instanceof ComfyRuntimeUnavailableError) return false;
		throw error;
	}
}
