import {
	loadWorkerTemplateFiles,
	type RunpodTemplateConfig,
	type WorkerEnvironmentConfig,
} from "./worker-template-config";
import {
	parseWorkerImageArguments,
	requireEnvironment,
	requirePushedWorkerImages,
	resolveWorkerImages,
	type WorkerImages,
	type WorkerRuntime,
	type WorkerTemplateChannel,
	workerRuntimes,
	workerTemplateName,
} from "./worker-template-images";

export type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

type Logger = Pick<typeof console, "info" | "error">;

const environmentPlaceholder = "REPLACE_ME";

type RunpodManagedTemplate = {
	name: string;
	imageName: string;
	containerDiskInGb: number;
	volumeInGb: number;
	volumeMountPath: string;
	ports: string[];
	dockerEntrypoint: string[];
	dockerStartCmd: string[];
	isPublic: boolean;
	env: Record<string, string>;
	readme: string;
};

type RunpodPortConfig = {
	port: string;
	name: string;
};

type RunpodGraphQLTemplate = {
	id: string;
	portsConfig: RunpodPortConfig[];
	containerRegistryAuthId: string;
	startJupyter: boolean;
	startSsh: boolean;
	startScript: string;
	isServerless: boolean;
	advancedStart: boolean;
	category: string;
};

const preservedGraphQLFields = [
	"startJupyter",
	"startSsh",
	"startScript",
	"isServerless",
	"advancedStart",
	"category",
] as const satisfies readonly (keyof RunpodGraphQLTemplate)[];

const runpodGraphQLUrl = "https://api.runpod.io/graphql";

const getTemplatesQuery = `
	query GetTemplates {
		myself {
			podTemplates {
				id
				portsConfig {
					port
					name
				}
				containerRegistryAuthId
				startJupyter
				startSsh
				startScript
				isServerless
				advancedStart
				category
			}
		}
	}
`;

const saveTemplateMutation = `
	mutation SaveTemplate($input: SaveTemplateInput) {
		saveTemplate(input: $input) {
			id
		}
	}
`;

export function parseArguments(args: string[]): WorkerTemplateChannel {
	return parseWorkerImageArguments(
		args,
		"apps/worker/scripts/runpod-worker-templates.ts",
	);
}

async function getTemplate(
	templateId: string,
	apiKey: string,
	fetcher: Fetcher,
): Promise<RunpodManagedTemplate> {
	const response = await fetcher(templateUrl(templateId), {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	const value = await responseJson(response, "RunPod Worker template lookup");
	const template = record(value, "RunPod Worker template");
	return {
		name: nonEmptyString(template.name, "name"),
		imageName: nonEmptyString(template.imageName, "imageName"),
		containerDiskInGb: nonNegativeInteger(
			template.containerDiskInGb,
			"containerDiskInGb",
		),
		volumeInGb: nonNegativeInteger(template.volumeInGb, "volumeInGb"),
		volumeMountPath: nonEmptyString(template.volumeMountPath, "volumeMountPath"),
		ports: stringArray(template.ports, "ports"),
		dockerEntrypoint: nullableStringArray(
			template.dockerEntrypoint,
			"dockerEntrypoint",
		),
		dockerStartCmd: nullableStringArray(template.dockerStartCmd, "dockerStartCmd"),
		isPublic: template.isPublic === true,
		env: nullableStringRecord(template.env, "env"),
		readme: nullableString(template.readme, "readme"),
	};
}

async function updateTemplate(
	templateId: string,
	apiKey: string,
	template: RunpodManagedTemplate,
	fetcher: Fetcher,
): Promise<void> {
	const response = await fetcher(templateUrl(templateId), {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(template),
	});
	if (!response.ok) {
		throw new Error(
			`RunPod Worker template update failed with HTTP ${response.status}. ${await response.text()}`,
		);
	}
}

async function getAppliedTemplate(
	templateId: string,
	apiKey: string,
	expected: RunpodManagedTemplate,
	fetcher: Fetcher,
): Promise<RunpodManagedTemplate> {
	const template = await getTemplate(templateId, apiKey, fetcher);
	const mismatches = mismatchedFields(template, expected);
	if (mismatches.length !== 0) {
		throw new Error(
			`RunPod template ${templateId} did not apply: ${mismatches.join(", ")}.`,
		);
	}
	return template;
}

async function getGraphQLTemplate(
	templateId: string,
	apiKey: string,
	fetcher: Fetcher,
): Promise<RunpodGraphQLTemplate> {
	const data = await graphQLRequest(
		getTemplatesQuery,
		{},
		apiKey,
		fetcher,
		"RunPod Worker template GraphQL lookup",
	);
	const myself = record(data.myself, "RunPod GraphQL myself");
	if (!Array.isArray(myself.podTemplates)) {
		throw new Error("RunPod GraphQL podTemplates returned an unexpected response.");
	}

	for (const value of myself.podTemplates) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			continue;
		}
		const template = value as Record<string, unknown>;
		if (template.id !== templateId) continue;
		return {
			id: nonEmptyString(template.id, "GraphQL id"),
			portsConfig: graphQLPortsConfig(template.portsConfig),
			containerRegistryAuthId: nullableString(
				template.containerRegistryAuthId,
				"GraphQL containerRegistryAuthId",
			),
			startJupyter: nullableBoolean(template.startJupyter, "GraphQL startJupyter"),
			startSsh: nullableBoolean(template.startSsh, "GraphQL startSsh"),
			startScript: nullableString(template.startScript, "GraphQL startScript"),
			isServerless: nullableBoolean(template.isServerless, "GraphQL isServerless"),
			advancedStart: nullableBoolean(template.advancedStart, "GraphQL advancedStart"),
			category: nullableString(template.category, "GraphQL category"),
		};
	}

	throw new Error(`RunPod Worker template ${templateId} was not found in GraphQL.`);
}

