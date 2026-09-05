// @vitest-environment node

import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import type { DownloadItem, Session, WebContents } from "electron";
import { expect, test, vi } from "vitest";
import { serializeComfyDownloads } from "./comfy-downloads";

const gateway = "http://127.0.0.1:18188/";

function fixture() {
	const session = new EventEmitter();
	const startDownload = vi.fn();
	const frame = {
		url: gateway,
		origin: new URL(gateway).origin,
		detached: false,
		processId: 10,
		routingId: 20,
		executeJavaScript: vi.fn(async (code: string) => {
			const link = {
				href: "",
				download: "",
				style: {},
				click: (): void => {
					startDownload(link.href, link.download);
				},
				remove: () => {},
			};
			runInNewContext(code, {
				document: {
					createElement: () => link,
					body: { appendChild: () => {} },
				},
			});
		}),
	};
	const owner = Object.assign(new EventEmitter(), {
		isDestroyed: vi.fn(() => false),
		mainFrame: { framesInSubtree: [frame] },
	});
	const onError = vi.fn(async () => {});
	const stop = serializeComfyDownloads(session as Session, () => gateway, onError);
	function download(filename: string, url = `${gateway}view?filename=${filename}`) {
		const event = { preventDefault: vi.fn() };
		const item = Object.assign(new EventEmitter(), {
			getURL: () => url,
			getFilename: () => filename,
			cancel: vi.fn(() => item.emit("done", {}, "cancelled")),
		});
		session.emit(
			"will-download",
			event,
			item as unknown as DownloadItem,
			owner as unknown as WebContents,
		);
		return { event, item };
	}
	return { owner, frame, startDownload, onError, stop, download };
}

test.each(["completed", "cancelled"])(
	"starts the next native asset download after the first is %s",
	(state) => {
		const { owner, startDownload, download, stop } = fixture();
		const video = download("result.mp4");
		const preview = download("preview.png");
		expect(video.event.preventDefault).not.toHaveBeenCalled();
		expect(preview.event.preventDefault).toHaveBeenCalledOnce();
		expect(startDownload).not.toHaveBeenCalled();
		video.item.emit("done", {}, state);
		expect(startDownload).toHaveBeenCalledExactlyOnceWith(
			`${gateway}view?filename=preview.png`,
			"preview.png",
		);
		const next = download("preview.png");
		expect(next.event.preventDefault).not.toHaveBeenCalled();
		next.item.emit("done", {}, "completed");
		stop();
		expect(owner.listenerCount("destroyed")).toBe(0);
		expect(owner.listenerCount("did-frame-navigate")).toBe(0);
	},
);

test("reports an interrupted download before continuing the native save flow", async () => {
	const { startDownload, onError, download, stop } = fixture();
	let closeErrorDialog = (): void => {};
	onError.mockReturnValue(
		new Promise<void>((resolve) => {
			closeErrorDialog = resolve;
		}),
	);
	const first = download("result.mp4");
	first.item.emit("done", {}, "interrupted");
	expect(onError).toHaveBeenCalledOnce();
	const second = download("preview.png");
	expect(second.event.preventDefault).toHaveBeenCalledOnce();
	expect(startDownload).not.toHaveBeenCalled();
	closeErrorDialog();
	await vi.waitFor(() => expect(startDownload).toHaveBeenCalledOnce());
	stop();
});

test("leaves downloads outside the ComfyUI file routes to Electron", () => {
	const { download, stop } = fixture();
	download("result.mp4");
	for (const url of [
		"https://example.com/result.mp4",
		`${gateway}userdata/workflow.json`,
		"blob:http://127.0.0.1:18188/example",
	]) {
		expect(download("file", url).event.preventDefault).not.toHaveBeenCalled();
	}
	stop();
});

test("cancels the active download and skips queued requests when their window closes", () => {
	const { owner, startDownload, download, stop } = fixture();
	const current = download("result.mp4");
	download("preview.png");
	owner.isDestroyed.mockReturnValue(true);
	owner.emit("destroyed");
	expect(current.item.cancel).toHaveBeenCalledOnce();
	expect(startDownload).not.toHaveBeenCalled();
	stop();
});

test("stops active and queued downloads during shutdown", () => {
	const { startDownload, download, stop } = fixture();
	const current = download("result.mp4");
	download("preview.png");
	stop();
	expect(current.item.cancel).toHaveBeenCalledOnce();
	expect(startDownload).not.toHaveBeenCalled();
});

test.each(["detached", "navigated"])(
	"drops a queued download when its ComfyUI frame is %s",
	(state) => {
		const { frame, startDownload, download, stop } = fixture();
		const first = download("result.mp4");
		download("preview.png");
		if (state === "detached") frame.detached = true;
		else {
			frame.url = "https://example.com/";
			frame.origin = "https://example.com";
		}
		first.item.emit("done", {}, "completed");
		expect(startDownload).not.toHaveBeenCalled();
		stop();
	},
);

test("preserves quoted filenames as data when starting a deferred download", () => {
	const { startDownload, download, stop } = fixture();
	const first = download("result.mp4");
	const filename = 'preview "one"\n.png';
	const url = `${gateway}view?filename=${encodeURIComponent(filename)}`;
	download(filename, url);
	first.item.emit("done", {}, "completed");
	expect(startDownload).toHaveBeenCalledExactlyOnceWith(url, filename);
	stop();
});

test.each([gateway, `${gateway}another-page`])(
	"discards queued downloads after their frame navigates to %s",
	(url) => {
		const { frame, owner, startDownload, download, stop } = fixture();
		const first = download("result.mp4");
		download("preview.png");
		frame.url = url;
		owner.emit(
			"did-frame-navigate",
			{},
			url,
			200,
			"OK",
			false,
			frame.processId,
			frame.routingId,
		);
		first.item.emit("done", {}, "completed");
		expect(startDownload).not.toHaveBeenCalled();
		stop();
	},
);

test("preserves queued downloads when a sibling frame navigates", () => {
	const { frame, owner, startDownload, download, stop } = fixture();
	const first = download("result.mp4");
	download("preview.png");
	owner.emit(
		"did-frame-navigate",
		{},
		`${gateway}another-page`,
		200,
		"OK",
		false,
		frame.processId,
		99,
	);
	first.item.emit("done", {}, "completed");
	expect(startDownload).toHaveBeenCalledExactlyOnceWith(
		`${gateway}view?filename=preview.png`,
		"preview.png",
	);
	stop();
});

test("discards queued downloads when the top-level document navigates", () => {
	const { owner, startDownload, download, stop } = fixture();
	const first = download("result.mp4");
	download("preview.png");
	owner.emit("did-frame-navigate", {}, "file:///example.html", -1, "", true, 1, 1);
	first.item.emit("done", {}, "completed");
	expect(startDownload).not.toHaveBeenCalled();
	stop();
});

test.each(["", "about:blank"])(
	"downloads from a frame with an inherited origin and URL %s",
	(url) => {
		const { frame, startDownload, download, stop } = fixture();
		frame.url = url;
		const first = download("result.mp4");
		const second = download("preview.png");
		expect(second.event.preventDefault).toHaveBeenCalledOnce();
		first.item.emit("done", {}, "completed");
		expect(startDownload).toHaveBeenCalledExactlyOnceWith(
			`${gateway}view?filename=preview.png`,
			"preview.png",
		);
		stop();
	},
);
