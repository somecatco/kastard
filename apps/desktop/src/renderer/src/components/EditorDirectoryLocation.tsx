import { FolderOpenIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { selectTextOnTripleClick } from "@/lib/text-selection";
import type { EditorDirectory } from "../../../shared/api";

export function EditorDirectoryLocation({
	directory,
}: {
	directory: EditorDirectory;
}): React.JSX.Element {
	const [path, setPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [opening, setOpening] = useState(false);
	const modelLibrary = directory === "model-library";
	const label =
		directory === "comfy" ? "ComfyUI" : modelLibrary ? "Model Library" : "Custom Nodes";
	const description = modelLibrary
		? "Kastard manages this folder and replaces its contents during model sync. Do not add files here directly."
		: directory === "custom-nodes"
			? "Kastard detects Custom Nodes installed directly in this folder or through ComfyUI Manager."
			: null;
	const descriptionId = `${directory}-location-description`;

	useEffect(() => {
		let active = true;
		setPath(null);
		setError(null);
		void window.kastard.editorDirectories
			.get(directory)
			.then((result) => {
				if (!active) return;
				if (result.ok) setPath(result.path);
				else setError(result.error);
			})
			.catch((error: unknown) => {
				if (active) setError(errorMessage(error));
			});
		return () => {
			active = false;
		};
	}, [directory]);

	const openDirectory = async (): Promise<void> => {
		if (path === null || opening) return;
		setOpening(true);
		setError(null);
		try {
			const result = await window.kastard.editorDirectories.open(directory);
			if (!result.ok) setError(result.error);
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setOpening(false);
		}
	};

	return (
		<div className="mt-3 space-y-2">
			{path === null && error === null ? (
				<p
					className="flex items-center gap-2 text-xs text-muted-foreground"
					role="status"
				>
					<LoaderCircleIcon className="size-3.5 animate-spin" />
					Loading location…
				</p>
			) : path === null ? (
				<p className="cursor-text select-text text-xs text-destructive" role="alert">
					{error}
				</p>
			) : (
				<>
					{description ? (
						<p
							id={descriptionId}
							className="cursor-text select-text text-xs text-muted-foreground"
						>
							{description}
						</p>
					) : null}
					<div className="flex items-center gap-3">
						{/* biome-ignore lint/a11y/noStaticElementInteractions: Triple-click refines native text selection rather than adding a control. */}
						<span
							className="block min-w-0 flex-1 cursor-text select-text break-all font-mono text-xs text-muted-foreground"
							onMouseDown={selectTextOnTripleClick}
						>
							{path}
						</span>
						<Button
							type="button"
							variant="outline"
							size="default"
							className="shrink-0"
							aria-label={`Open folder for ${label}`}
							aria-describedby={description ? descriptionId : undefined}
							disabled={opening}
							onClick={() => void openDirectory()}
						>
							{opening ? (
								<LoaderCircleIcon className="animate-spin" />
							) : (
								<FolderOpenIcon />
							)}
							Open folder
						</Button>
					</div>
					{error !== null ? (
						<p
							className="cursor-text select-text text-xs text-destructive"
							role="alert"
						>
							{error}
						</p>
					) : null}
				</>
			)}
		</div>
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "The folder request failed.";
}
