type WorkerShutdownOptions = {
	runtime: { stop(): unknown } | null;
	customNodes: WorkerActivity;
	models: WorkerActivity;
	stopServer: () => unknown;
	exit: () => unknown;
	timeoutMs?: number;
	pollMs?: number;
};

type WorkerActivity = {
	getState(): { status: string };
	cancel(): unknown;
};

const CUSTOM_NODE_ACTIVE_STATES = new Set(["syncing", "canceling"]);
const MODEL_ACTIVE_STATES = new Set(["checking", "syncing", "canceling"]);

export async function shutdownWorker(options: WorkerShutdownOptions): Promise<void> {
	const pollMs = options.pollMs ?? 10;
	const timeoutMs = options.timeoutMs ?? 8_000;
	const deadline = Date.now() + timeoutMs;
	const cleanup = Promise.all([
		runAction(() => options.runtime?.stop()),
		cancelAndWait(options.customNodes, CUSTOM_NODE_ACTIVE_STATES, pollMs, deadline),
		cancelAndWait(options.models, MODEL_ACTIVE_STATES, pollMs, deadline),
		runAction(options.stopServer),
	]);
	await waitWithTimeout(cleanup, timeoutMs);
	options.exit();
}

async function cancelAndWait(
	activity: WorkerActivity,
	activeStates: ReadonlySet<string>,
	pollMs: number,
	deadline: number,
): Promise<void> {
	try {
		activity.cancel();
		while (activeStates.has(activity.getState().status) && Date.now() < deadline) {
			await delay(pollMs);
		}
	} catch {}
}

async function runAction(action: () => unknown): Promise<void> {
	try {
		await action();
	} catch {}
}

async function waitWithTimeout(
	task: Promise<unknown>,
	timeoutMs: number,
): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			task,
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
