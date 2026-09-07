import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useOptimisticUpdateQueue } from "@/hooks/useOptimisticUpdateQueue";
import type {
	ConnectionRequest,
	ConnectionResult,
	ConnectionSettings as ConnectionSettingsValue,
} from "../../../shared/api";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function useSettingsOwner() {
	const [syncAfterConnect, setSyncAfterConnect] = useState(true);
	const [systemMetricsEnabled, setSystemMetricsEnabled] = useState(true);
	const [settingsLoading, setSettingsLoading] = useState(true);
	const [settingsReady, setSettingsReady] = useState(false);
	const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
	const settingsReadVersion = useRef(0);
	const settingsChanges = useRef<
		Array<{ field: keyof ConnectionSettingsValue; value: boolean }>
	>([]);
	const [pendingSettingsFields, setPendingSettingsFields] = useState<
		ReadonlySet<keyof ConnectionSettingsValue>
	>(new Set());
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [systemMetricsError, setSystemMetricsError] = useState<string | null>(null);
	const { confirm: confirmSettings, enqueue: enqueueSettings } =
		useOptimisticUpdateQueue<"settings", ConnectionSettingsValue>({
			trackPending: false,
		});
	const confirmedSettingsRef = useRef<ConnectionSettingsValue>({
		syncAfterConnect: true,
		systemMetricsEnabled: true,
	});
	const reloadSettings = useCallback(async () => {
		if (settingsChanges.current.length > 0) return;
		const request = ++settingsReadVersion.current;
		setSettingsLoading(true);
		setSettingsLoadError(null);
		try {
			const result = await window.kastard.connection.getSettings();
			if (request !== settingsReadVersion.current) return;
			if (result.ok) {
				confirmedSettingsRef.current = result.settings;
				confirmSettings("settings", result.settings);
				setSyncAfterConnect(result.settings.syncAfterConnect);
				setSystemMetricsEnabled(result.settings.systemMetricsEnabled);
				setSettingsReady(true);
			} else setSettingsLoadError(result.error);
		} catch (error) {
			if (request === settingsReadVersion.current)
				setSettingsLoadError(errorMessage(error));
		} finally {
			if (request === settingsReadVersion.current) setSettingsLoading(false);
		}
	}, [confirmSettings]);
	useEffect(() => {
		void reloadSettings();
		return () => {
			++settingsReadVersion.current;
		};
	}, [reloadSettings]);

	const displaySettings = useCallback((): void => {
		const visible = { ...confirmedSettingsRef.current };
		for (const change of settingsChanges.current) visible[change.field] = change.value;
		setSyncAfterConnect(visible.syncAfterConnect);
		setSystemMetricsEnabled(visible.systemMetricsEnabled);
		setPendingSettingsFields(
			new Set(settingsChanges.current.map(({ field }) => field)),
		);
	}, []);
	const updateConnectionSettings = useCallback(
		(field: keyof ConnectionSettingsValue, value: boolean): Promise<boolean> => {
			if (!settingsReady) return Promise.resolve(false);
			++settingsReadVersion.current;
			setSettingsLoading(false);
			const change = { field, value };
			settingsChanges.current.push(change);
			displaySettings();
			const setFieldError =
				field === "syncAfterConnect" ? setSettingsError : setSystemMetricsError;
			setFieldError(null);
			const settle = (
				confirmed: ConnectionSettingsValue,
				error: string | null,
			): void => {
				confirmedSettingsRef.current = confirmed;
				settingsChanges.current = settingsChanges.current.filter(
					(pending) => pending !== change,
				);
				if (!settingsChanges.current.some((pending) => pending.field === field))
					setFieldError(error);
				displaySettings();
			};
			return enqueueSettings({
				key: "settings",
				previousValue: confirmedSettingsRef.current,
				formatError: errorMessage,
				save: async () => {
					const result = await window.kastard.connection.updateSettings({
						...confirmedSettingsRef.current,
						[field]: value,
					});
					return result.ok
						? { ok: true, value: result.settings, data: undefined }
						: result;
				},
				onSuccess: (_, { confirmed }) => settle(confirmed, null),
				onError: (error, { confirmed }) => settle(confirmed, error),
			});
		},
		[settingsReady, enqueueSettings, displaySettings],
	);
	const updateSyncAfterConnect = useCallback(
		(value: boolean): Promise<boolean> =>
			updateConnectionSettings("syncAfterConnect", value),
		[updateConnectionSettings],
	);
	const updateSystemMetricsEnabled = useCallback(
		(value: boolean): Promise<boolean> =>
			updateConnectionSettings("systemMetricsEnabled", value),
		[updateConnectionSettings],
	);

	const connect = useCallback(
		(request: ConnectionRequest): Promise<ConnectionResult> => {
			++settingsReadVersion.current;
			return new Promise((resolve) => {
				void enqueueSettings({
					key: "settings",
					previousValue: confirmedSettingsRef.current,
					formatError: errorMessage,
					save: async () => {
						const result = await window.kastard.workerSession.connect(request);
						return result.ok
							? {
									ok: true,
									value: {
										...confirmedSettingsRef.current,
										syncAfterConnect: request.syncAfterConnect,
									},
									data: result,
								}
							: result;
					},
					onSuccess: (result, { confirmed }) => {
						confirmedSettingsRef.current = confirmed;
						setSettingsLoading(false);
						setSettingsReady(true);
						displaySettings();
						resolve(result);
					},
					onError: (error) => resolve({ ok: false, error }),
				});
			});
		},
		[enqueueSettings, displaySettings],
	);

	return useMemo(
		() => ({
			syncAfterConnect,
			systemMetricsEnabled,
			settingsLoading,
			settingsReady,
			settingsLoadError,
			reloadSettings,
			pendingSettingsFields,
			settingsError,
			systemMetricsError,
			updateSyncAfterConnect,
			updateSystemMetricsEnabled,
			connect,
		}),
		[
			syncAfterConnect,
			systemMetricsEnabled,
			settingsLoading,
			settingsReady,
			settingsLoadError,
			reloadSettings,
			pendingSettingsFields,
			settingsError,
			systemMetricsError,
			updateSyncAfterConnect,
			updateSystemMetricsEnabled,
			connect,
		],
	);
}

const ConnectionSettingsContext = createContext<ReturnType<
	typeof useSettingsOwner
> | null>(null);
export function ConnectionSettingsProvider({
	children,
}: {
	children: ReactNode;
}): React.JSX.Element {
	const settings = useSettingsOwner();
	return (
		<ConnectionSettingsContext.Provider value={settings}>
			{children}
		</ConnectionSettingsContext.Provider>
	);
}
export function useConnectionSettings() {
	const settings = useContext(ConnectionSettingsContext);
	if (settings === null)
		throw new Error("Connection settings require ConnectionSettingsProvider.");
	return settings;
}
