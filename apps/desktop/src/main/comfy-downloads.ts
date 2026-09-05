import type { DownloadItem, Event, Session, WebContents, WebFrameMain } from "electron";

export function serializeComfyDownloads(
	session: Session,
	getGatewayUrl: () => string | null,
	onError: () => Promise<void>,
): () => void {
	const pending: Array<{
		url: string;
		filename: string;
		frame: WebFrameMain;
		webContents: WebContents;
	}> = [];
	let active: DownloadItem | null = null;
	let stopped = false;
	let showingError = false;

	const next = (): void => {
		if (stopped || active !== null || showingError) return;
		const request = pending.shift();
		if (request === undefined) return;
		try {
			if (
				request.webContents.isDestroyed() ||
				request.frame.detached ||
				!isComfyFile(request.url, getGatewayUrl()) ||
				new URL(request.frame.url).origin !== new URL(request.url).origin
			) {
				next();
				return;
			}
			// Keep the iframe's origin and the filename supplied by ComfyUI.
			void request.frame
				.executeJavaScript(
					`{
				const link = document.createElement("a");
				link.href = ${JSON.stringify(request.url)};
				link.download = ${JSON.stringify(request.filename)};
				link.style.display = "none";
				document.body.appendChild(link);
				link.click();
				link.remove();
			}`,
					true,
				)
				.catch(reportFailure);
		} catch {
			void reportFailure();
		}
	};

	const reportFailure = async (): Promise<void> => {
		if (stopped) return;
		showingError = true;
		try {
			await onError();
		} catch {
			// The window may close while its error dialog is open.
		} finally {
			showingError = false;
			next();
		}
	};

	const willDownload = (
		event: Event,
		item: DownloadItem,
		webContents: WebContents,
	): void => {
		if (webContents === undefined || !isComfyFile(item.getURL(), getGatewayUrl()))
			return;
		if (active !== null || showingError) {
			// Concurrent native save sheets can strand downloads on macOS.
			const url = item.getURL();
			const frame = webContents.mainFrame.framesInSubtree.find((frame) => {
				try {
					return new URL(frame.url).origin === new URL(url).origin;
				} catch {
					return false;
				}
			});
			if (frame !== undefined)
				pending.push({ url, filename: item.getFilename(), frame, webContents });
			event.preventDefault();
			return;
		}
		active = item;
		const cancel = (): void => item.cancel();
		webContents.once("destroyed", cancel);
		item.once("done", (_event, state) => {
			webContents.removeListener("destroyed", cancel);
			active = null;
			if (stopped) return;
			if (state === "interrupted") void reportFailure();
			else next();
		});
	};

	session.on("will-download", willDownload);
	return () => {
		stopped = true;
		pending.length = 0;
		session.removeListener("will-download", willDownload);
		active?.cancel();
		active = null;
	};
}

function isComfyFile(value: string, gatewayUrl: string | null): boolean {
	if (gatewayUrl === null) return false;
	try {
		const url = new URL(value);
		return (
			url.origin === new URL(gatewayUrl).origin &&
			/^\/(?:api\/)?(?:view|viewvideo)$/.test(url.pathname)
		);
	} catch {
		return false;
	}
}
