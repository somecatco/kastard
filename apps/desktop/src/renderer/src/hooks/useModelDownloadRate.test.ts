import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkerModelSyncState } from "../../../shared/api";
import { downloadRate, useModelDownloadRate } from "./useModelDownloadRate";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function syncing(completedBytes: number): WorkerModelSyncState {
	return {
		status: "syncing",
		completed: 0,
		total: 2,
		completedBytes,
		totalBytes: 10_000,
		present: 0,
		active: ["checkpoints/model.safetensors"],
	};
}

describe("downloadRate", () => {
	test("measures bytes per second across the sample span", () => {
		expect(
			downloadRate([
				{ at: 0, bytes: 100 },
				{ at: 2_000, bytes: 300 },
				{ at: 4_000, bytes: 900 },
			]),
		).toBe(200);
	});

	test("reports no rate until the samples span enough time", () => {
		expect(downloadRate([])).toBeNull();
		expect(downloadRate([{ at: 0, bytes: 100 }])).toBeNull();
		expect(
			downloadRate([
				{ at: 0, bytes: 100 },
				{ at: 1_000, bytes: 300 },
			]),
		).toBeNull();
	});
});

describe("useModelDownloadRate", () => {
	test("measures the rate while models are syncing", () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(
			(state: WorkerModelSyncState) => useModelDownloadRate(state),
			{ initialProps: syncing(0) },
		);
		expect(result.current).toBeNull();

		rerender(syncing(1_000));
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(result.current).toBeNull();

		rerender(syncing(2_000));
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(result.current).toBe(1_000);
	});

	test("decays to zero while no bytes arrive", () => {
		vi.useFakeTimers();
		const { result } = renderHook(
			(state: WorkerModelSyncState) => useModelDownloadRate(state),
			{ initialProps: syncing(4_000) },
		);
		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(result.current).toBe(0);
	});

	test("forgets progress older than the window once the download stalls", () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(
			(state: WorkerModelSyncState) => useModelDownloadRate(state),
			{ initialProps: syncing(0) },
		);
		rerender(syncing(10_000));
		act(() => {
			vi.advanceTimersByTime(10_000);
		});
		expect(result.current).toBe(1_000);

		act(() => {
			vi.advanceTimersByTime(16_000);
		});
		expect(result.current).toBe(0);
	});

	test("restarts measuring when the Worker rolls back progress", () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(
			(state: WorkerModelSyncState) => useModelDownloadRate(state),
			{ initialProps: syncing(0) },
		);
		rerender(syncing(3_000));
		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(result.current).toBe(1_000);

		rerender(syncing(500));
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(result.current).toBeNull();
	});

	test("discards samples that straddle a system suspend", () => {
		vi.useFakeTimers({
			toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
		});
		let monotonicMs = 1_000_000;
		let wallMs = 1_700_000_000_000;
		vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
		vi.spyOn(Date, "now").mockImplementation(() => wallMs);
		const { result, rerender } = renderHook(
			(state: WorkerModelSyncState) => useModelDownloadRate(state),
			{ initialProps: syncing(0) },
		);
		const tick = (bytes: number, monotonicStepMs: number, wallStepMs: number): void => {
			rerender(syncing(bytes));
			monotonicMs += monotonicStepMs;
			wallMs += wallStepMs;
			act(() => {
				vi.advanceTimersByTime(1_000);
			});
		};

		tick(3_000, 1_000, 1_000);
		tick(6_000, 1_000, 1_000);
		expect(result.current).toBe(3_000);

		// A 13-second sleep does not expire the 15-second window, so the pre-sleep sample
		// remains while only the monotonic clock stops.
		tick(19_000, 0, 13_000);
		expect(result.current).toBeNull();
	});

	test("forgets samples once syncing ends", () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(
			(state: WorkerModelSyncState) => useModelDownloadRate(state),
			{ initialProps: syncing(0) },
		);
		rerender(syncing(3_000));
		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(result.current).toBe(1_000);

		rerender({ status: "synced", models: [] });
		expect(result.current).toBeNull();
	});
});
