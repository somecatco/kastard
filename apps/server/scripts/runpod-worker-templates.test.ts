import { describe, expect, test } from "bun:test";
import { type Fetcher, parseArguments, syncTemplates } from "./runpod-worker-templates";
import { parseRunpodTemplateConfig } from "./worker-template-config";

const cu128 = "ssinss/kastard-worker:kas-149-abcdefg-cu128";
const cu130 = "ssinss/kastard-worker:kas-149-abcdefg-cu130";
const readme = "# Kastard Worker";
const environment = {
	required: [],
	optional: [],
};
const desiredPortsConfig = [
	{ port: "22", name: "SSH Tunnel" },
	{ port: "2222", name: "SSH" },
];
const templateIds = { cu128: "128", cu130: "130" };
const images = { cu128, cu130 };
const config = parseRunpodTemplateConfig({
	templates: {
		cu128: { name: "kastard-worker-cu128" },
		cu130: { name: "kastard-worker-cu130" },
	},
	containerDiskInGb: 50,
	volumeInGb: 150,
	volumeMountPath: "/workspace",
	ports: ["22/tcp", "2222/tcp"],
	portsConfig: [
		{ port: 22, name: "SSH Tunnel" },
		{ port: 2222, name: "SSH" },
	],
	dockerEntrypoint: [],
	dockerStartCmd: [],
	isPublic: true,
	env: {},
});

type RestTemplate = ReturnType<typeof staleTemplate>;
type GraphQLTemplate = ReturnType<typeof staleGraphQLTemplate>;

function staleTemplate(id: string) {
	return {
		id,
		name: `old-${id}`,
		imageName: "ssinss/kastard-worker:old",
		containerDiskInGb: 20,
		volumeInGb: 20,
		volumeMountPath: "/old",
		ports: ["22/tcp"],
		dockerEntrypoint: ["old-entrypoint"],
		dockerStartCmd: ["old-command"],
		isPublic: false,
		env: { OBSOLETE_VALUE: "secret" } as Record<string, string>,
		readme: "",
	};
}

function staleGraphQLTemplate(id: string) {
	return {
		id,
		portsConfig: [{ port: "22", name: "ssh" }],
		containerRegistryAuthId: `registry-${id}`,
		startJupyter: true,
		startSsh: true,
		startScript: "echo kept",
		isServerless: true,
		advancedStart: true,
		category: "NVIDIA",
	};
}

