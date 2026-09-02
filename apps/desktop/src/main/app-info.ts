import { release } from "node:os";
import type { ReleaseChannel } from "@kastard/common";
import { app } from "electron";
import desktopPackage from "../../package.json" with { type: "json" };
import type { DesktopAppInfo } from "../shared/api";

type DesktopEnvironment = DesktopAppInfo["environment"];

function readDesktopEnvironment(): DesktopEnvironment {
	return {
		os: process.platform,
		osVersion: process.getSystemVersion?.() ?? release(),
		arch: process.arch,
		electronVersion: process.versions.electron ?? "unknown",
		chromeVersion: process.versions.chrome ?? "unknown",
		nodeVersion: process.versions.node,
	};
}

export function readDesktopChannel(
	mode: string = import.meta.env.MODE,
	isPackaged: boolean = app.isPackaged,
): ReleaseChannel {
	if (mode === "beta") return "beta";
	return isPackaged ? "production" : "development";
}

export function readDesktopAppInfo(
	environment: DesktopEnvironment = readDesktopEnvironment(),
	channel: ReleaseChannel = readDesktopChannel(),
): DesktopAppInfo {
	return {
		version: app.getVersion(),
		buildNumber: desktopPackage.build.buildVersion,
		channel,
		environment,
	};
}
