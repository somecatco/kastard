import { expect, test, vi } from "vitest";
import desktopPackage from "../../package.json" with { type: "json" };

const mocks = vi.hoisted(() => ({
	getVersion: vi.fn(() => "0.2.0"),
}));

vi.mock("electron", () => ({
	app: { getVersion: mocks.getVersion },
}));

const { readDesktopAppInfo, readDesktopChannel } = await import("./app-info");
const sourceRevision = "a".repeat(40);

test("resolves the Editor release channel", () => {
	expect(readDesktopChannel("preview", true)).toBe("preview");
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
			"preview",
			{ productVersion: "", sourceRevision },
		),
	).toEqual({
		buildNumber: desktopPackage.build.buildVersion,
		channel: "preview",
		productVersion: null,
		sourceRevision,
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

test("reports a Production version separately from its build number", () => {
	const info = readDesktopAppInfo(
		{
			os: "darwin",
			osVersion: "25.0.0",
			arch: "arm64",
			electronVersion: "43.4.0",
			chromeVersion: "144.0.7559.220",
			nodeVersion: "24.13.0",
		},
		"production",
		{ productVersion: "0.2.0", sourceRevision },
	);
	expect(info).toMatchObject({
		buildNumber: desktopPackage.build.buildVersion,
		channel: "production",
		productVersion: "0.2.0",
		sourceRevision,
	});
});

test("requires the Production version to match the app bundle", () => {
	mocks.getVersion.mockReturnValueOnce("0.1.0");
	expect(() =>
		readDesktopAppInfo(undefined, "production", {
			productVersion: "0.2.0",
			sourceRevision,
		}),
	).toThrow("must match its app bundle version");
});

test("rejects incomplete packaged Editor metadata", () => {
	expect(() =>
		readDesktopAppInfo(undefined, "preview", {
			productVersion: "",
			sourceRevision: "",
		}),
	).toThrow("full source revision");
	expect(() =>
		readDesktopAppInfo(undefined, "production", {
			productVersion: "",
			sourceRevision,
		}),
	).toThrow("product version");
});
