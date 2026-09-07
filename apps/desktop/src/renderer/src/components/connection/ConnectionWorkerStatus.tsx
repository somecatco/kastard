import { WorkerStatus } from "@/components/WorkerStatus";
import { useConnectionSettings } from "@/hooks/use-connection-settings";
import { sameFields, useWorkerSessionSelector } from "@/hooks/use-worker-session";

export function ConnectionWorkerStatus(): React.JSX.Element | null {
	const state = useWorkerSessionSelector(
		(session) => ({
			connected: session.connection.status === "connected",
			metrics: session.systemMetrics,
		}),
		sameFields,
	);
	const { settingsReady, systemMetricsEnabled } = useConnectionSettings();
	return state.connected && settingsReady && systemMetricsEnabled ? (
		<WorkerStatus
			status={state.metrics.status === "available" ? state.metrics.metrics : undefined}
		/>
	) : null;
}
