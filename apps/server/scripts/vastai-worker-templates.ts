import {
	loadWorkerTemplateFiles,
	type VastExtraFilters,
	type VastTemplateConfig,
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

const vastTemplateUrl = "https://console.vast.ai/api/v0/template/";
const vastReadmeUrl = "https://s3.amazonaws.com/public.vast.ai/readme/";
const vastRequestIntervalMs = 400;

export type VastTemplate = {
	id: number;
	hashId: string;
	name: string;
	desc: string;
	readme: string;
	readmeHash: string | null;
	readmeVisible: boolean;
	image: string;
	tag?: string;
	env: string;
	onstart: string;
	runtype: string;
	argsStr: string;
	sshDirect: boolean;
	useSsh: boolean;
	extraFilters: VastExtraFilters | null;
	recommendedDiskSpace: number;
	private: boolean;
};

type VastComparableTemplate = Omit<VastTemplate, "id" | "hashId" | "readmeHash">;
type VastManagedTemplate = Omit<VastComparableTemplate, "extraFilters"> & {
	extraFilters: VastExtraFilters;
};

export type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

type Sleeper = (milliseconds: number) => Promise<unknown>;
type Logger = Pick<typeof console, "info" | "error">;

export function parseArguments(args: string[]): WorkerTemplateChannel {
	return parseWorkerImageArguments(
		args,
		"apps/server/scripts/vastai-worker-templates.ts",
	);
}

export async function getTemplates(
	templateIds: number[],
	apiKey: string,
	fetcher: Fetcher = fetch,
): Promise<Map<number, VastTemplate>> {
	const url = new URL(vastTemplateUrl);
	url.searchParams.set("select_filters", JSON.stringify({ id: { in: templateIds } }));
	url.searchParams.set(
		"select_cols",
		JSON.stringify([
			"id",
			"hash_id",
			"name",
			"desc",
			"readme",
			"readme_hash",
			"readme_visible",
			"image",
			"tag",
			"env",
			"onstart",
			"runtype",
			"args_str",
			"ssh_direct",
			"use_ssh",
			"extra_filters",
			"recommended_disk_space",
			"private",
		]),
	);
	const response = await fetcher(url, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	const result = await responseJson(response, "Vast.ai Worker template lookup");
	if (
		!isRecord(result) ||
		result.success !== true ||
		!Array.isArray(result.templates)
	) {
		throw new Error("Vast.ai returned an unexpected template lookup response.");
	}

	const templates = new Map<number, VastTemplate>();
	for (const value of result.templates) {
		const template = parseTemplate(value);
		if (!templateIds.includes(template.id) || templates.has(template.id)) {
			throw new Error("Vast.ai returned unexpected Worker templates.");
		}
		templates.set(template.id, {
			...template,
			readme:
				template.readmeHash === null
					? template.readme
					: await fetchTemplateReadme(template.readmeHash, fetcher),
		});
	}
	for (const templateId of templateIds) {
		if (!templates.has(templateId)) {
			throw new Error(`Vast.ai Worker template ${templateId} was not found.`);
		}
	}
	return templates;
}

export async function updateTemplate(
	template: VastTemplate,
	apiKey: string,
	desired: VastManagedTemplate,
	fetcher: Fetcher = fetch,
): Promise<void> {
	const response = await fetcher(vastTemplateUrl, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			hash_id: template.hashId,
			name: desired.name,
			desc: desired.desc,
			readme: desired.readme,
			readme_visible: desired.readmeVisible,
			image: desired.image,
			tag: desired.tag,
			env: desired.env,
			onstart: desired.onstart,
			runtype: desired.runtype,
			args_str: desired.argsStr,
			ssh_direct: desired.sshDirect,
			use_ssh: desired.useSsh,
			extra_filters: desired.extraFilters,
			recommended_disk_space: desired.recommendedDiskSpace,
			private: desired.private,
		}),
	});
	const result = await responseJson(response, "Vast.ai Worker template update");
	if (!isRecord(result) || result.success !== true) {
		throw new Error(`Vast.ai did not accept template ${template.id}.`);
	}
}

export function reportedImage(template: Pick<VastTemplate, "image" | "tag">): string {
	return template.tag ? `${template.image}:${template.tag}` : template.image;
}

