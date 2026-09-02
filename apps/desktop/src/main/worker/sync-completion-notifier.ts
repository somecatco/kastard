import type { WorkerSetupState } from "../../shared/api";

export class SyncCompletionNotifier {
	private previousStatus: WorkerSetupState["status"] = "idle";

	constructor(
		private readonly isEnabled: () => boolean,
		private readonly show: () => void,
	) {}

	handle(state: WorkerSetupState): void {
		const shouldShow =
			state.status === "succeeded" && this.previousStatus !== "succeeded";
		this.previousStatus = state.status;
		if (!shouldShow || !this.isEnabled()) return;

		try {
			this.show();
		} catch {
			// Notification failures must not change a successful Worker setup result.
		}
	}
}