async function saveGraphQLTemplate(
	apiKey: string,
	current: RunpodGraphQLTemplate,
	expected: RunpodManagedTemplate,
	portsConfig: RunpodPortConfig[],
	fetcher: Fetcher,
): Promise<void> {
	const input: Record<string, unknown> = {
		id: current.id,
		name: expected.name,
		imageName: expected.imageName,
		containerDiskInGb: expected.containerDiskInGb,
		dockerArgs: graphQLDockerArgs(expected.dockerStartCmd, expected.dockerEntrypoint),
		env: environmentPairs(expected.env),
		ports: expected.ports.join(","),
		portsConfig,
		volumeInGb: expected.volumeInGb,
		volumeMountPath: expected.volumeMountPath,
		isPublic: expected.isPublic,
		isServerless: current.isServerless,
		startJupyter: current.startJupyter,
		startSsh: current.startSsh,
		advancedStart: current.advancedStart,
		readme: expected.readme,
	};
	if (!expected.isPublic && current.containerRegistryAuthId.length !== 0) {
		input.containerRegistryAuthId = current.containerRegistryAuthId;
	}
	if (current.startScript.length !== 0) input.startScript = current.startScript;
	if (current.category.length !== 0) input.category = current.category;

	const data = await graphQLRequest(
		saveTemplateMutation,
		{ input },
		apiKey,
		fetcher,
		"RunPod Worker template GraphQL update",
	);
	const saved = record(data.saveTemplate, "RunPod GraphQL saveTemplate");
	if (saved.id !== current.id) {
		throw new Error(
			`RunPod Worker template GraphQL update returned unexpected template ${String(saved.id)}.`,
		);
	}
}

async function graphQLRequest(
	query: string,
	variables: Record<string, unknown>,
	apiKey: string,
	fetcher: Fetcher,
	action: string,
): Promise<Record<string, unknown>> {
	const response = await fetcher(runpodGraphQLUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});
	const value = record(await responseJson(response, action), "RunPod GraphQL response");
	if (value.errors !== undefined) {
		if (!Array.isArray(value.errors)) {
			throw new Error(`${action} returned an unexpected response.`);
		}
		if (value.errors.length !== 0) {
			const error = record(value.errors[0], "RunPod GraphQL error");
			const message =
				typeof error.message === "string" && error.message.length !== 0
					? error.message
					: "Unknown GraphQL error.";
			throw new Error(`${action} failed: ${message}`);
		}
	}
	return record(value.data, "RunPod GraphQL data");
}

function environmentPairs(
	environment: Record<string, string>,
): Array<{ key: string; value: string }> {
	return Object.entries(environment)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => ({ key, value }));
}