function desiredTemplate(
	runtime: WorkerRuntime,
	image: string,
	config: VastTemplateConfig,
	environment: WorkerEnvironmentConfig,
	readme: string,
): VastManagedTemplate {
	return {
		name: config.templates[runtime].name,
		desc: config.desc,
		readme,
		readmeVisible: config.readme_visible,
		...splitImage(image),
		env: vastDockerOptions(config.env, environment),
		onstart: config.onstart,
		runtype: config.runtype,
		argsStr: config.args_str,
		sshDirect: config.ssh_direct,
		useSsh: config.use_ssh,
		extraFilters: config.templates[runtime].extra_filters,
		recommendedDiskSpace: config.recommended_disk_space,
		private: config.private,
	};
}

function vastDockerOptions(base: string, environment: WorkerEnvironmentConfig): string {
	return [
		base,
		...[...environment.required, ...environment.optional].map(
			(name) => `-e ${name}=REPLACE_ME`,
		),
	]
		.filter((option) => option.length !== 0)
		.join(" ");
}

function splitImage(image: string): { image: string; tag: string } {
	const separator = image.lastIndexOf(":");
	if (separator <= image.lastIndexOf("/") || separator === image.length - 1) {
		throw new Error(`Vast.ai Worker image must include a tag: ${image}`);
	}
	return { image: image.slice(0, separator), tag: image.slice(separator + 1) };
}

function parseTemplate(value: unknown): VastTemplate {
	if (
		!isRecord(value) ||
		typeof value.id !== "number" ||
		!Number.isSafeInteger(value.id) ||
		value.id <= 0 ||
		typeof value.hash_id !== "string" ||
		value.hash_id.length === 0 ||
		typeof value.name !== "string" ||
		value.name.length === 0 ||
		typeof value.image !== "string" ||
		value.image.length === 0 ||
		(value.tag !== undefined && value.tag !== null && typeof value.tag !== "string")
	) {
		throw new Error("Vast.ai returned an unexpected Worker template.");
	}
	return {
		id: value.id,
		hashId: value.hash_id,
		name: value.name,
		desc: nullableString(value.desc),
		readme: nullableString(value.readme),
		readmeHash: nullableOptionalString(value.readme_hash),
		readmeVisible: value.readme_visible === true,
		image: value.image,
		...(typeof value.tag === "string" ? { tag: value.tag } : {}),
		env: nullableString(value.env),
		onstart: nullableString(value.onstart),
		runtype: nullableString(value.runtype),
		argsStr: nullableString(value.args_str),
		sshDirect: value.ssh_direct === true,
		useSsh: value.use_ssh === true,
		extraFilters: parseExtraFilters(value.extra_filters),
		recommendedDiskSpace:
			typeof value.recommended_disk_space === "number"
				? value.recommended_disk_space
				: 0,
		private: value.private === true,
	};
}

async function fetchTemplateReadme(hash: string, fetcher: Fetcher): Promise<string> {
	const response = await fetcher(`${vastReadmeUrl}${encodeURIComponent(hash)}.md`);
	if (!response.ok) {
		throw new Error(
			`Vast.ai Worker template README lookup failed with HTTP ${response.status}.`,
		);
	}
	return (await response.text()).trim();
}

function parseExtraFilters(value: unknown): VastExtraFilters | null {
	let filters = value;
	if (typeof filters === "string") {
		try {
			filters = JSON.parse(filters);
		} catch {
			throw new Error("Vast.ai returned invalid Worker template extra_filters.");
		}
	}
	if (filters === null || filters === undefined) return null;
	if (!isRecord(filters) || !isRecord(filters.cuda_max_good)) {
		throw new Error("Vast.ai returned invalid Worker template extra_filters.");
	}
	const gte = filters.cuda_max_good.gte;
	if (typeof gte !== "number" || !Number.isFinite(gte) || gte <= 0) {
		throw new Error("Vast.ai returned invalid Worker template extra_filters.");
	}
	return { cuda_max_good: { gte } };
}

function nullableString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function nullableOptionalString(value: unknown): string | null {
	return typeof value === "string" && value.length !== 0 ? value : null;
}

