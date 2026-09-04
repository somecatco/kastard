import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

export const workerTemplateRuntimes = ["cu128", "cu130"] as const;
export type WorkerTemplateRuntime = (typeof workerTemplateRuntimes)[number];

export const workerTemplateChannels = ["production", "preview"] as const;
export type WorkerTemplateChannel = (typeof workerTemplateChannels)[number];

type RuntimeValues<T> = Record<WorkerTemplateRuntime, T>;
type ChannelValues<T> = Record<WorkerTemplateChannel, RuntimeValues<T>>;

export type Resources = {
	github: string;
	downloads: {
		editorMacArm64: string;
	};
	docs: {
		home: string;
		gettingStarted: string;
		runWorkerWithDocker: string;
		editAndRunWorkflows: string;
		addModelsAndCustomNodes: string;
	};
	discord: string;
	comfyRegistry: {
		api: string;
	};
	dockerHub: RuntimeValues<string>;
	workerTemplates: {
		runpod: { hub: string } & ChannelValues<string>;
		vastAi: {
			marketplace: string;
			creatorId: number;
		} & ChannelValues<number>;
	};
};

export function parseResources(source: string): Resources {
	const errors: ParseError[] = [];
	const value: unknown = parse(source, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const details = errors
			.map(({ error, offset }) => `${printParseErrorCode(error)} at ${offset}`)
			.join(", ");
		throw new Error(`Invalid resources.jsonc: ${details}`);
	}

	const resources = record(value, "resources.jsonc");
	const downloads = record(resources.downloads, "downloads");
	const docs = record(resources.docs, "docs");
	const comfyRegistry = record(resources.comfyRegistry, "comfyRegistry");
	const dockerHub = runtimeValues(resources.dockerHub, "dockerHub", nonEmptyString);
	const workerTemplates = record(resources.workerTemplates, "workerTemplates");
	const runpod = record(workerTemplates.runpod, "workerTemplates.runpod");
	const vastAi = record(workerTemplates.vastAi, "workerTemplates.vastAi");
	const runpodIds = channelValues(runpod, "workerTemplates.runpod", runpodId);
	const vastAiIds = channelValues(vastAi, "workerTemplates.vastAi", positiveInteger);
	ensureUniqueIds("runpod", runpodIds);
	ensureUniqueIds("vastAi", vastAiIds);

	return {
		github: httpsUrl(resources.github, "github"),
		downloads: {
			editorMacArm64: httpsUrl(downloads.editorMacArm64, "downloads.editorMacArm64"),
		},
		docs: {
			home: httpsUrl(docs.home, "docs.home"),
			gettingStarted: httpsUrl(docs.gettingStarted, "docs.gettingStarted"),
			runWorkerWithDocker: httpsUrl(
				docs.runWorkerWithDocker,
				"docs.runWorkerWithDocker",
			),
			editAndRunWorkflows: httpsUrl(
				docs.editAndRunWorkflows,
				"docs.editAndRunWorkflows",
			),
			addModelsAndCustomNodes: httpsUrl(
				docs.addModelsAndCustomNodes,
				"docs.addModelsAndCustomNodes",
			),
		},
		discord: httpsUrl(resources.discord, "discord"),
		comfyRegistry: {
			api: httpsUrl(comfyRegistry.api, "comfyRegistry.api"),
		},
		dockerHub,
		workerTemplates: {
			runpod: {
				hub: httpsUrl(runpod.hub, "workerTemplates.runpod.hub"),
				...runpodIds,
			},
			vastAi: {
				marketplace: httpsUrl(vastAi.marketplace, "workerTemplates.vastAi.marketplace"),
				creatorId: positiveInteger(
					vastAi.creatorId,
					"workerTemplates.vastAi.creatorId",
				),
				...vastAiIds,
			},
		},
	};
}

export function workerTemplateName(
	runtime: WorkerTemplateRuntime,
	channel: WorkerTemplateChannel,
): string {
	return `kastard-worker${channel === "preview" ? "-preview" : ""}-${runtime}`;
}

export function createWorkerTemplateLinks(
	resources: Resources,
	provider: "runpod" | "vastAi",
	channel: WorkerTemplateChannel,
): RuntimeValues<string> {
	if (provider === "runpod") {
		const baseUrl = `${resources.workerTemplates.runpod.hub}/`;
		const ids = resources.workerTemplates.runpod[channel];
		return {
			cu128: new URL(ids.cu128, baseUrl).toString(),
			cu130: new URL(ids.cu130, baseUrl).toString(),
		};
	}

	const templateUrl = (runtime: WorkerTemplateRuntime): string => {
		const url = new URL(resources.workerTemplates.vastAi.marketplace);
		url.searchParams.set(
			"creator_id",
			String(resources.workerTemplates.vastAi.creatorId),
		);
		url.searchParams.set("name", workerTemplateName(runtime, channel));
		return url.toString();
	};
	return {
		cu128: templateUrl("cu128"),
		cu130: templateUrl("cu130"),
	};
}

function channelValues<T extends string | number>(
	value: Record<string, unknown>,
	path: string,
	parseValue: (value: unknown, path: string) => T,
): ChannelValues<T> {
	return {
		production: runtimeValues(value.production, `${path}.production`, parseValue),
		preview: runtimeValues(value.preview, `${path}.preview`, parseValue),
	};
}

function runtimeValues<T>(
	value: unknown,
	path: string,
	parseValue: (value: unknown, path: string) => T,
): RuntimeValues<T> {
	const values = record(value, path);
	return {
		cu128: parseValue(values.cu128, `${path}.cu128`),
		cu130: parseValue(values.cu130, `${path}.cu130`),
	};
}

function runpodId(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^[a-z0-9]+$/.test(value)) {
		throw new Error(
			`Invalid resources.jsonc: ${path} must be a lowercase alphanumeric ID.`,
		);
	}
	return value;
}

function positiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(
			`Invalid resources.jsonc: ${path} must be a positive safe integer.`,
		);
	}
	return value as number;
}

function ensureUniqueIds<T extends string | number>(
	provider: string,
	ids: ChannelValues<T>,
): void {
	const values = workerTemplateChannels.flatMap((channel) =>
		workerTemplateRuntimes.map((runtime) => ids[channel][runtime]),
	);
	if (new Set(values).size !== values.length) {
		throw new Error(
			`Invalid resources.jsonc: ${provider} template IDs must be unique.`,
		);
	}
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid resources.jsonc: ${path} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid resources.jsonc: ${path} must be a non-empty string.`);
	}
	return value;
}

function httpsUrl(value: unknown, path: string): string {
	const url = nonEmptyString(value, path);
	if (new URL(url).protocol !== "https:") {
		throw new Error(`Invalid resources.jsonc: ${path} must use HTTPS.`);
	}
	return url;
}
