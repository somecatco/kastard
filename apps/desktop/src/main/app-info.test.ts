import { expect, test, vi } from "vitest";
import desktopPackage from "../../package.json" with { type: "json" };

const mocks = vi.hoisted(() => ({
	getVersion: vi.fn(() => "0.1.0"),
}));

vi.mock("electron", () => ({
	app: { getVersion: mocks.getVersion },
}));

const { readDesktopAppInfo, readDesktopChannel } = await import("./app-info");

test("resolves the Editor release channel", () => {
	expect(readDesktopChannel("beta", true)).toBe("beta");
	expect(readDesktopChannel("production", true)).toBe("production");
	expect(readDesktopChannel("development", false)).toBe("development");
});

test("reports the Editor application and runtime environment", () => {
	expect(
		readDesktopAppInfo(
			{
				os: "darwin",
				osVersion: "25.0.0",
				arch: "arm64",
				electronVersion: "43.4.0",
				chromeVersion: "144.0.7559.220",
				nodeVersion: "24.13.0",
			},
			"beta",
		),
	).toEqual({
		version: "0.1.0",
		buildNumber: desktopPackage.build.buildVersion,
		channel: "beta",
		environment: {
			os: "darwin",
			osVersion: "25.0.0",
			arch: "arm64",
			electronVersion: "43.4.0",
			chromeVersion: "144.0.7559.220",
			nodeVersion: "24.13.0",
		},
	});
});
