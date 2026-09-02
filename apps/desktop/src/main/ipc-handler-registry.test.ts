// @vitest-environment node

import { expect, test, vi } from "vitest";
import { IpcHandlerRegistry } from "./ipc-handler-registry";

test("removes every registered IPC handler", () => {
	const ipcMain = {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	};
	const registry = new IpcHandlerRegistry(ipcMain);
	const firstHandler = vi.fn();
	const secondHandler = vi.fn();

	registry.handle("first", firstHandler);
	registry.handle("second", secondHandler);
	registry.removeAll();

	expect(ipcMain.handle).toHaveBeenNthCalledWith(1, "first", firstHandler);
	expect(ipcMain.handle).toHaveBeenNthCalledWith(2, "second", secondHandler);
	expect(ipcMain.removeHandler).toHaveBeenNthCalledWith(1, "first");
	expect(ipcMain.removeHandler).toHaveBeenNthCalledWith(2, "second");
});

test("does not remove handlers again after cleanup", () => {
	const ipcMain = {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	};
	const registry = new IpcHandlerRegistry(ipcMain);

	registry.handle("channel", vi.fn());
	registry.removeAll();
	registry.removeAll();

	expect(ipcMain.removeHandler).toHaveBeenCalledOnce();
});

test("does not track a handler when registration fails", () => {
	const ipcMain = {
		handle: vi.fn(() => {
			throw new Error("Already registered.");
		}),
		removeHandler: vi.fn(),
	};
	const registry = new IpcHandlerRegistry(ipcMain);

	expect(() => registry.handle("channel", vi.fn())).toThrow("Already registered.");
	registry.removeAll();

	expect(ipcMain.removeHandler).not.toHaveBeenCalled();
});
