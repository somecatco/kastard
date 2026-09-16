import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { ComfyStartupFailure } from "../../../shared/api";

export function ComfyStartupLogsDialog({
	failure,
	onClose,
}: {
	failure: ComfyStartupFailure;
	onClose: () => void;
}): React.JSX.Element {
	const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">(
		"idle",
	);
	const copyLogs = async (): Promise<void> => {
		setCopyState("copying");
		const text = [
			failure.message,
			failure.truncated ? "Some startup output is unavailable." : "",
			failure.logs,
		]
			.filter(Boolean)
			.join("\n\n");
		try {
			const result = await window.kastard.comfy.copyLogs(text);
			setCopyState(result.ok ? "copied" : "error");
		} catch {
			setCopyState("error");
		}
	};

	return (
		<DialogContent className="flex max-h-[calc(100svh-32px)] w-[calc(100%-32px)] max-w-3xl flex-col gap-4">
			<DialogHeader className="shrink-0 pr-6">
				<DialogTitle>ComfyUI startup logs</DialogTitle>
				<DialogDescription>
					Logs from the failed local startup attempt.
				</DialogDescription>
			</DialogHeader>
			<p className="max-h-28 shrink-0 cursor-text select-text overflow-auto whitespace-pre-wrap break-words rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				{failure.message}
			</p>
			{failure.truncated ? (
				<p
					className="shrink-0 cursor-text select-text text-sm text-warning"
					role="status"
				>
					Some startup output is unavailable.
				</p>
			) : null}
			<textarea
				aria-label="Startup log output"
				readOnly
				value={failure.logs || "No output was recorded for this startup attempt."}
				className="h-80 min-h-0 resize-none cursor-text select-text overflow-auto rounded-lg border bg-background/60 p-4 font-mono text-xs leading-6 outline-none focus-visible:ring-1 focus-visible:ring-ring"
			/>
			{copyState === "error" ? (
				<p className="shrink-0 text-sm text-destructive" role="alert">
					Couldn&apos;t copy logs. Select the text to copy it manually.
				</p>
			) : null}
			<DialogFooter className="shrink-0">
				<span className="sr-only" role="status">
					{copyState === "copied" ? "Logs copied." : ""}
				</span>
				<Button
					type="button"
					variant="outline"
					disabled={copyState === "copying"}
					onClick={() => void copyLogs()}
				>
					{copyState === "copying"
						? "Copying…"
						: copyState === "copied"
							? "Copied"
							: "Copy all"}
				</Button>
				<Button type="button" onClick={onClose}>
					Close
				</Button>
			</DialogFooter>
		</DialogContent>
	);
}