async function responseJson(response: Response, action: string): Promise<unknown> {
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`${action} failed with HTTP ${response.status}. ${body}`);
	}
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`${action} returned invalid JSON.`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export async function syncTemplates(
	templateIds: Record<WorkerRuntime, number>,
	apiKey: string,
	images: WorkerImages,
	config: VastTemplateConfig,
	environment: WorkerEnvironmentConfig,
	readme: string,
	fetcher: Fetcher = fetch,
	sleep: Sleeper = Bun.sleep,
	logger: Logger = console,
): Promise<void> {
	const ids = workerRuntimes.map((runtime) => templateIds[runtime]);
	const currentTemplates = await getTemplates(ids, apiKey, fetcher);
	const updateFailures = new Map<WorkerRuntime, unknown>();
	const changedRuntimes = new Set<WorkerRuntime>();

	for (const runtime of workerRuntimes) {
		const template = currentTemplates.get(templateIds[runtime]);
		if (!template) throw new Error(`Missing ${runtime} Vast.ai Worker template.`);
		const desired = desiredTemplate(
			runtime,
			images[runtime],
			config,
			environment,
			readme,
		);
		if (mismatchedFields(template, desired).length === 0) continue;

		changedRuntimes.add(runtime);
		await sleep(vastRequestIntervalMs);
		try {
			await updateTemplate(template, apiKey, desired, fetcher);
		} catch (error) {
			updateFailures.set(runtime, error);
		}
	}

	if (changedRuntimes.size !== 0) await sleep(vastRequestIntervalMs);
	const appliedTemplates =
		changedRuntimes.size !== 0
			? await getTemplates(ids, apiKey, fetcher)
			: currentTemplates;
	let failed = false;
	for (const runtime of workerRuntimes) {
		const template = appliedTemplates.get(templateIds[runtime]);
		if (!template) throw new Error(`Missing ${runtime} Vast.ai Worker template.`);
		const desired = desiredTemplate(
			runtime,
			images[runtime],
			config,
			environment,
			readme,
		);
		const mismatches = mismatchedFields(template, desired);
		if (mismatches.length === 0) {
			logger.info(
				`${runtime}\t${template.name}\t${reportedImage(template)}\t${changedRuntimes.has(runtime) ? "published" : "up-to-date"}`,
			);
			continue;
		}

		failed = true;
		const updateFailure = updateFailures.get(runtime);
		const message =
			updateFailure instanceof Error
				? updateFailure.message
				: `Vast.ai template ${template.id} did not apply: ${mismatches.join(", ")}.`;
		logger.error(`${runtime}\t${message}`);
	}
	if (failed)
		throw new Error("One or more Vast.ai Worker templates could not be published.");
}

function mismatchedFields(
	template: VastTemplate,
	desired: VastManagedTemplate,
): string[] {
	const actual: VastComparableTemplate = {
		name: template.name,
		desc: template.desc,
		readme: template.readme,
		readmeVisible: template.readmeVisible,
		image: template.image,
		...(template.tag === undefined ? {} : { tag: template.tag }),
		env: template.env,
		onstart: template.onstart,
		runtype: template.runtype,
		argsStr: template.argsStr,
		sshDirect: template.sshDirect,
		useSsh: template.useSsh,
		extraFilters: template.extraFilters,
		recommendedDiskSpace: template.recommendedDiskSpace,
		private: template.private,
	};
	return (Object.keys(desired) as (keyof VastManagedTemplate)[]).filter(
		(key) => JSON.stringify(actual[key]) !== JSON.stringify(desired[key]),
	);
}

async function main(): Promise<void> {
	const channel = parseArguments(process.argv.slice(2));
	const files = await loadWorkerTemplateFiles();
	const images = await resolveWorkerImages(channel);
	const apiKey = requireEnvironment("VAST_API_KEY");
	for (const runtime of workerRuntimes) {
		files.vastai.templates[runtime].name = workerTemplateName(runtime, channel);
	}
	const templateIds = files.resources.workerTemplates.vastAi[channel];

	await requirePushedWorkerImages(images);
	await syncTemplates(
		templateIds,
		apiKey,
		images,
		files.vastai,
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
