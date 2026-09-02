import { resolve } from "node:path";
import { parseResources, type Resources } from "@kastard/common";
import { type WorkerRuntime, workerRuntimes } from "./worker-template-images";

type RuntimeTemplates<T extends object = Record<never, never>> = Record<
	WorkerRuntime,
	{ name: string } & T
>;

export type VastExtraFilters = {
	cuda_max_good: { gte: number };
};

export type RunpodTemplateConfig = {
	templates: RuntimeTemplates;
	containerDiskInGb: number;
	volumeInGb: number;
	volumeMountPath: string;
	ports: string[];
	portsConfig: Array<{ port: number; name: string }>;
	dockerEntrypoint: string[];
	dockerStartCmd: string[];
	isPublic: boolean;
};

export type VastTemplateConfig = {
	templates: RuntimeTemplates<{ extra_filters: VastExtraFilters }>;
	desc: string;
	env: string;
	onstart: string;
	runtype: "args" | "ssh" | "jupyter";
	args_str: string;
	ssh_direct: boolean;
	use_ssh: boolean;
	readme_visible: boolean;
	recommended_disk_space: number;
	private: boolean;
};

export type WorkerEnvironmentConfig = {
	required: string[];
	optional: string[];
};

export type WorkerTemplateFiles = {
	resources: Resources;
	runpod: RunpodTemplateConfig;
	vastai: VastTemplateConfig;
	environment: WorkerEnvironmentConfig;
	readme: string;
};

const templateDirectory = resolve(import.meta.dir, "../worker-templates");
const resourcesPath = resolve(import.meta.dir, "../../../resources.jsonc");

export async function loadWorkerTemplateFiles(): Promise<WorkerTemplateFiles> {
	const [resourcesSource, runpodValue, vastaiValue, environmentValue, readmeValue] =
		await Promise.all([
			Bun.file(resourcesPath).text(),
			Bun.file(resolve(templateDirectory, "runpod.json")).json(),
			Bun.file(resolve(templateDirectory, "vastai.json")).json(),
			Bun.file(resolve(templateDirectory, "environment.json")).json(),
			Bun.file(resolve(templateDirectory, "template.md")).text(),
		]);
	const environment = parseWorkerEnvironmentConfig(environmentValue);
	const readme = readmeValue.trim();
	if (readme.length === 0) throw new Error("Worker template README must not be empty.");
	for (const name of [...environment.required, ...environment.optional]) {
		if (!readme.includes(`\`${name}\``)) {
			throw new Error(`Worker template README must document ${name}.`);
		}
	}
	return {
		resources: parseResources(resourcesSource),
		runpod: parseRunpodTemplateConfig(runpodValue),
		vastai: parseVastTemplateConfig(vastaiValue),
		environment,
		readme,
	};
}

export function parseRunpodTemplateConfig(value: unknown): RunpodTemplateConfig {
	const config = record(value, "RunPod Worker template configuration");
	const env = stringRecord(config.env, "RunPod env");
	if (Object.keys(env).length !== 0) {
		throw new Error(
			"RunPod Worker template environment values must be supplied when a Pod is created.",
		);
	}
	const ports = stringArray(config.ports, "ports");
	return {
		templates: runtimeTemplates(config.templates, "RunPod templates"),
		containerDiskInGb: positiveInteger(config.containerDiskInGb, "containerDiskInGb"),
		volumeInGb: nonNegativeInteger(config.volumeInGb, "volumeInGb"),
		volumeMountPath: nonEmptyString(config.volumeMountPath, "volumeMountPath"),
		ports,
		portsConfig: runpodPortsConfig(config.portsConfig, ports),
		dockerEntrypoint: stringArray(config.dockerEntrypoint, "dockerEntrypoint"),
		dockerStartCmd: stringArray(config.dockerStartCmd, "dockerStartCmd"),
		isPublic: booleanValue(config.isPublic, "isPublic"),
	};
}

function runpodPortsConfig(
	value: unknown,
	ports: string[],
): Array<{ port: number; name: string }> {
	if (!Array.isArray(value)) {
		throw new Error("portsConfig must be an array.");
	}
	const result = value.map((item, index) => {
		const config = record(item, `portsConfig[${index}]`);
		return {
			port: portNumber(config.port, `portsConfig[${index}].port`),
			name: trimmedNonEmptyString(config.name, `portsConfig[${index}].name`),
		};
	});
	if (new Set(result.map(({ port }) => port)).size !== result.length) {
		throw new Error("portsConfig ports must be unique.");
	}
	for (const config of result) {
		if (
			!ports.includes(`${config.port}/tcp`) &&
			!ports.includes(`${config.port}/http`)
		) {
			throw new Error(`portsConfig port ${config.port} must exist in ports.`);
		}
	}
	return result;
}