function runpod(
	options: {
		ignorePortsConfig?: string;
		ignoreReadme?: string;
		missingRest?: string;
		rejectRest?: string;
		retainRegistryCredential?: string;
		corruptGraphQLAfterSave?: string;
	} = {},
) {
	const templates = new Map<string, RestTemplate>([
		["128", staleTemplate("128")],
		["130", staleTemplate("130")],
	]);
	const graphQLTemplates = new Map<string, GraphQLTemplate>([
		["128", staleGraphQLTemplate("128")],
		["130", staleGraphQLTemplate("130")],
	]);
	if (options.missingRest) templates.delete(options.missingRest);

	const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
	const saves: Record<string, unknown>[] = [];
	const queries: string[] = [];
	const rejectedGraphQL = new Set<string>();
	const fetcher: Fetcher = async (input, init) => {
		const url = input.toString();
		if (url === "https://api.runpod.io/graphql") {
			const request = JSON.parse(String(init?.body)) as {
				query: string;
				variables: { input?: Record<string, unknown> };
			};
			queries.push(request.query);
			if (!request.query.includes("mutation SaveTemplate")) {
				return Response.json({
					data: {
						myself: { podTemplates: [...graphQLTemplates.values()] },
					},
				});
			}

			const save = request.variables.input;
			if (!save || typeof save.id !== "string") {
				throw new Error("Missing saveTemplate input");
			}
			if (rejectedGraphQL.has(save.id)) {
				return Response.json({ errors: [{ message: "unavailable" }] });
			}
			if (
				save.isPublic === true &&
				typeof save.containerRegistryAuthId === "string" &&
				save.containerRegistryAuthId.length !== 0
			) {
				return Response.json({
					errors: [{ message: "public templates cannot have Registry Credentials" }],
				});
			}
			const previous = graphQLTemplates.get(save.id);
			if (!previous) {
				return Response.json({ data: { saveTemplate: null } });
			}
			saves.push(save);
			const portsConfig =
				options.ignorePortsConfig === save.id
					? previous.portsConfig
					: (save.portsConfig as GraphQLTemplate["portsConfig"]);
			const savedTemplate = {
				...previous,
				...save,
				portsConfig,
				containerRegistryAuthId:
					options.retainRegistryCredential === save.id
						? previous.containerRegistryAuthId
						: save.isPublic === true && !("containerRegistryAuthId" in save)
							? ""
							: typeof save.containerRegistryAuthId === "string"
								? save.containerRegistryAuthId
								: previous.containerRegistryAuthId,
			} as GraphQLTemplate;
			if (options.corruptGraphQLAfterSave === save.id) {
				savedTemplate.startSsh = false;
			}
			graphQLTemplates.set(save.id, savedTemplate);
			const restTemplate = templates.get(save.id);
			if (restTemplate) {
				const dockerArgs =
					typeof save.dockerArgs === "string" && save.dockerArgs.length !== 0
						? (JSON.parse(save.dockerArgs) as {
								cmd?: string[];
								entrypoint?: string[];
							})
						: {};
				const environment = Object.fromEntries(
					(save.env as Array<{ key: string; value: string }>).map(({ key, value }) => [
						key,
						value,
					]),
				);
				templates.set(save.id, {
					...restTemplate,
					name: String(save.name),
					imageName: String(save.imageName),
					containerDiskInGb: Number(save.containerDiskInGb),
					volumeInGb: Number(save.volumeInGb),
					volumeMountPath: String(save.volumeMountPath),
					ports: String(save.ports).split(","),
					dockerEntrypoint: dockerArgs.entrypoint ?? [],
					dockerStartCmd: dockerArgs.cmd ?? [],
					isPublic: save.isPublic === true,
					env: environment,
					readme:
						options.ignoreReadme === save.id
							? restTemplate.readme
							: String(save.readme),
				});
			}
			return Response.json({ data: { saveTemplate: { id: save.id } } });
		}

		const id = url.split("/").at(-1);
		if (!id || !templates.has(id)) {
			return new Response("not found", { status: 404 });
		}
		if (init?.method !== "PATCH") return Response.json(templates.get(id));
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		if (body.isPublic === true) {
			return new Response("public templates cannot have Registry Credentials", {
				status: 500,
			});
		}
		if (options.rejectRest === id) {
			return new Response("unavailable", { status: 503 });
		}

		patches.push({ id, body });
		const previous = templates.get(id);
		if (!previous) throw new Error(`Missing template ${id}`);
		templates.set(id, {
			...previous,
			...body,
			...(options.ignoreReadme === id ? { readme: previous.readme } : {}),
		} as RestTemplate);
		return Response.json(templates.get(id));
	};
	return {
		templates,
		graphQLTemplates,
		patches,
		saves,
		queries,
		rejectedGraphQL,
		fetcher,
	};
}

function sync(
	provider: ReturnType<typeof runpod>,
	logger: Parameters<typeof syncTemplates>[7] = { info() {}, error() {} },
	templateConfig = config,
): Promise<void> {
	return syncTemplates(
		templateIds,
		"api-key",
		images,
		templateConfig,
		environment,
		readme,
		provider.fetcher,
		logger,
	);
}

async function syncFailure(provider: ReturnType<typeof runpod>): Promise<string[]> {
	const errors: string[] = [];
	await expect(
		sync(provider, { info() {}, error: (message: string) => errors.push(message) }),
	).rejects.toThrow("could not be published");
	return errors;
}

