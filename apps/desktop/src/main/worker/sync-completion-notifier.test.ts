// @vitest-environment node

import { expect, test, vi } from "vitest";
import type { SyncVerification, WorkerSetupState } from "../../shared/api";
import { SyncCompletionNotifier } from "./sync-completion-notifier";

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

test("shows once when Worker setup succeeds and again after another run", () => {
	const show = vi.fn();
	const notifier = new SyncCompletionNotifier(() => true, show);

	for (const state of [
		{ status: "running", phase: "preparation" },
		{ status: "running", phase: "verification" },
		{ status: "running", phase: "comfy" },
		{ status: "succeeded", verification },
		{ status: "succeeded", verification },
	] satisfies WorkerSetupState[]) {
		notifier.handle(state);
	}
	expect(show).toHaveBeenCalledOnce();

	notifier.handle({ status: "running", phase: "preparation" });
	notifier.handle({ status: "succeeded", verification });
	expect(show).toHaveBeenCalledTimes(2);
});

test("does not show for failed or canceled setup", () => {
	const show = vi.fn();
	const notifier = new SyncCompletionNotifier(() => true, show);

	notifier.handle({ status: "failed", phase: "comfy", error: "Failed." });
	notifier.handle({ status: "canceled" });

	expect(show).not.toHaveBeenCalled();
});

test("does not show when notifications are disabled", () => {
	const show = vi.fn();
	const notifier = new SyncCompletionNotifier(() => false, show);

	notifier.handle({ status: "succeeded", verification });

	expect(show).not.toHaveBeenCalled();
});

test("does not throw when the native notification fails", () => {
	const notifier = new SyncCompletionNotifier(
		() => true,
		() => {
			throw new Error("Notifications unavailable.");
		},
	);

	expect(() => notifier.handle({ status: "succeeded", verification })).not.toThrow();
});
