import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

export type ExternalLinks = {
	github: string;
	docs: {
		home: string;
		gettingStarted: string;
		runWorkerWithDocker: string;
		editAndRunWorkflows: string;
		addModelsAndCustomNodes: string;
	};
	discord: string;
	dockerHub: {
		cu128: string;
		cu130: string;
	};
	runpod: {
		template: string | null;
	};
	vastAi: {
		production: {
			cu128: string;
			cu130: string;
		};
		beta: {
			cu128: string;
			cu130: string;
		};
	};
};

export function parseExternalLinks(source: string): ExternalLinks {
	const errors: ParseError[] = [];
	const value: unknown = parse(source, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const details = errors
			.map(({ error, offset }) => `${printParseErrorCode(error)} at ${offset}`)
			.join(", ");
		throw new Error(`Invalid LINKS.jsonc: ${details}`);
	}

	const links = record(value, "LINKS.jsonc");
	const docs = record(links.docs, "docs");
	const dockerHub = record(links.dockerHub, "dockerHub");
	const runpod = record(links.runpod, "runpod");
	const vastAi = record(links.vastAi, "vastAi");
	const vastAiProduction = record(vastAi.production, "vastAi.production");
	const vastAiBeta = record(vastAi.beta, "vastAi.beta");

	return {
		github: httpsUrl(links.github, "github"),
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
		discord: httpsUrl(links.discord, "discord"),
		dockerHub: {
			cu128: nonEmptyString(dockerHub.cu128, "dockerHub.cu128"),
			cu130: nonEmptyString(dockerHub.cu130, "dockerHub.cu130"),
		},
		runpod: {
			template:
				runpod.template === null ? null : httpsUrl(runpod.template, "runpod.template"),
		},
		vastAi: {
			production: {
				cu128: httpsUrl(vastAiProduction.cu128, "vastAi.production.cu128"),
				cu130: httpsUrl(vastAiProduction.cu130, "vastAi.production.cu130"),
			},
			beta: {
				cu128: httpsUrl(vastAiBeta.cu128, "vastAi.beta.cu128"),
				cu130: httpsUrl(vastAiBeta.cu130, "vastAi.beta.cu130"),
			},
		},
	};
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid LINKS.jsonc: ${path} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid LINKS.jsonc: ${path} must be a non-empty string.`);
	}
	return value;
}

function httpsUrl(value: unknown, path: string): string {
	const url = nonEmptyString(value, path);
	if (new URL(url).protocol !== "https:") {
		throw new Error(`Invalid LINKS.jsonc: ${path} must use HTTPS.`);
	}
	return url;
}
