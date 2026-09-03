export type WorkerSessionRequestFetch = typeof fetch;

export type WorkerSessionResource =
	| "connection"
	| "logs"
	| "backend"
	| "comfy"
	| "customNodes"
	| "models"
	| "systemMetrics"
	| "verification";

export class WorkerSessionRequestScope<Resource extends string> {
	private generation = 0;
	private readonly pollTimers = new Map<Resource, ReturnType<typeof setTimeout>>();
	private readonly operations = new Map<Resource | symbol, number>();
	private readonly controllers = new Map<Resource | symbol, AbortController>();

	get currentGeneration(): number {
		return this.generation;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation;
	}

	has(resource: Resource): boolean {
		return this.controllers.has(resource);
	}

	abort(resource: Resource): void {
		this.controllers.get(resource)?.abort();
	}

	invalidate(resource: Resource): void {
		this.clearPoll(resource);
		this.operations.set(resource, (this.operations.get(resource) ?? 0) + 1);
		this.controllers.get(resource)?.abort();
	}

	invalidateAll(): void {
		this.generation += 1;
		this.clearPolls();
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
		this.operations.clear();
	}

	schedule(
		resource: Resource,
		generation: number,
		poll: () => Promise<void>,
		delayMs: number,
		active: boolean,
	): void {
		this.clearPoll(resource);
		if (!active || !this.isCurrent(generation)) return;
		const timer = setTimeout(() => {
			this.pollTimers.delete(resource);
			void poll();
		}, delayMs);
		this.pollTimers.set(resource, timer);
	}

	clearPoll(resource: Resource): void {
		const timer = this.pollTimers.get(resource);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.pollTimers.delete(resource);
	}

	async run<Result>(
		resource: Resource | symbol,
		generation: number,
		request: (requestFetch: WorkerSessionRequestFetch) => Promise<Result>,
	): Promise<Result | null> {
		const operation = (this.operations.get(resource) ?? 0) + 1;
		this.operations.set(resource, operation);
		this.controllers.get(resource)?.abort();
		const controller = new AbortController();
		this.controllers.set(resource, controller);
		try {
			const result = await request(abortableFetch(controller.signal));
			return this.isCurrent(generation) && this.operations.get(resource) === operation
				? result
				: null;
		} catch (error) {
			if (
				controller.signal.aborted ||
				!this.isCurrent(generation) ||
				this.operations.get(resource) !== operation
			) {
				return null;
			}
			throw error;
		} finally {
			if (this.controllers.get(resource) === controller) {
				this.controllers.delete(resource);
				if (typeof resource === "symbol") this.operations.delete(resource);
			}
		}
	}

	private clearPolls(): void {
		for (const timer of this.pollTimers.values()) clearTimeout(timer);
		this.pollTimers.clear();
	}
}

function abortableFetch(signal: AbortSignal): WorkerSessionRequestFetch {
	return (input, init) => {
		const signals = [signal, init?.signal].filter(
			(candidate): candidate is AbortSignal =>
				candidate !== null && candidate !== undefined,
		);
		const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
		return fetch(input, {
			...init,
			...(combinedSignal === undefined ? {} : { signal: combinedSignal }),
		});
	};
}