describe("RunPod Worker templates", () => {
	test("requires one release channel", () => {
		expect(parseArguments(["--production"])).toBe("production");
		expect(parseArguments(["--preview"])).toBe("preview");
		expect(() => parseArguments([])).toThrow("runpod-worker-templates.ts");
		expect(() => parseArguments(["--production", cu128, cu130])).toThrow(
			"runpod-worker-templates.ts",
		);
		expect(() => parseArguments(["--unknown"])).toThrow("runpod-worker-templates.ts");
	});

	test("publishes public state through GraphQL without registry credentials", async () => {
		const provider = runpod();
		const messages: string[] = [];
		const logger = { info: (message: string) => messages.push(message), error() {} };

		await sync(provider, logger);

		expect(provider.patches).toEqual([]);
		expect(provider.saves.find((save) => save.id === "128")).toEqual({
			id: "128",
			name: "kastard-worker-cu128",
			imageName: cu128,
			containerDiskInGb: 50,
			dockerArgs: "",
			env: [],
			ports: "22/tcp,2222/tcp",
			portsConfig: desiredPortsConfig,
			volumeInGb: 150,
			volumeMountPath: "/workspace",
			isPublic: true,
			isServerless: true,
			startJupyter: true,
			startSsh: true,
			advancedStart: true,
			readme,
			startScript: "echo kept",
			category: "NVIDIA",
		});
		expect(provider.templates.get("128")?.env).toEqual({});
		expect(provider.graphQLTemplates.get("128")?.portsConfig).toEqual(
			desiredPortsConfig,
		);
		expect(provider.graphQLTemplates.get("128")?.containerRegistryAuthId).toBe("");
		expect(provider.queries.join("\n")).not.toMatch(/\benv\s*\{/);
		expect(messages.every((message) => message.endsWith("published"))).toBe(true);

		const graphQL128 = provider.graphQLTemplates.get("128");
		if (!graphQL128) throw new Error("Missing GraphQL template 128");
		graphQL128.portsConfig = [...desiredPortsConfig].reverse();
		messages.length = 0;
		await sync(provider, logger);
		expect(provider.patches).toHaveLength(0);
		expect(provider.saves).toHaveLength(2);
		expect(messages.every((message) => message.endsWith("up-to-date"))).toBe(true);
	});

	test("preserves registry credentials for private templates", async () => {
		const provider = runpod();
		await sync(provider, { info() {}, error() {} }, { ...config, isPublic: false });
		expect(provider.saves.find((save) => save.id === "128")).toHaveProperty(
			"containerRegistryAuthId",
			"registry-128",
		);
		expect(provider.graphQLTemplates.get("128")?.containerRegistryAuthId).toBe(
			"registry-128",
		);
	});

	test("fails when the GraphQL read-back ignores the desired labels", async () => {
		const provider = runpod({ ignorePortsConfig: "128" });
		const errors = await syncFailure(provider);
		expect(errors[0]).toContain("cu128");
		expect(errors[0]).toContain("portsConfig");
	});

	test("fails when the public registry credential remains attached", async () => {
		const provider = runpod({ retainRegistryCredential: "128" });
		const errors = await syncFailure(provider);
		expect(errors[0]).toContain("containerRegistryAuthId");
		expect(provider.patches.some(({ id }) => id === "128")).toBe(false);
	});

	test("fails when the REST read-back does not match after GraphQL preparation", async () => {
		const provider = runpod({ ignoreReadme: "128" });
		const errors = await syncFailure(provider);
		expect(errors[0]).toContain("readme");
		expect(provider.saves.some((save) => save.id === "128")).toBe(true);
	});

	test("fails when GraphQL changes preserved state", async () => {
		const provider = runpod({ corruptGraphQLAfterSave: "128" });
		const errors = await syncFailure(provider);
		expect(errors[0]).toContain("startSsh");
	});

	test("reports a partial REST update failure", async () => {
		const provider = runpod({ rejectRest: "130" });
		for (const template of provider.graphQLTemplates.values()) {
			template.portsConfig = desiredPortsConfig;
		}
		const messages = { info: [] as string[], error: [] as string[] };

		await expect(
			sync(
				provider,
				{
					info: (message: string) => messages.info.push(message),
					error: (message: string) => messages.error.push(message),
				},
				{ ...config, isPublic: false },
			),
		).rejects.toThrow("could not be published");
		expect(messages.info[0]).toContain("cu128");
		expect(messages.error[0]).toContain("cu130");
		expect(messages.error[0]).toContain("HTTP 503");
		expect(provider.saves).toEqual([]);
	});

	test("reports a partial GraphQL failure and converges on rerun", async () => {
		const provider = runpod();
		provider.rejectedGraphQL.add("130");
		const messages = { info: [] as string[], error: [] as string[] };
		const logger = {
			info: (message: string) => messages.info.push(message),
			error: (message: string) => messages.error.push(message),
		};

		await expect(sync(provider, logger)).rejects.toThrow("could not be published");
		expect(messages.info[0]).toContain("cu128");
		expect(messages.error[0]).toContain("cu130");
		expect(messages.error[0]).toContain("unavailable");
		expect(provider.templates.get("130")?.env).toEqual({ OBSOLETE_VALUE: "secret" });
		expect(provider.saves.map((save) => save.id)).toEqual(["128"]);

		provider.rejectedGraphQL.delete("130");
		messages.info.length = 0;
		messages.error.length = 0;
		await sync(provider, logger);
		expect(provider.patches).toHaveLength(0);
		expect(provider.saves.map((save) => save.id).sort()).toEqual(["128", "130"]);
		expect(provider.graphQLTemplates.get("130")?.portsConfig).toEqual(
			desiredPortsConfig,
		);
		expect(messages.error).toEqual([]);
	});

	test("does not create a missing provider template", async () => {
		const provider = runpod({ missingRest: "130" });
		const errors = await syncFailure(provider);
		expect(provider.patches.some(({ id }) => id === "130")).toBe(false);
		expect(provider.saves.some((save) => save.id === "130")).toBe(false);
		expect(errors[0]).toContain("HTTP 404");
	});
});
