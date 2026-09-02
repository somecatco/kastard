import type { IpcMain } from "electron";

type IpcMainHandlers = Pick<IpcMain, "handle" | "removeHandler">;

export class IpcHandlerRegistry {
	private readonly channels = new Set<string>();

	constructor(private readonly ipcMain: IpcMainHandlers) {}

	handle(...args: Parameters<IpcMain["handle"]>): void {
		this.ipcMain.handle(...args);
		this.channels.add(args[0]);
	}

	removeAll(): void {
		for (const channel of this.channels) this.ipcMain.removeHandler(channel);
		this.channels.clear();
	}
}
