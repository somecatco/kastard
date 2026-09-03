import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { notarize } from "@electron/notarize";

const retryDelays = [15_000, 30_000];
const unexpectedResultPattern =
	/Failed to notarize via notarytool\.\s+Failed with unexpected result:/;

const pause = (milliseconds) =>
	new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function requiredEnvironmentVariable(environment, name) {
	const value = environment[name];
	if (!value) {
		throw new Error(`Missing environment variable required for notarization: ${name}.`);
	}
	return value;
}

export async function notarizeWithRetry(
	artifactPath,
	{
		environment = process.env,
		notarizeArtifact = notarize,
		wait = pause,
		warn = console.warn,
	} = {},
) {
	const options = {
		appPath: resolve(artifactPath),
		appleApiKey: requiredEnvironmentVariable(environment, "APPLE_API_KEY"),
		appleApiKeyId: requiredEnvironmentVariable(environment, "APPLE_API_KEY_ID"),
		appleApiIssuer: requiredEnvironmentVariable(environment, "APPLE_API_ISSUER"),
	};

	for (let attempt = 0; ; attempt += 1) {
		try {
			await notarizeArtifact(options);
			return;
		} catch (error) {
			const retryDelay = retryDelays[attempt];
			const message = error instanceof Error ? error.message : String(error);
			if (retryDelay === undefined || !unexpectedResultPattern.test(message)) {
				throw error;
			}

			warn(
				`Notarization returned an unreadable result on attempt ${attempt + 1}; retrying in ${retryDelay / 1000} seconds.`,
			);
			await wait(retryDelay);
		}
	}
}

export async function afterSign(context) {
	if (context.electronPlatformName !== "darwin") {
		return;
	}

	const appPath = resolve(
		context.appOutDir,
		`${context.packager.appInfo.productFilename}.app`,
	);
	await notarizeWithRetry(appPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [artifactPath, ...unexpectedArguments] = process.argv.slice(2);
	if (!artifactPath || unexpectedArguments.length > 0) {
		throw new Error("Usage: node scripts/notarize.mjs <artifact-path>");
	}
	await notarizeWithRetry(artifactPath);
}
