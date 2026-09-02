import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { ServerLogEntry } from "../../../shared/api";

export const SERVER_LOG_POLL_MS = 1_000;

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
});

const levelClassNames: Record<ServerLogEntry["level"], string> = {
	info: "font-semibold text-info",
	warning: "font-semibold text-warning",
	error: "font-semibold text-destructive",
};

type CopyState =
	| { status: "idle" | "copying" }
	| { status: "success" | "error"; message: string };

export function ServerLogsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
	const [logs, setLogs] = useState<ServerLogEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copyState, setCopyState] = useState<CopyState>({ status: "idle" });
	const scrollArea = useRef<HTMLDivElement>(null);
	const logContents = useRef<HTMLOListElement>(null);
	const followLogs = useRef(true);
	const copyOperation = useRef(0);

	useEffect(() => {
		if (!open) return;
		let active = true;
		let timer: number | null = null;
		copyOperation.current += 1;
		followLogs.current = true;
		setLogs([]);
		setLoading(true);
		setTruncated(false);
		setError(null);
		setCopyState({ status: "idle" });

		const poll = async (): Promise<void> => {
			try {
				const result = await window.kastard.connection.getLogs();
				if (!active) return;
				if (result.ok) {
					setLogs(result.logs);
					setTruncated(result.truncated);
					setError(null);
				} else {
					setError(result.error);
				}
			} catch (pollError) {
				if (active) setError(errorMessage(pollError));
			} finally {
				if (active) {
					setLoading(false);
					timer = window.setTimeout(() => void poll(), SERVER_LOG_POLL_MS);
				}
			}
		};

		void poll();
		return () => {
			active = false;
			copyOperation.current += 1;
			if (timer !== null) window.clearTimeout(timer);
		};
	}, [open]);

	useLayoutEffect(() => {
		const area = scrollArea.current;
		if (!open || logs.length === 0 || area === null || !followLogs.current) return;
		area.scrollTop = area.scrollHeight;
	}, [open, logs.length]);

	const copyAll = async (): Promise<void> => {
		if (logs.length === 0) return;
		const operation = ++copyOperation.current;
		setCopyState({ status: "copying" });
		try {
			const result = await window.kastard.connection.copyServerLogs(
				formatServerLogs(logs),
			);
			if (operation !== copyOperation.current) return;
			setCopyState(
				result.ok
					? { status: "success", message: "Worker logs copied." }
					: { status: "error", message: result.error },
			);
		} catch (copyError) {
			if (operation !== copyOperation.current) return;
			setCopyState({ status: "error", message: errorMessage(copyError) });
		}
	};

	const selectAllLogs = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		if (
			event.key.toLowerCase() !== "a" ||
			(!event.metaKey && !event.ctrlKey) ||
			event.altKey
		) {
			return;
		}
		const contents = logContents.current;
		const selection = window.getSelection();
		if (contents === null || selection === null) return;

		event.preventDefault();
		const range = document.createRange();
		range.selectNodeContents(contents);
		selection.removeAllRanges();
		selection.addRange(range);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl" onKeyDown={selectAllLogs}>
				<DialogHeader>
					<DialogTitle>Worker logs</DialogTitle>
					<DialogDescription>
						Worker activity and ComfyUI output recorded since this connection started.
					</DialogDescription>
				</DialogHeader>
				{truncated ? (
					<p className="cursor-text select-text text-sm text-warning" role="status">
						Some older logs are no longer available.
					</p>
				) : null}
				{error ? (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				) : null}
				<div
					ref={scrollArea}
					data-testid="server-log-list"
					className="h-80 overflow-y-auto rounded-lg border bg-background/60 p-3 font-mono text-xs"
					role="log"
					aria-busy={loading}
					aria-live="polite"
					onScroll={(event) => {
						const area = event.currentTarget;
						followLogs.current =
							area.scrollHeight - area.scrollTop - area.clientHeight <= 16;
					}}
				>
					{loading && logs.length === 0 ? (
						<p className="cursor-text select-text text-muted-foreground">
							Loading Worker logs…
						</p>
					) : logs.length === 0 ? (
						<p className="cursor-text select-text text-muted-foreground">
							No logs recorded for this connection yet.
						</p>
					) : (
						<ol ref={logContents} className="grid gap-2">
							{logs.map((entry) => (
								<li
									key={entry.id}
									className="grid cursor-text select-text grid-cols-[auto_auto_1fr] items-start gap-2"
								>
									<time dateTime={entry.timestamp} className="text-muted-foreground">
										{formatTimestamp(entry.timestamp)}
									</time>
									<span className={levelClassNames[entry.level]}>
										{entry.level.toUpperCase()}
									</span>
									<span className="break-words whitespace-pre-wrap">
										{entry.message}
									</span>
								</li>
							))}
						</ol>
					)}
				</div>
				{copyState.status === "success" || copyState.status === "error" ? (
					<p
						className={
							copyState.status === "success"
								? "cursor-text select-text text-sm text-success"
								: "cursor-text select-text text-sm text-destructive"
						}
						role={copyState.status === "success" ? "status" : "alert"}
					>
						{copyState.message}
					</p>
				) : null}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={logs.length === 0 || copyState.status === "copying"}
						onClick={() => void copyAll()}
					>
						{copyState.status === "copying" ? "Copying…" : "Copy all"}
					</Button>
					<Button type="button" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? timestamp : timestampFormatter.format(date);
}

function formatServerLogs(logs: ServerLogEntry[]): string {
	return logs
		.map(
			(entry) =>
				`${formatTimestamp(entry.timestamp)} ${entry.level.toUpperCase()} ${entry.message}`,
		)
		.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
