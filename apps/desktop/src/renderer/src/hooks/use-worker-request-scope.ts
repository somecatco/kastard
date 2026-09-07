import { useCallback, useEffect, useRef } from "react";
import {
	getWorkerSessionEpoch,
	useWorkerSessionSubscription,
} from "@/hooks/use-worker-session";

export function useWorkerRequestScope(onReset: () => void) {
	const epoch = useRef(getWorkerSessionEpoch());
	const requests = useRef(new Map<string, symbol>());
	useWorkerSessionSubscription(() => {
		const next = getWorkerSessionEpoch();
		if (next === epoch.current) return;
		epoch.current = next;
		requests.current.clear();
		onReset();
	});
	useEffect(
		() => () => {
			requests.current.clear();
		},
		[],
	);
	return useCallback((key: string) => {
		const token = Symbol();
		const session = getWorkerSessionEpoch();
		requests.current.set(key, token);
		return () =>
			session === getWorkerSessionEpoch() && requests.current.get(key) === token;
	}, []);
}
