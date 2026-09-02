import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { WorkerModelSyncState } from "../../../shared/api";

const SAMPLE_INTERVAL_MS = 1_000;
const WINDOW_MS = 15_000;
const MIN_SPAN_MS = 2_000;
const MAX_CLOCK_DRIFT_MS = 1_000;

// Measure elapsed time with a monotonic clock unaffected by NTP adjustments, and detect
// periods when it stops during system sleep by comparing its drift from the wall clock.
type Sample = { at: number; wallAt: number; bytes: number };

export function downloadRate(
	samples: readonly { at: number; bytes: number }[],
): number | null {
	const oldest = samples[0];
	const newest = samples.at(-1);
	if (oldest === undefined || newest === undefined) return null;
	const spanMs = newest.at - oldest.at;
	if (spanMs < MIN_SPAN_MS) return null;
	return Math.max(0, ((newest.bytes - oldest.bytes) * 1_000) / spanMs);
}

export function useModelDownloadRate(state: WorkerModelSyncState): number | null {
	const [rate, setRate] = useState<number | null>(null);
	const samples = useRef<Sample[]>([]);
	const syncing = state.status === "syncing";

	const record = useEffectEvent(() => {
		if (state.status !== "syncing") return;
		const at = performance.now();
		const wallAt = Date.now();
		const previous = samples.current.at(-1);
		// A failed download makes the Worker remove its in-progress bytes from the total,
		// causing progress to decrease.
		const kept =
			previous !== undefined &&
			(state.completedBytes < previous.bytes ||
				Math.abs(wallAt - previous.wallAt - (at - previous.at)) > MAX_CLOCK_DRIFT_MS)
				? []
				: samples.current;
		samples.current = [...kept, { at, wallAt, bytes: state.completedBytes }].filter(
			(sample) => at - sample.at <= WINDOW_MS,
		);
		setRate(downloadRate(samples.current));
	});

	useEffect(() => {
		if (!syncing) {
			samples.current = [];
			setRate(null);
			return;
		}
		record();
		const timer = setInterval(record, SAMPLE_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [syncing]);

	return rate;
}
