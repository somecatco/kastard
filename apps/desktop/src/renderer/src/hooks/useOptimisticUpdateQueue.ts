import { useCallback, useRef, useState } from "react";

type OptimisticSaveResult<Value, Data> =
	| { ok: true; value: Value; data: Data }
	| { ok: false; error: string };

type OptimisticUpdateContext<Value> = {
	confirmed: Value;
	latest: boolean;
};

type OptimisticUpdate<Key, Value, Data> = {
	key: Key;
	previousValue: Value;
	save: () => Promise<OptimisticSaveResult<Value, Data>>;
	formatError: (error: unknown) => string;
	onSuccess?: (data: Data, context: OptimisticUpdateContext<Value>) => void;
	onError?: (error: string, context: OptimisticUpdateContext<Value>) => void;
};

type OptimisticUpdateQueue<Key, Value> = {
	confirm: (key: Key, value: Value) => void;
	enqueue: <Data>(update: OptimisticUpdate<Key, Value, Data>) => Promise<boolean>;
	forget: (key: Key) => void;
	pendingKeys: ReadonlySet<Key>;
};

function updatePendingKey<Key>(
	current: ReadonlySet<Key>,
	key: Key,
	pending: boolean,
): ReadonlySet<Key> {
	if (current.has(key) === pending) return current;
	const next = new Set(current);
	if (pending) next.add(key);
	else next.delete(key);
	return next;
}

export function useOptimisticUpdateQueue<Key, Value>({
	trackPending = true,
}: {
	trackPending?: boolean;
} = {}): OptimisticUpdateQueue<Key, Value> {
	const confirmedValues = useRef(new Map<Key, Value>());
	const pendingUpdates = useRef(new Map<Key, Promise<boolean>>());
	const [pendingKeys, setPendingKeys] = useState<ReadonlySet<Key>>(() => new Set());

	const confirm = useCallback((key: Key, value: Value): void => {
		confirmedValues.current.set(key, value);
	}, []);
	const setPending = useCallback(
		(key: Key, pending: boolean): void => {
			if (!trackPending) return;
			setPendingKeys((current) => updatePendingKey(current, key, pending));
		},
		[trackPending],
	);

	const forget = useCallback(
		(key: Key): void => {
			confirmedValues.current.delete(key);
			pendingUpdates.current.delete(key);
			setPending(key, false);
		},
		[setPending],
	);

	const enqueue = useCallback(
		<Data>({
			key,
			previousValue,
			save,
			formatError,
			onSuccess,
			onError,
		}: OptimisticUpdate<Key, Value, Data>): Promise<boolean> => {
			if (!confirmedValues.current.has(key)) {
				confirmedValues.current.set(key, previousValue);
			}
			const previous = pendingUpdates.current.get(key) ?? Promise.resolve(true);
			let mutation: Promise<boolean>;
			mutation = previous.then(async () => {
				let result: OptimisticSaveResult<Value, Data>;
				try {
					result = await save();
				} catch (error) {
					result = { ok: false, error: formatError(error) };
				}

				const latest = pendingUpdates.current.get(key) === mutation;
				if (result.ok) {
					confirmedValues.current.set(key, result.value);
					onSuccess?.(result.data, { confirmed: result.value, latest });
					return true;
				}

				const confirmed = confirmedValues.current.get(key) ?? previousValue;
				onError?.(result.error, { confirmed, latest });
				return false;
			});
			pendingUpdates.current.set(key, mutation);
			setPending(key, true);
			void mutation.finally(() => {
				if (pendingUpdates.current.get(key) !== mutation) return;
				pendingUpdates.current.delete(key);
				setPending(key, false);
			});
			return mutation;
		},
		[setPending],
	);

	return { confirm, enqueue, forget, pendingKeys };
}
