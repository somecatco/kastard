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
	const navigationCleanups = new Map<WebContents, () => void>();
	let active: DownloadItem | null = null;
	let stopped = false;
	let showingError = false;

	const watchNavigation = (webContents: WebContents): void => {
		if (navigationCleanups.has(webContents)) return;
		const navigated = (
			_event: Event,
			_url: string,
			_statusCode: number,
			_statusText: string,
			isMainFrame: boolean,
			processId: number,
			routingId: number,
		): void => {
			for (let index = pending.length - 1; index >= 0; index -= 1) {
				const request = pending[index];
				if (
					request?.webContents === webContents &&
					(isMainFrame ||
						request.frame.detached ||
						(request.frame.processId === processId &&
							request.frame.routingId === routingId))
				)
					pending.splice(index, 1);
			}
		};
		const cleanup = (): void => {
			webContents.removeListener("did-frame-navigate", navigated);
			webContents.removeListener("destroyed", cleanup);
			navigationCleanups.delete(webContents);
		};
		navigationCleanups.set(webContents, cleanup);
		webContents.on("did-frame-navigate", navigated);
		webContents.once("destroyed", cleanup);
	};

	const next = (): void => {
		if (stopped || active !== null || showingError) return;
		const request = pending.shift();
		if (request === undefined) return;
		try {
			if (
				request.webContents.isDestroyed() ||
				request.frame.detached ||
				!isComfyFile(request.url, getGatewayUrl()) ||
				request.frame.origin !== new URL(request.url).origin
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
					return frame.origin === new URL(url).origin;
				} catch {
					return false;
				}
			});
			if (frame !== undefined) {
				watchNavigation(webContents);
				pending.push({ url, filename: item.getFilename(), frame, webContents });
			}
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
		for (const cleanup of navigationCleanups.values()) cleanup();
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