function graphQLDockerArgs(cmd: string[], entrypoint: string[]): string {
	if (cmd.length === 0 && entrypoint.length === 0) return "";
	return JSON.stringify({
		...(cmd.length === 0 ? {} : { cmd }),
		...(entrypoint.length === 0 ? {} : { entrypoint }),
	});
}

function graphQLPortsConfig(value: unknown): RunpodPortConfig[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error("RunPod GraphQL portsConfig returned an unexpected response.");
	}
	return value.map((item) => {
		const portConfig = record(item, "RunPod GraphQL port configuration");
		return {
			port: graphQLPort(portConfig.port),
			name: nullableString(portConfig.name, "GraphQL port name"),
		};
	});
}

function graphQLPort(value: unknown): string {
	const port =
		typeof value === "string" && /^\d+$/.test(value)
			? Number(value)
			: typeof value === "number"
				? value
				: Number.NaN;
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("RunPod GraphQL port returned an unexpected response.");
	}
	return String(port);
}

function samePortsConfig(
	actual: RunpodPortConfig[],
	expected: RunpodPortConfig[],
): boolean {
	const byPort = (left: RunpodPortConfig, right: RunpodPortConfig) =>
		Number(left.port) - Number(right.port) || left.name.localeCompare(right.name);
	return (
		JSON.stringify([...actual].sort(byPort)) ===
		JSON.stringify([...expected].sort(byPort))
	);
}

function mismatchedGraphQLFields(
	actual: RunpodGraphQLTemplate,
	previous: RunpodGraphQLTemplate,
	isPublic: boolean,
): string[] {
	const expectedRegistryAuthId = isPublic ? "" : previous.containerRegistryAuthId;
	return [
		...(actual.containerRegistryAuthId === expectedRegistryAuthId
			? []
			: ["containerRegistryAuthId"]),
		...preservedGraphQLFields.filter((key) => actual[key] !== previous[key]),
	];
}

function desiredTemplate(
	runtime: WorkerRuntime,
	image: string,
	config: RunpodTemplateConfig,
	environment: WorkerEnvironmentConfig,
	readme: string,
): RunpodManagedTemplate {
	return {
		name: config.templates[runtime].name,
		imageName: image,
		containerDiskInGb: config.containerDiskInGb,
		volumeInGb: config.volumeInGb,
		volumeMountPath: config.volumeMountPath,
		ports: config.ports,
		dockerEntrypoint: config.dockerEntrypoint,
		dockerStartCmd: config.dockerStartCmd,
		isPublic: config.isPublic,
		env: Object.fromEntries(
			[...environment.required, ...environment.optional].map((name) => [
				name,
				environmentPlaceholder,
			]),
		),
		readme,
	};
}

export async function syncTemplates(
	templateIds: Record<WorkerRuntime, string>,
	apiKey: string,
	images: WorkerImages,
	config: RunpodTemplateConfig,
	environment: WorkerEnvironmentConfig,
	readme: string,
	fetcher: Fetcher = fetch,
	logger: Logger = console,
): Promise<void> {
	const expectedPortsConfig = config.portsConfig.map(({ port, name }) => ({
		port: String(port),
		name,
	}));
	const updates = await Promise.allSettled(
		workerRuntimes.map(async (runtime) => {
			const templateId = templateIds[runtime];
			const expected = desiredTemplate(
				runtime,
				images[runtime],
				config,
				environment,
				readme,
			);
			let applied = await getTemplate(templateId, apiKey, fetcher);
			let published = false;
			const graphQLTemplate = await getGraphQLTemplate(templateId, apiKey, fetcher);
			const restMismatches = mismatchedFields(applied, expected);
			if (
				!samePortsConfig(graphQLTemplate.portsConfig, expectedPortsConfig) ||
				(expected.isPublic &&
					(graphQLTemplate.containerRegistryAuthId.length !== 0 ||
						restMismatches.length !== 0))
			) {
				await saveGraphQLTemplate(
					apiKey,
					graphQLTemplate,
					expected,
					expectedPortsConfig,
					fetcher,
				);
				const readBack = await getGraphQLTemplate(templateId, apiKey, fetcher);
				if (!samePortsConfig(readBack.portsConfig, expectedPortsConfig)) {
					throw new Error(`RunPod template ${templateId} did not apply: portsConfig.`);
				}
				const graphQLMismatches = mismatchedGraphQLFields(
					readBack,
					graphQLTemplate,
					expected.isPublic,
				);
				if (graphQLMismatches.length !== 0) {
					throw new Error(
						`RunPod template ${templateId} did not preserve: ${graphQLMismatches.join(", ")}.`,
					);
				}
				applied = expected.isPublic
					? await getAppliedTemplate(templateId, apiKey, expected, fetcher)
					: await getTemplate(templateId, apiKey, fetcher);
				published = true;
			}

			if (!expected.isPublic && mismatchedFields(applied, expected).length !== 0) {
				await updateTemplate(templateId, apiKey, expected, fetcher);
				applied = await getAppliedTemplate(templateId, apiKey, expected, fetcher);
				published = true;
			}

			return { runtime, template: applied, published };
		}),
	);

	let failed = false;
	for (const [index, update] of updates.entries()) {
		const runtime = workerRuntimes[index];
		if (update.status === "fulfilled") {
			logger.info(
				`${update.value.runtime}\t${update.value.template.name}\t${update.value.template.imageName}\t${update.value.published ? "published" : "up-to-date"}`,
			);
			continue;
		}

		failed = true;
		logger.error(
			`${runtime}\t${update.reason instanceof Error ? update.reason.message : update.reason}`,
		);
	}
	if (failed)
		throw new Error("One or more RunPod Worker templates could not be published.");
}

