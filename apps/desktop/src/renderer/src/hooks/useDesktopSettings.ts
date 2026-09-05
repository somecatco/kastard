import { useCallback, useEffect, useRef, useState } from "react";
import type {
	DesktopTheme,
	ModelProvider,
	ModelProviderSettings,
} from "../../../shared/api";
import { useOptimisticUpdateQueue } from "./useOptimisticUpdateQueue";

type SettingResult<Value> = { ok: true; value: Value } | { ok: false; error: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function useSavedSetting<Value>(
	initial: Value | null,
	read: () => Promise<SettingResult<Value>>,
	save: (value: Value) => Promise<SettingResult<Value>>,
) {
	const [value, setValue] = useState(initial);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<{
		operation: "load" | "save";
		message: string;
	} | null>(null);
	const version = useRef(0);
	const pending = useRef(0);
	const { confirm, enqueue, pendingKeys } = useOptimisticUpdateQueue<"value", Value>();
	const reload = useCallback(async () => {
		if (pending.current > 0) return;
		const request = ++version.current;
		setLoading(true);
		setError(null);
		try {
			const result = await read();
			if (request !== version.current) return;
			if (result.ok) {
				confirm("value", result.value);
				setValue(result.value);
			} else setError({ operation: "load", message: result.error });
		} catch (cause) {
			if (request === version.current)
				setError({ operation: "load", message: errorMessage(cause) });
		} finally {
			if (request === version.current) setLoading(false);
		}
	}, [read, confirm]);
	useEffect(() => {
		void reload();
		return () => {
			++version.current;
		};
	}, [reload]);

	const update = (next: Value): Promise<boolean> => {
		if (value === null) return Promise.resolve(false);
		++version.current;
		++pending.current;
		setLoading(false);
		setValue(next);
		setError(null);
		return enqueue({
			key: "value",
			previousValue: value,
			formatError: errorMessage,
			save: async () => {
				const result = await save(next);
				return result.ok ? { ...result, data: undefined } : result;
			},
			onSuccess: (_, { confirmed, latest }) => {
				if (latest) {
					setValue(confirmed);
					setError(null);
				}
			},
			onError: (message, { confirmed, latest }) => {
				if (latest) {
					setValue(confirmed);
					setError({ operation: "save", message });
				}
			},
		}).finally(() => {
			--pending.current;
		});
	};
	return {
		value,
		loading,
		error: error?.message ?? null,
		loadFailed: error?.operation === "load",
		saving: pendingKeys.has("value"),
		reload,
		update,
	};
}

async function readTheme(): Promise<SettingResult<DesktopTheme>> {
	const result = await window.kastard.theme.get();
	return result.ok ? { ok: true, value: result.theme } : result;
}
async function saveTheme(value: DesktopTheme): Promise<SettingResult<DesktopTheme>> {
	const result = await window.kastard.theme.update(value);
	return result.ok ? { ok: true, value: result.theme } : result;
}
async function readNotification(): Promise<SettingResult<boolean>> {
	const result = await window.kastard.syncCompletionNotification.getSettings();
	return result.ok ? { ok: true, value: result.settings.enabled } : result;
}
async function saveNotification(enabled: boolean): Promise<SettingResult<boolean>> {
	const result = await window.kastard.syncCompletionNotification.updateSettings({
		enabled,
	});
	return result.ok ? { ok: true, value: result.settings.enabled } : result;
}

export type ProviderFeedback = { type: "success" | "error"; message: string };

export function useDesktopSettings() {
	const theme = useSavedSetting(window.kastard.theme.initial, readTheme, saveTheme);
	const notification = useSavedSetting(null, readNotification, saveNotification);
	const [configured, setConfigured] = useState<ModelProviderSettings | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState<ReadonlySet<ModelProvider>>(new Set());
	const pendingProviders = useRef(new Set<ModelProvider>());
	const [feedback, setFeedback] = useState<
		Partial<Record<ModelProvider, ProviderFeedback>>
	>({});
	const version = useRef(0);
	const reloadProviders = useCallback(async () => {
		if (pendingProviders.current.size > 0) return;
		const request = ++version.current;
		setLoading(true);
		setLoadError(null);
		try {
			const result = await window.kastard.modelProviders.getSettings();
			if (request !== version.current) return;
			if (result.ok) setConfigured(result.configured);
			else setLoadError(result.error);
		} catch (cause) {
			if (request === version.current) setLoadError(errorMessage(cause));
		} finally {
			if (request === version.current) setLoading(false);
		}
	}, []);
	useEffect(() => {
		void reloadProviders();
		return () => {
			++version.current;
		};
	}, [reloadProviders]);

	const clearFeedback = (provider: ModelProvider) => {
		setFeedback((current) => ({ ...current, [provider]: undefined }));
	};
	const updateToken = async (
		provider: ModelProvider,
		token: string | null,
	): Promise<boolean> => {
		if (configured === null || pendingProviders.current.has(provider)) return false;
		++version.current;
		setLoading(false);
		pendingProviders.current.add(provider);
		setSaving(new Set(pendingProviders.current));
		clearFeedback(provider);
		try {
			const result = await window.kastard.modelProviders.updateToken({
				provider,
				token,
			});
			if (!result.ok) throw new Error(result.error);
			setConfigured(
				(current) => current && { ...current, [provider]: result.configured[provider] },
			);
			setFeedback((current) => ({
				...current,
				[provider]: {
					type: "success",
					message: token === null ? "Token removed." : "Token saved.",
				},
			}));
			return true;
		} catch (cause) {
			setFeedback((current) => ({
				...current,
				[provider]: { type: "error", message: errorMessage(cause) },
			}));
			return false;
		} finally {
			pendingProviders.current.delete(provider);
			setSaving(new Set(pendingProviders.current));
		}
	};
	return {
		theme: { ...theme, value: theme.value ?? window.kastard.theme.initial },
		notification,
		providers: {
			configured,
			loading,
			loadError,
			saving,
			feedback,
			reload: reloadProviders,
			updateToken,
			clearFeedback,
		},
	};
}

export type DesktopSettings = ReturnType<typeof useDesktopSettings>;
