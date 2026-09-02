import { describe, expect, test, vi } from "vitest";
import type { SyncVerification, WorkerSessionState } from "../../../shared/api";
import { WorkerSessionStateStore } from "./state";

const verification: SyncVerification = {
	status: "synced",
	backend: {
		status: "synced",
		expectedVersion: "0.33.1",
		actualVersion: "0.33.1",
	},
	models: { status: "synced", total: 0 },
	customNodes: { status: "synced", total: 0 },
};

describe("WorkerSessionStateStore", () => {
	test("publishes typed monotonic changes and skips equal state", () => {
		const store = new WorkerSessionStateStore(initialState());
		const listener = vi.fn();
		store.subscribe(listener);

		store.setComfy({ status: "loading" });
		store.setComfy({ status: "loading" });
		store.setSetup({ status: "running", phase: "preparation" });

		expect(listener.mock.calls.map(([, change]) => change)).toEqual([
			{ revision: 1, type: "comfy.changed", comfy: { status: "loading" } },
			{
				revision: 2,
				type: "setup.changed",
				setup: { status: "running", phase: "preparation" },
			},
		]);
		expect(store.getSnapshot().revision).toBe(2);
	});

	test("invalidates verification in the same resource transition", () => {
		const store = new WorkerSessionStateStore({
			...initialState(),
			verification,
		});
		const listener = vi.fn();
		store.subscribe(listener);

		store.setBackend({
			status: "loading",
			editorComfyVersion: "0.33.1",
		});

		expect(store.getState().verification).toBeNull();
		expect(listener).toHaveBeenCalledWith(
			expect.objectContaining({ verification: null }),
			{
				revision: 1,
				type: "backend.changed",
				backend: {
					status: "loading",
					editorComfyVersion: "0.33.1",
				},
			},
		);
	});

	test("resets every Worker-owned slice in one transition", () => {
		const store = new WorkerSessionStateStore({
			...initialState(),
			comfy: { status: "ready" },
			verification,
		});
		const listener = vi.fn();
		store.subscribe(listener);
		const reset = initialState();

		store.reset(reset);

		expect(store.getState()).toBe(reset);
		expect(listener).toHaveBeenCalledWith(reset, {
			revision: 1,
			type: "session.reset",
			state: reset,
		});
	});
});

function initialState(): WorkerSessionState {
	return {
		connection: {
			status: "disconnected",
			recentProvider: null,
			recentServerUrl: null,
		},
		systemMetrics: { status: "disconnected" },
		backend: { status: "disconnected", editorComfyVersion: "0.33.1" },
		comfy: { status: "disconnected" },
		customNodes: { status: "disconnected" },
		models: { status: "disconnected" },
		verification: null,
		setup: { status: "idle" },
	};
}