function mismatchedFields(
	actual: RunpodManagedTemplate,
	expected: RunpodManagedTemplate,
): string[] {
	return (Object.keys(expected) as (keyof RunpodManagedTemplate)[]).filter((key) =>
		key === "env"
			? !sameEnvironment(actual.env, expected.env)
			: JSON.stringify(actual[key]) !== JSON.stringify(expected[key]),
	);
}

function sameEnvironment(
	actual: Record<string, string>,
	expected: Record<string, string>,
): boolean {
	const names = Object.keys(expected);
	return (
		Object.keys(actual).length === names.length &&
		names.every((name) => actual[name] === expected[name])
	);
}

function templateUrl(templateId: string): string {
	return `https://rest.runpod.io/v1/templates/${templateId}`;
}

async function responseJson(response: Response, action: string): Promise<unknown> {
	const body = await response.text();
	if (!response.ok)
		throw new Error(`${action} failed with HTTP ${response.status}. ${body}`);
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`${action} returned invalid JSON.`);
	}
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${name} returned an unexpected response.`);
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`RunPod Worker template ${name} is invalid.`);
	}
	return value;
}

function nullableString(value: unknown, name: string): string {
	if (value === null || value === undefined) return "";
	if (typeof value !== "string") {
		throw new Error(`RunPod Worker template ${name} is invalid.`);
	}
	return value;
}

function nullableBoolean(value: unknown, name: string): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value !== "boolean") {
		throw new Error(`RunPod Worker template ${name} is invalid.`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`RunPod Worker template ${name} is invalid.`);
	}
	return value as number;
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`RunPod Worker template ${name} is invalid.`);
	}
	return value;
}

function nullableStringArray(value: unknown, name: string): string[] {
	if (value === null || value === undefined) return [];
	return stringArray(value, name);
}

function nullableStringRecord(value: unknown, name: string): Record<string, string> {
	if (value === null || value === undefined) return {};
	const result = record(value, name);
	if (Object.values(result).some((item) => typeof item !== "string")) {
		throw new Error(`RunPod Worker template ${name} is invalid.`);
	}
	return result as Record<string, string>;
}

async function main(): Promise<void> {
	const channel = parseArguments(process.argv.slice(2));
	const files = await loadWorkerTemplateFiles();
	const images = await resolveWorkerImages(channel);
	const apiKey = requireEnvironment("RUNPOD_API_KEY");
	for (const runtime of workerRuntimes) {
		files.runpod.templates[runtime].name = workerTemplateName(runtime, channel);
	}
	const templateIds = files.resources.workerTemplates.runpod[channel];

	await requirePushedWorkerImages(images);
	await syncTemplates(
		templateIds,
		apiKey,
		images,
		files.runpod,
		files.environment,
		files.readme,
	);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
