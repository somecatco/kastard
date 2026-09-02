import { AlertTriangleIcon, LoaderCircleIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProgressBar } from "@/components/common/progress-bar";
import { Button } from "@/components/ui/button";
import type { ComfyRuntimeState, ComfyVersionState } from "../../../shared/api";

type ComfyUiSurfaceProps = {
	modelLibraryRevision: number;
	onRuntimeStateChange: (state: ComfyRuntimeState) => void;
};

export function ComfyUiSurface({
	modelLibraryRevision,
	onRuntimeStateChange,
}: ComfyUiSurfaceProps): React.JSX.Element {
	const [runtime, setRuntime] = useState<ComfyRuntimeState>({ status: "idle" });
	const [versions, setVersions] = useState<ComfyVersionState | null>(null);
	const requestId = useRef(0);
	const updateRuntime = useCallback(
		(state: ComfyRuntimeState) => {
			setRuntime(state);
			onRuntimeStateChange(state);
		},
		[onRuntimeStateChange],
	);

	const startRuntime = useCallback(async (): Promise<void> => {
		const currentRequest = requestId.current + 1;
		requestId.current = currentRequest;
		updateRuntime({ status: "starting" });
		try {
			const result = await window.kastard.comfy.start();
			if (requestId.current !== currentRequest) return;
			updateRuntime(
				result.ok
					? { status: "ready", url: result.url }
					: {
							status: "error",
							message: result.error,
							...(result.reason === undefined ? {} : { reason: result.reason }),
						},
			);
		} catch (error) {
			if (requestId.current !== currentRequest) return;
			updateRuntime({
				status: "error",
				message: error instanceof Error ? error.message : "ComfyUI failed to start.",
			});
		}
	}, [updateRuntime]);

	useEffect(() => {
		const unsubscribe = window.kastard.comfy.onStateChange(updateRuntime);
		void startRuntime();
		return () => {
			requestId.current += 1;
			unsubscribe();
		};
	}, [startRuntime, updateRuntime]);

	useEffect(() => {
		let active = true;
		void window.kastard.comfyVersions
			.getState()
			.then((result) => {
				if (active && result.ok) setVersions(result.state);
			})
			.catch(() => undefined);
		const unsubscribe = window.kastard.comfyVersions.onStateChange(setVersions);
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	const retry = useCallback(() => {
		void startRuntime();
	}, [startRuntime]);

	if (runtime.status !== "ready" && runtime.status !== "error") {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center bg-background text-muted-foreground">
				<div className="flex w-72 flex-col gap-3 text-sm">
					<div className="flex items-center justify-center gap-2">
						<LoaderCircleIcon className="size-4 animate-spin" />
						<span>{runtimeMessage(runtime)}</span>
					</div>
					{versions === null ? null : (
						<p className="text-center text-xs">
							Backend {versions.selection.backend ?? versions.bundled.backend} ·
							Frontend {versions.selection.frontend ?? versions.bundled.frontend} ·
							Manager{" "}
							{versions.selection.manager ??
								versions.recommendedManager ??
								versions.bundled.manager}
						</p>
					)}
					{versions?.install.status === "installing" ? (
						<p className="text-center text-xs">
							Downloading {versions.install.component} {versions.install.version} ·{" "}
							{versions.install.progress}%
						</p>
					) : null}
					{runtime.status === "preparing" ? (
						<>
							<ProgressBar label="ComfyUI startup progress" value={runtime.progress} />
							{runtime.firstRun ? (
								<p className="text-center text-xs leading-relaxed">
									The first launch downloads Python and PyTorch and may take a few
									minutes.
								</p>
							) : null}
						</>
					) : null}
				</div>
			</div>
		);
	}

	if (runtime.status === "error") {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
				<div className="flex max-w-md flex-col items-center gap-3 text-center">
					<AlertTriangleIcon className="size-8 text-destructive" />
					<div>
						<h2 className="font-medium">Couldn&apos;t open ComfyUI</h2>
						<p className="mt-1 text-sm text-muted-foreground" role="alert">
							{runtime.message}
						</p>
					</div>
					<Button type="button" variant="outline" size="sm" onClick={retry}>
						<RotateCwIcon />
						Try again
					</Button>
				</div>
			</div>
		);
	}

	return (
		<iframe
			key={modelLibraryRevision}
			src={runtime.url}
			title="ComfyUI"
			className="min-h-0 flex-1 border-0 bg-neutral-900"
			allow="clipboard-read; clipboard-write"
		/>
	);
}

function runtimeMessage(
	state: Exclude<ComfyRuntimeState, { status: "ready" | "error" }>,
): string {
	if (state.status === "preparing") {
		return state.phase === "python"
			? "Preparing Python…"
			: "Installing ComfyUI dependencies…";
	}
	return state.status === "starting" ? "Starting ComfyUI…" : "Preparing ComfyUI…";
}