export function parseVastTemplateConfig(value: unknown): VastTemplateConfig {
	const config = record(value, "Vast.ai Worker template configuration");
	const env = stringValue(config.env, "env");
	if (/(^|\s)-e(?:\s|$)/.test(env)) {
		throw new Error(
			"Vast.ai Worker template environment values must be supplied when an instance is created.",
		);
	}
	const runtype = stringValue(config.runtype, "runtype");
	if (runtype !== "args" && runtype !== "ssh" && runtype !== "jupyter") {
		throw new Error("runtype must be args, ssh, or jupyter.");
	}
	return {
		templates: vastRuntimeTemplates(config.templates),
		desc: stringValue(config.desc, "desc"),
		env,
		onstart: stringValue(config.onstart, "onstart"),
		runtype,
		args_str: stringValue(config.args_str, "args_str"),
		ssh_direct: booleanValue(config.ssh_direct, "ssh_direct"),
		use_ssh: booleanValue(config.use_ssh, "use_ssh"),
		readme_visible: booleanValue(config.readme_visible, "readme_visible"),
		recommended_disk_space: positiveInteger(
			config.recommended_disk_space,
			"recommended_disk_space",
		),
		private: booleanValue(config.private, "private"),
	};
}

export function parseWorkerEnvironmentConfig(value: unknown): WorkerEnvironmentConfig {
	const config = record(value, "Worker environment configuration");
	const required = environmentNames(config.required, "required");
	const optional = environmentNames(config.optional, "optional");
	const names = [...required, ...optional];
	if (new Set(names).size !== names.length) {
		throw new Error("Worker environment variable names must be unique.");
	}
	return { required, optional };
}

function runtimeTemplates(value: unknown, name: string): RuntimeTemplates {
	const templates = record(value, name);
	const result = {} as RuntimeTemplates;
	for (const runtime of workerRuntimes) {
		const template = record(templates[runtime], `${name}.${runtime}`);
		result[runtime] = {
			name: nonEmptyString(template.name, `${name}.${runtime}.name`),
		};
	}
	return result;
}

function vastRuntimeTemplates(
	value: unknown,
): RuntimeTemplates<{ extra_filters: VastExtraFilters }> {
	const templates = record(value, "Vast.ai templates");
	const result = {} as RuntimeTemplates<{ extra_filters: VastExtraFilters }>;
	for (const runtime of workerRuntimes) {
		const name = `Vast.ai templates.${runtime}`;
		const template = record(templates[runtime], name);
		result[runtime] = {
			name: nonEmptyString(template.name, `${name}.name`),
			extra_filters: vastExtraFilters(template.extra_filters, `${name}.extra_filters`),
		};
	}
	return result;
}

function vastExtraFilters(value: unknown, name: string): VastExtraFilters {
	const filters = record(value, name);
	const cudaMaxGood = record(filters.cuda_max_good, `${name}.cuda_max_good`);
	const gte = cudaMaxGood.gte;
	if (typeof gte !== "number" || !Number.isFinite(gte) || gte <= 0) {
		throw new Error(`${name}.cuda_max_good.gte must be a positive number.`);
	}
	return { cuda_max_good: { gte } };
}

function environmentNames(value: unknown, name: string): string[] {
	const names = stringArray(value, name);
	for (const environmentName of names) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(environmentName)) {
			throw new Error(`${name} contains an invalid environment variable name.`);
		}
	}
	return names;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${name} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
	const result = record(value, name);
	if (Object.values(result).some((item) => typeof item !== "string")) {
		throw new Error(`${name} values must be strings.`);
	}
	return result as Record<string, string>;
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${name} must be an array of strings.`);
	}
	return value;
}

function stringValue(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string.`);
	return value;
}

function nonEmptyString(value: unknown, name: string): string {
	const result = stringValue(value, name);
	if (result.length === 0) throw new Error(`${name} must not be empty.`);
	return result;
}

function trimmedNonEmptyString(value: unknown, name: string): string {
	const result = stringValue(value, name).trim();
	if (result.length === 0) throw new Error(`${name} must not be empty.`);
	return result;
}

function positiveInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value as number;
}

function portNumber(value: unknown, name: string): number {
	const port = positiveInteger(value, name);
	if (port > 65_535) throw new Error(`${name} must not exceed 65535.`);
	return port;
}

function nonNegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${name} must be a non-negative integer.`);
	}
	return value as number;
}

function booleanValue(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
	return value;
}
