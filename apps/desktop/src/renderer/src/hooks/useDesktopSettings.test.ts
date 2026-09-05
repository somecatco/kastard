import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type {
	DesktopThemeResult,
	ModelProviderSettingsResult,
	SyncCompletionNotificationSettingsResult,
} from "../../../shared/api";
import "../App.test-harness";
import { useDesktopSettings } from "./useDesktopSettings";

function deferred<T>() {
	let resolve!: (result: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

test("loads settings independently", async () => {
	const notification = deferred<SyncCompletionNotificationSettingsResult>();
	vi.mocked(window.kastard.syncCompletionNotification.getSettings).mockReturnValueOnce(
		notification.promise,
	);
	const { result } = renderHook(useDesktopSettings);
	expect(result.current.notification.value).toBeNull();
	expect(result.current.providers.configured).toBeNull();
	await waitFor(() => expect(result.current.theme.loading).toBe(false));
	expect(result.current.notification.loading).toBe(true);
	await act(async () =>
		notification.resolve({ ok: true, settings: { enabled: false } }),
	);
	expect(result.current.notification.value).toBe(false);
	expect(window.kastard.syncCompletionNotification.getSettings).toHaveBeenCalledOnce();
});

test("keeps the latest theme selection and restores the last successful save", async () => {
	const first = deferred<DesktopThemeResult>();
	const second = deferred<DesktopThemeResult>();
	vi.mocked(window.kastard.theme.update)
		.mockReturnValueOnce(first.promise)
		.mockReturnValueOnce(second.promise);
	const { result } = renderHook(useDesktopSettings);
	await waitFor(() => expect(result.current.theme.loading).toBe(false));
	act(() => {
		void result.current.theme.update("dark");
		void result.current.theme.update("light");
	});
	expect(result.current.theme.value).toBe("light");
	expect(result.current.theme.saving).toBe(true);
	await act(async () => first.resolve({ ok: true, theme: "dark" }));
	expect(result.current.theme.value).toBe("light");
	await act(async () => second.resolve({ ok: false, error: "Save failed." }));
	expect(result.current.theme.value).toBe("dark");
	expect(result.current.theme.error).toBe("Save failed.");
	expect(result.current.theme.saving).toBe(false);
});

test("keeps the final notification selection after an earlier save fails", async () => {
	const first = deferred<SyncCompletionNotificationSettingsResult>();
	vi.mocked(
		window.kastard.syncCompletionNotification.updateSettings,
	).mockReturnValueOnce(first.promise);
	const { result } = renderHook(useDesktopSettings);
	await waitFor(() => expect(result.current.notification.value).toBe(true));
	act(() => {
		void result.current.notification.update(false);
		void result.current.notification.update(true);
	});
	await act(async () => first.resolve({ ok: false, error: "Save failed." }));
	await waitFor(() => expect(result.current.notification.saving).toBe(false));
	expect(result.current.notification.value).toBe(true);
	expect(result.current.notification.error).toBeNull();
	expect(
		window.kastard.syncCompletionNotification.updateSettings,
	).toHaveBeenLastCalledWith({ enabled: true });
});

test("isolates provider operations and merges out-of-order results by provider", async () => {
	const huggingface = deferred<ModelProviderSettingsResult>();
	const civitai = deferred<ModelProviderSettingsResult>();
	vi.mocked(window.kastard.modelProviders.updateToken).mockImplementation(
		({ provider }) =>
			provider === "huggingface" ? huggingface.promise : civitai.promise,
	);
	const { result } = renderHook(useDesktopSettings);
	await waitFor(() => expect(result.current.providers.configured).not.toBeNull());
	act(() => {
		void result.current.providers.updateToken("huggingface", "example-token");
		void result.current.providers.updateToken("huggingface", "duplicate-token");
		void result.current.providers.updateToken("civitai", "example-token");
	});
	expect(window.kastard.modelProviders.updateToken).toHaveBeenCalledTimes(2);
	expect(result.current.providers.configured).toEqual({
		huggingface: false,
		civitai: false,
	});
	await act(async () =>
		civitai.resolve({ ok: true, configured: { huggingface: false, civitai: true } }),
	);
	expect(result.current.providers.saving.has("huggingface")).toBe(true);
	expect(result.current.providers.saving.has("civitai")).toBe(false);
	await act(async () =>
		huggingface.resolve({
			ok: true,
			configured: { huggingface: true, civitai: false },
		}),
	);
	expect(result.current.providers.configured).toEqual({
		huggingface: true,
		civitai: true,
	});
	expect(result.current.providers.feedback.huggingface?.type).toBe("success");
	expect(result.current.providers.feedback.civitai?.type).toBe("success");
});

test("keeps a configured provider until removal succeeds and preserves it on failure", async () => {
	vi.mocked(window.kastard.modelProviders.getSettings).mockResolvedValueOnce({
		ok: true,
		configured: { huggingface: true, civitai: false },
	});
	const removal = deferred<ModelProviderSettingsResult>();
	vi.mocked(window.kastard.modelProviders.updateToken).mockReturnValueOnce(
		removal.promise,
	);
	const { result } = renderHook(useDesktopSettings);
	await waitFor(() =>
		expect(result.current.providers.configured?.huggingface).toBe(true),
	);
	act(() => {
		void result.current.providers.updateToken("huggingface", null);
	});
	expect(result.current.providers.configured?.huggingface).toBe(true);
	await act(async () => removal.resolve({ ok: false, error: "Removal failed." }));
	expect(result.current.providers.configured?.huggingface).toBe(true);
	expect(result.current.providers.feedback.huggingface?.message).toBe(
		"Removal failed.",
	);
});
