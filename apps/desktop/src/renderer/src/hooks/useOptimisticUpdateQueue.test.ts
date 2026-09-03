import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useOptimisticUpdateQueue } from "./useOptimisticUpdateQueue";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

type SaveResult<Data = undefined> =
	| { ok: true; value: boolean; data: Data }
	| { ok: false; error: string };

function deferred<T>(): Deferred<T> {
	let resolve = (_value: T): void => undefined;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

test("serializes updates for the same key and protects the latest value", async () => {
	const first = deferred<SaveResult<string>>();
	const second = deferred<SaveResult<string>>();
	const firstSave = vi.fn(() => first.promise);
	const secondSave = vi.fn(() => second.promise);
	const successes: Array<{ data: string; latest: boolean }> = [];
	const { result } = renderHook(() => useOptimisticUpdateQueue<string, boolean>());

	act(() => result.current.confirm("setting", true));
	let firstMutation!: Promise<boolean>;
	let secondMutation!: Promise<boolean>;
	act(() => {
		firstMutation = result.current.enqueue({
			key: "setting",
			previousValue: true,
			save: firstSave,
			formatError: String,
			onSuccess: (data, context) => successes.push({ data, latest: context.latest }),
		});
		secondMutation = result.current.enqueue({
			key: "setting",
			previousValue: false,
			save: secondSave,
			formatError: String,
			onSuccess: (data, context) => successes.push({ data, latest: context.latest }),
		});
	});
	await act(async () => Promise.resolve());

	expect(firstSave).toHaveBeenCalledOnce();
	expect(secondSave).not.toHaveBeenCalled();
	expect(result.current.pendingKeys.has("setting")).toBe(true);

	await act(async () => {
		first.resolve({ ok: true, value: false, data: "first" });
		await firstMutation;
	});
	expect(secondSave).toHaveBeenCalledOnce();
	expect(successes).toEqual([{ data: "first", latest: false }]);
	expect(result.current.pendingKeys.has("setting")).toBe(true);

	await act(async () => {
		second.resolve({ ok: true, value: true, data: "second" });
		await secondMutation;
	});
	expect(successes).toEqual([
		{ data: "first", latest: false },
		{ data: "second", latest: true },
	]);
	expect(result.current.pendingKeys.has("setting")).toBe(false);
});

test("restores the last confirmed value when the latest update fails", async () => {
	const first = deferred<SaveResult>();
	const second = deferred<SaveResult>();
	const errors: Array<{ error: string; confirmed: boolean; latest: boolean }> = [];
	const { result } = renderHook(() => useOptimisticUpdateQueue<string, boolean>());

	act(() => result.current.confirm("setting", true));
	let firstMutation!: Promise<boolean>;
	let secondMutation!: Promise<boolean>;
	act(() => {
		firstMutation = result.current.enqueue({
			key: "setting",
			previousValue: true,
			save: () => first.promise,
			formatError: String,
		});
		secondMutation = result.current.enqueue({
			key: "setting",
			previousValue: false,
			save: () => second.promise,
			formatError: String,
			onError: (error, context) => errors.push({ error, ...context }),
		});
	});

	await act(async () => {
		first.resolve({ ok: true, value: false, data: undefined });
		await firstMutation;
		second.resolve({ ok: false, error: "Save failed." });
		await secondMutation;
	});
	expect(errors).toEqual([{ error: "Save failed.", confirmed: false, latest: true }]);
});

test("runs different keys independently", async () => {
	const first = deferred<SaveResult>();
	const second = deferred<SaveResult>();
	const firstSave = vi.fn(() => first.promise);
	const secondSave = vi.fn(() => second.promise);
	const { result } = renderHook(() => useOptimisticUpdateQueue<string, boolean>());

	let firstMutation!: Promise<boolean>;
	let secondMutation!: Promise<boolean>;
	act(() => {
		firstMutation = result.current.enqueue({
			key: "first",
			previousValue: true,
			save: firstSave,
			formatError: String,
		});
		secondMutation = result.current.enqueue({
			key: "second",
			previousValue: true,
			save: secondSave,
			formatError: String,
		});
	});
	await act(async () => Promise.resolve());

	expect(firstSave).toHaveBeenCalledOnce();
	expect(secondSave).toHaveBeenCalledOnce();
	expect(result.current.pendingKeys).toEqual(new Set(["first", "second"]));

	await act(async () => {
		first.resolve({ ok: true, value: false, data: undefined });
		second.resolve({ ok: true, value: false, data: undefined });
		await Promise.all([firstMutation, secondMutation]);
	});
	expect(result.current.pendingKeys.size).toBe(0);
});

test("formats thrown save errors and forgets removed keys", async () => {
	const onError = vi.fn();
	const { result } = renderHook(() => useOptimisticUpdateQueue<string, boolean>());

	let mutation!: Promise<boolean>;
	act(() => {
		mutation = result.current.enqueue({
			key: "setting",
			previousValue: true,
			save: () => Promise.reject(new Error("offline")),
			formatError: (error) => `Save failed: ${String(error)}`,
			onError,
		});
	});
	expect(await mutation).toBe(false);
	expect(onError).toHaveBeenCalledWith("Save failed: Error: offline", {
		confirmed: true,
		latest: true,
	});

	act(() => result.current.forget("setting"));
	expect(result.current.pendingKeys.has("setting")).toBe(false);
});
