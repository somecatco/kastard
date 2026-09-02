import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { MENU_OPEN_SETTINGS_CHANNEL } from "../shared/api";

function targetWindow(): BrowserWindow | undefined {
	return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function sendOpenSettings(window: BrowserWindow, revealWindows: boolean): void {
	if (!window.isDestroyed()) {
		if (revealWindows) {
			if (window.isMinimized()) window.restore();
			if (!window.isVisible()) window.show();
			window.focus();
		}
		window.webContents.send(MENU_OPEN_SETTINGS_CHANNEL);
	}
}

function openSettings(createWindow: () => BrowserWindow, revealWindows: boolean): void {
	const window = targetWindow();
	if (window) {
		if (window.webContents.isLoadingMainFrame()) {
			window.webContents.once("did-finish-load", () =>
				sendOpenSettings(window, revealWindows),
			);
		} else {
			sendOpenSettings(window, revealWindows);
		}
		return;
	}

	const createdWindow = createWindow();
	createdWindow.once("ready-to-show", () =>
		sendOpenSettings(createdWindow, revealWindows),
	);
}

export function installAppMenu(
	createWindow: () => BrowserWindow,
	revealWindows: boolean,
): void {
	if (process.platform !== "darwin") return;

	const appMenu: MenuItemConstructorOptions = {
		label: app.name,
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{
				id: "settings",
				label: "Settings…",
				accelerator: "CmdOrCtrl+,",
				click: () => openSettings(createWindow, revealWindows),
			},
			{ type: "separator" },
			{ role: "services" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "unhide" },
			{ type: "separator" },
			{ role: "quit" },
		],
	};
	const template: MenuItemConstructorOptions[] = [
		appMenu,
		{ role: "fileMenu" },
		{ role: "editMenu" },
		{ role: "viewMenu" },
		{ role: "windowMenu" },
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
