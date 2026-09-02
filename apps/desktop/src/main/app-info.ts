import { release } from "node:os";
import type { ReleaseChannel } from "@kastard/common";
import { app } from "electron";
import desktopPackage from "../../package.json" with { type: "json" };
import type { DesktopAppInfo } from "../shared/api";

declare const __KASTARD_PRODUCT_VERSION__: string;
declare const __KASTARD_SOURCE_REVISION__: string;

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
	if (mode === "preview") return "preview";
	return isPackaged ? "production" : "development";
}

function buildMetadata(): { productVersion: string; sourceRevision: string } {
	return {
		productVersion:
			typeof __KASTARD_PRODUCT_VERSION__ === "undefined"
				? ""
				: __KASTARD_PRODUCT_VERSION__,
		sourceRevision:
			typeof __KASTARD_SOURCE_REVISION__ === "undefined"
				? ""
				: __KASTARD_SOURCE_REVISION__,
	};
}

export function readDesktopAppInfo(
	environment: DesktopEnvironment = readDesktopEnvironment(),
	channel: ReleaseChannel = readDesktopChannel(),
	metadata: { productVersion: string; sourceRevision: string } = buildMetadata(),
): DesktopAppInfo {
	const buildNumber = desktopPackage.build.buildVersion;
	if (channel === "development") {
		return {
			buildNumber,
			channel,
			environment,
			productVersion: null,
			sourceRevision: null,
		};
	}
	if (!/^[0-9a-f]{40}$/.test(metadata.sourceRevision)) {
		throw new Error("The packaged Editor must contain a full source revision.");
	}
	if (channel === "preview") {
		return {
			buildNumber,
			channel,
			environment,
			productVersion: null,
			sourceRevision: metadata.sourceRevision,
		};
	}
	const productVersion = metadata.productVersion;
	if (!/^\d+\.\d+\.\d+$/.test(productVersion)) {
		throw new Error("The Production Editor must contain a product version.");
	}
	if (productVersion !== app.getVersion()) {
		throw new Error(
			"The Production Editor product version must match its app bundle version.",
		);
	}
	return {
		buildNumber,
		channel,
		environment,
		productVersion,
		sourceRevision: metadata.sourceRevision,
	};
}
