import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkerSessionRequestScope } from "./request-scope";

describe("WorkerSessionRequestScope", () => {
	afterEach(() => vi.useRealTimers());

	test("keeps only the latest request for a resource", async () => {
		const scope = new WorkerSessionRequestScope<"models">();
		const first = deferred<string>();

		const firstResult = scope.run("models", 0, () => first.promise);
		const secondResult = scope.run("models", 0, async () => "second");
		first.resolve("first");

		await expect(secondResult).resolves.toBe("second");
		await expect(firstResult).resolves.toBeNull();
	});

	test("allows independent operation identities to finish", async () => {
		const scope = new WorkerSessionRequestScope<"models">();

		const first = scope.run(Symbol("first"), 0, async () => "first");
		const second = scope.run(Symbol("second"), 0, async () => "second");

		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
	});

	test("invalidates every pending request when the session changes", async () => {
		const scope = new WorkerSessionRequestScope<"models">();
		const pending = deferred<string>();
		const result = scope.run("models", 0, () => pending.promise);

		scope.invalidateAll();
		pending.resolve("stale");

		expect(scope.currentGeneration).toBe(1);
		await expect(result).resolves.toBeNull();
	});

	test("replaces an existing poll for the same resource", async () => {
		vi.useFakeTimers();
		const scope = new WorkerSessionRequestScope<"models">();
		const first = vi.fn(async () => undefined);
		const second = vi.fn(async () => undefined);

		scope.schedule("models", 0, first, 10, true);
		scope.schedule("models", 0, second, 10, true);
		await vi.advanceTimersByTimeAsync(10);

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
	});
});

function deferred<Value>(): {
	promise: Promise<Value>;
	resolve: (value: Value) => void;
} {
	let resolve = (_value: Value): void => undefined;
	const promise = new Promise<Value>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
