import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader, type AppSurface } from "@/components/AppHeader";
import { ComfyUiSurface } from "@/components/ComfyUiSurface";
import { ConnectionProvider } from "@/components/ConnectionControl";
import { CustomNodesSurface } from "@/components/CustomNodesSurface";
import { ModelLibrarySurface } from "@/components/ModelLibrarySurface";
import { SettingsSurface } from "@/components/SettingsSurface";
import {
	closeHoverOverlays,
	useHoverOverlayActive,
} from "@/hooks/useCloseHoverOverlay";
import { applyTheme, watchSystemTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type {
	ComfyRuntimeState,
	ConnectionResult,
	DesktopTheme,
} from "../../shared/api";

export function App(): React.JSX.Element {
	const [surface, setSurface] = useState<AppSurface>("comfy");
	const [settingsFocusRequest, setSettingsFocusRequest] = useState(0);
	const [modelLibraryRevision, setModelLibraryRevision] = useState(0);
	const [theme, setTheme] = useState<DesktopTheme>(() => window.kastard.theme.initial);
	const [comfyRuntimeBusy, setComfyRuntimeBusy] = useState(true);
	const [comfyRuntimeState, setComfyRuntimeState] = useState<ComfyRuntimeState>({
		status: "idle",
	});
	const [customNodeNotice, setCustomNodeNotice] = useState<string | null>(null);
	const [comfyRestarting, setComfyRestarting] = useState(false);
	const [comfyRestartResult, setComfyRestartResult] = useState<ConnectionResult | null>(
		null,
	);
	const comfyRestartPromise = useRef<Promise<ConnectionResult> | null>(null);
	const hoverOverlayActive = useHoverOverlayActive();
	const handleModelLibraryChanged = useCallback(() => {
		setModelLibraryRevision((revision) => revision + 1);
	}, []);
	const handleComfyRuntimeStateChange = useCallback((state: ComfyRuntimeState) => {
		setComfyRuntimeState(state);
		setComfyRuntimeBusy(state.status !== "ready" && state.status !== "error");
		if (state.status === "starting") setCustomNodeNotice(null);
	}, []);
	const handleCustomNodeRemoved = useCallback(
		(name: string, restartRequired: boolean) => {
			setCustomNodeNotice(
				restartRequired
					? `Removed ${name} from Kastard. Restart ComfyUI to apply the change.`
					: `Moved ${name} to Trash. Try starting ComfyUI again.`,
			);
		},
		[],
	);
	const restartComfy = useCallback((): Promise<ConnectionResult> => {
		if (comfyRestartPromise.current !== null) return comfyRestartPromise.current;
		setComfyRestarting(true);
		setComfyRestartResult(null);
		const request = window.kastard.comfy
			.restart()
			.catch(
				(cause: unknown): ConnectionResult => ({
					ok: false,
					error: cause instanceof Error ? cause.message : String(cause),
				}),
			)
			.then((result) => {
				setComfyRestartResult(result);
				return result;
			})
			.finally(() => {
				setComfyRestarting(false);
				comfyRestartPromise.current = null;
			});
		comfyRestartPromise.current = request;
		return request;
	}, []);
	useEffect(() => {
		if (comfyRestartResult === null) return;
		const clearResult = window.setTimeout(() => setComfyRestartResult(null), 10_000);
		return () => window.clearTimeout(clearResult);
	}, [comfyRestartResult]);
	useEffect(
		() =>
			window.kastard.menu.onOpenSettings(() => {
				setSurface("settings");
				setSettingsFocusRequest((request) => request + 1);
			}),
		[],
	);
	useEffect(() => {
		applyTheme(theme);
		if (theme !== "system") return;
		return watchSystemTheme(() => applyTheme("system"));
	}, [theme]);
	useEffect(() => {
		const clearTextSelection = (event: PointerEvent): void => {
			if (event.button !== 0) return;
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed) selection.removeAllRanges();
		};
		document.addEventListener("pointerdown", clearTextSelection, true);
		return () => document.removeEventListener("pointerdown", clearTextSelection, true);
	}, []);

	return (
		<ConnectionProvider closeRequest={settingsFocusRequest}>
			<div
				data-testid="desktop-shell"
				className="flex h-svh min-h-0 flex-col overflow-hidden rounded-xl bg-background"
			>
				<AppHeader
					activeSurface={surface}
					onNavigate={setSurface}
					closeConnectionRequest={settingsFocusRequest}
				/>
				<main className="relative flex min-h-0 flex-1 overflow-hidden">
					{hoverOverlayActive ? (
						<div
							data-testid="hover-overlay-dismiss-surface"
							aria-hidden="true"
							className="absolute inset-0 z-40"
							onPointerEnter={closeHoverOverlays}
						/>
					) : null}
					<div
						className={cn("min-h-0 flex-1", surface === "comfy" ? "flex" : "hidden")}
						aria-hidden={surface !== "comfy"}
					>
						<ComfyUiSurface
							modelLibraryRevision={modelLibraryRevision}
							onRuntimeStateChange={handleComfyRuntimeStateChange}
						/>
					</div>
					{surface === "models" ? (
						<ModelLibrarySurface onCatalogChanged={handleModelLibraryChanged} />
					) : null}
					{surface === "custom-nodes" ? (
						<CustomNodesSurface
							runtime={comfyRuntimeState}
							notice={customNodeNotice}
							onRemoved={handleCustomNodeRemoved}
						/>
					) : null}
					{surface === "settings" ? (
						<SettingsSurface
							focusRequest={settingsFocusRequest}
							theme={theme}
							onThemeChange={setTheme}
							comfyRestarting={comfyRestarting}
							comfyRuntimeBusy={comfyRuntimeBusy}
							comfyRestartResult={comfyRestartResult}
							onRestartComfy={restartComfy}
							onClearComfyRestartResult={() => setComfyRestartResult(null)}
						/>
					) : null}
				</main>
			</div>
		</ConnectionProvider>
	);
}
