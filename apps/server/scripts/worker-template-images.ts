import { resolve } from "node:path";
import {
	type WorkerTemplateChannel,
	type WorkerTemplateRuntime,
	workerTemplateName,
	workerTemplateRuntimes,
} from "@kastard/common";

export { type WorkerTemplateChannel, workerTemplateName };

export const workerRuntimes = workerTemplateRuntimes;
export type WorkerRuntime = WorkerTemplateRuntime;
export type WorkerImages = Record<WorkerRuntime, string>;

const workerImageScript = resolve(import.meta.dir, "../../../scripts/worker-image.sh");

function matchesRuntime(image: string, runtime: WorkerRuntime): boolean {
	const lastSlash = image.lastIndexOf("/");
	const tagSeparator = image.lastIndexOf(":");
	const repository = tagSeparator > lastSlash ? image.slice(0, tagSeparator) : image;
	const tag = tagSeparator > lastSlash ? image.slice(tagSeparator + 1) : "";
	return repository.endsWith(`-${runtime}`) || tag.endsWith(`-${runtime}`);
}

export function parseImagePairs(output: string): WorkerImages {
	const images = new Map<string, string>();
	for (const line of output.trim().split("\n")) {
		if (line.length === 0) continue;
		const [runtime, image, extra] = line.split("\t");
		if (extra !== undefined || runtime === undefined || image === undefined) {
			throw new Error("Worker image command returned an unexpected result.");
		}
		if (!workerRuntimes.includes(runtime as WorkerRuntime) || images.has(runtime)) {
			throw new Error("Worker image command returned an unexpected result.");
		}
		images.set(runtime, image);
	}

	const result = Object.fromEntries(images) as Partial<WorkerImages>;
	for (const runtime of workerRuntimes) {
		const image = result[runtime];
		if (image === undefined || !matchesRuntime(image, runtime)) {
			throw new Error(`Missing ${runtime} Worker image.`);
		}
	}
	return result as WorkerImages;
}

export function parseWorkerImageArguments(
	args: string[],
	command: string,
): WorkerTemplateChannel {
	const [channelArgument, ...imageArguments] = args;
	const channel =
		channelArgument === "--preview"
			? "preview"
			: channelArgument === "--production"
				? "production"
				: null;
	if (channel !== null && imageArguments.length === 0) return channel;
	throw new Error(`Usage: bun ${command} <--preview | --production>`);
}

export async function resolveWorkerImages(
	channel: WorkerTemplateChannel,
): Promise<WorkerImages> {
	const args = ["bash", workerImageScript, `--${channel}`, "--print-images"];
	const proc = Bun.spawn(args);
	const output = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) {
		throw new Error("Could not derive the Worker release image names.");
	}
	return parseImagePairs(output);
}

export function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is not set. Add it to .env in the repository root.`);
	}
	return value;
}

export async function requirePushedWorkerImages(images: WorkerImages): Promise<void> {
	await Promise.all(
		workerRuntimes.map(async (runtime) => {
			const image = images[runtime];
			const proc = Bun.spawn(["docker", "manifest", "inspect", "--", image], {
				stdout: "ignore",
			});
			if ((await proc.exited) !== 0) {
				throw new Error(
					`${image} was not found in the registry. Push the matching Worker release image first.`,
				);
			}
		}),
	);
}
