import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import type { CustomNodeErrorLog } from "../../../shared/api";

export function CustomNodeSyncIssue({
	name,
	issue,
	errorLog,
}: {
	name: string;
	issue: string;
	errorLog: CustomNodeErrorLog | undefined;
}): React.JSX.Element {
	const [openLog, setOpenLog] = useState<CustomNodeErrorLog | null>(null);
	return (
		<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
			<span className="select-text text-xs text-warning">Worker sync unavailable</span>
			<Dialog
				open={openLog !== null}
				onOpenChange={(open) =>
					setOpenLog(open ? (errorLog ?? { text: issue, truncated: false }) : null)
				}
			>
				<DialogTrigger asChild>
					<Button type="button" variant="outline" size="xs">
						View error log
					</Button>
				</DialogTrigger>
				{openLog !== null ? (
					<CustomNodeErrorLogDialog
						name={name}
						log={openLog}
						onClose={() => setOpenLog(null)}
					/>
				) : null}
			</Dialog>
		</div>
	);
}

function CustomNodeErrorLogDialog({
	name,
	log,
	onClose,
}: {
	name: string;
	log: CustomNodeErrorLog;
	onClose: () => void;
}): React.JSX.Element {
	const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">(
		"idle",
	);
	const copyLogs = async (): Promise<void> => {
		setCopyState("copying");
		const text = log.truncated
			? `Some error output is unavailable.\n\n${log.text}`
			: log.text;
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
				<DialogTitle>Custom node error log</DialogTitle>
				<DialogDescription>{name}</DialogDescription>
			</DialogHeader>
			{log.truncated ? (
				<p className="shrink-0 select-text text-sm text-warning" role="status">
					Some error output is unavailable.
				</p>
			) : null}
			<textarea
				aria-label="Error log output"
				readOnly
				value={log.text}
				className="h-64 min-h-0 resize-none cursor-text select-text overflow-auto rounded-lg border bg-background/60 p-4 font-mono text-xs leading-6 outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
