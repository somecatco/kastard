import { describe, expect, test } from "bun:test";
import {
	type Fetcher,
	getTemplates,
	parseArguments,
	parseTemplateId,
	reportedImage,
	syncTemplates,
	updateTemplate,
	type VastTemplate,
} from "./vastai-worker-templates";
import { parseVastTemplateConfig } from "./worker-template-config";

const cu128 = "ssinss/kastard-worker:kas-149-abcdefg-cu128";
const cu130 = "ssinss/kastard-worker:kas-149-abcdefg-cu130";
const readme = "# Kastard Worker\n\n`SSH_PUBLIC_KEY`";
const environment = {
	required: [],
	optional: [],
};
const dockerOptions = "-p 22:22 -p 2222:2222";
const config = parseVastTemplateConfig({
	templates: {
		cu128: {
			name: "kastard-worker-cu128",
			extra_filters: { cuda_max_good: { gte: 12.8 } },
		},
		cu130: {
			name: "kastard-worker-cu130",
			extra_filters: { cuda_max_good: { gte: 13.0 } },
		},
	},
	desc: "Kastard Worker",
	env: "-p 22:22 -p 2222:2222",
	onstart: "",
	runtype: "args",
	args_str: "",
	ssh_direct: false,
	use_ssh: false,
	readme_visible: true,
	recommended_disk_space: 150,
	private: true,
});

type VastApiTemplate = {
	id: number;
	hash_id: string;
	name: string;
	desc: string;
	readme: string | null;
	readme_hash: string | null;
	readme_visible: boolean;
	image: string;
	tag: string | null;
	env: string;
	onstart: string;
	runtype: string;
	args_str: string | null;
	ssh_direct: boolean;
	use_ssh: boolean;
	extra_filters: { cuda_max_good: { gte: number } } | string | null;
	recommended_disk_space: number;
	private: boolean;
};

function template(
	id: number,
	overrides: Partial<VastApiTemplate> = {},
): VastApiTemplate {
	return {
		id,
		hash_id: `hash-${id}`,
		name: id === 128 ? "kastard-worker-cu128" : "kastard-worker-cu130",
		desc: config.desc,
		readme,
		readme_hash: null,
		readme_visible: config.readme_visible,
		image: "ssinss/kastard-worker",
		tag: id === 128 ? "kas-149-abcdefg-cu128" : "kas-149-abcdefg-cu130",
		env: config.env,
		onstart: config.onstart,
		runtype: config.runtype,
		args_str: config.args_str,
		ssh_direct: config.ssh_direct,
		use_ssh: config.use_ssh,
		extra_filters: config.templates[id === 128 ? "cu128" : "cu130"].extra_filters,
		recommended_disk_space: config.recommended_disk_space,
		private: config.private,
		...overrides,
	};
}

describe("Vast.ai Worker templates", () => {
	test("requires one release channel", () => {
		expect(parseArguments(["--production"])).toBe("production");
		expect(parseArguments(["--beta"])).toBe("beta");
		expect(() => parseArguments([])).toThrow("vastai-worker-templates.ts");
		expect(() => parseArguments(["--production", cu128, cu130])).toThrow(
			"vastai-worker-templates.ts",
		);
		expect(() => parseArguments(["--unknown"])).toThrow("vastai-worker-templates.ts");
	});

	test("validates stable numeric template IDs", () => {
		expect(parseTemplateId("TEMPLATE_ID", "123")).toBe(123);
		expect(() => parseTemplateId("TEMPLATE_ID", "hash-id")).toThrow("positive integer");
		expect(() =>
			parseTemplateId("TEMPLATE_ID", String(Number.MAX_SAFE_INTEGER + 1)),
		).toThrow("safe integer");
	});

	test("looks up every managed field through the current hashes", async () => {
		const requested: { url?: URL; authorization?: string | null } = {};
		const fetcher: Fetcher = async (input, init) => {
			if (input.toString().includes("/readme/readme-130.md")) {
				return new Response(readme);
			}
			requested.url = new URL(input.toString());
			requested.authorization = new Headers(init?.headers).get("Authorization");
			return Response.json({
				success: true,
				templates: [
					template(128, { extra_filters: "null" }),
					template(130, {
						extra_filters: JSON.stringify(config.templates.cu130.extra_filters),
						readme: null,
						readme_hash: "readme-130",
					}),
				],
			});
		};

		const templates = await getTemplates([128, 130], "secret", fetcher);

		expect(requested.authorization).toBe("Bearer secret");
		expect(
			JSON.parse(requested.url?.searchParams.get("select_filters") ?? "null"),
		).toEqual({ id: { in: [128, 130] } });
		const selectedColumns = JSON.parse(
			requested.url?.searchParams.get("select_cols") ?? "null",
		);
		expect(selectedColumns).toEqual(
			expect.arrayContaining([
				"readme_hash",
				"recommended_disk_space",
				"extra_filters",
				"args_str",
			]),
		);
		expect(templates.get(128)?.hashId).toBe("hash-128");
		expect(templates.get(128)?.argsStr).toBe("");
		expect(templates.get(128)?.extraFilters).toBeNull();
		expect(templates.get(130)?.extraFilters).toEqual(
			config.templates.cu130.extra_filters,
		);
		expect(templates.get(130)?.readme).toBe(readme);
	});

	test("rejects missing and malformed template lookup results", async () => {
		const missing: Fetcher = async () =>
			Response.json({ success: true, templates: [template(128)] });
		await expect(getTemplates([128, 130], "secret", missing)).rejects.toThrow(
			"template 130 was not found",
		);

		const invalid: Fetcher = async () =>
			Response.json({
				success: true,
				templates: [template(128, { hash_id: "" }), template(130)],
			});
		await expect(getTemplates([128, 130], "secret", invalid)).rejects.toThrow(
			"unexpected Worker template",
		);
	});

	test("publishes only the configured port options", async () => {
		const current = toVastTemplate(template(128, { hash_id: "old-hash" }));
		let request: RequestInit | undefined;
		const fetcher: Fetcher = async (_input, init) => {
			request = init;
			return Response.json({
				success: true,
				template: { id: 128, hash_id: "new-hash" },
			});
		};

		await updateTemplate(
			current,
			"secret",
			{
				name: "kastard-worker-cu128",
				desc: config.desc,
				readme,
				readmeVisible: config.readme_visible,
				image: "ssinss/kastard-worker",
				tag: "kas-149-abcdefg-cu128",
				env: dockerOptions,
				onstart: config.onstart,
				runtype: config.runtype,
				argsStr: config.args_str,
				sshDirect: config.ssh_direct,
				useSsh: config.use_ssh,
				extraFilters: config.templates.cu128.extra_filters,
				recommendedDiskSpace: config.recommended_disk_space,
				private: config.private,
			},
			fetcher,
		);

		expect(request?.method).toBe("PUT");
		expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer secret");
		const body = JSON.parse(String(request?.body));
		expect(body).toEqual({
			hash_id: "old-hash",
			name: "kastard-worker-cu128",
			desc: "Kastard Worker",
			readme,
			readme_visible: true,
			image: "ssinss/kastard-worker",
			tag: "kas-149-abcdefg-cu128",
			env: dockerOptions,
			onstart: "",
			runtype: "args",
			args_str: "",
			ssh_direct: false,
			use_ssh: false,
			extra_filters: { cuda_max_good: { gte: 12.8 } },
			recommended_disk_space: 150,
			private: true,
		});
		expect(body.env).toBe("-p 22:22 -p 2222:2222");
		expect(body.env).not.toContain("SSH_PUBLIC_KEY");
		expect(body.env).not.toContain("REPLACE_ME");
	});

	test("reports a partial failure and converges on rerun", async () => {
		const state = new Map([
			[
				128,
				template(128, {
					name: "old-128",
					readme: "",
					tag: "old-cu128",
					runtype: "ssh",
					args_str: "--interactive",
					ssh_direct: true,
					use_ssh: true,
				}),
			],
			[
				130,
				template(130, {
					name: "old-130",
					readme: "",
					tag: "old-cu130",
					runtype: "ssh",
					args_str: "--interactive",
					ssh_direct: true,
					use_ssh: true,
				}),
			],
		]);
		let rejectCu130 = true;
		let updateCount = 0;
		const fetcher: Fetcher = async (_input, init) => {
			if (init?.method !== "PUT") {
				return Response.json({ success: true, templates: [...state.values()] });
			}

			updateCount += 1;
			const body = JSON.parse(String(init.body)) as Omit<VastApiTemplate, "id">;
			const id = String(body.hash_id).startsWith("hash-128") ? 128 : 130;
			if (id === 130 && rejectCu130) {
				return new Response("temporarily unavailable", { status: 503 });
			}
			const previous = state.get(id);
			if (!previous) throw new Error(`Unexpected template ${id}`);
			state.set(id, {
				...previous,
				hash_id: `${body.hash_id}-next`,
				name: body.name,
				desc: body.desc,
				readme: body.readme,
				readme_visible: body.readme_visible,
				image: body.image,
				tag: body.tag,
				env: body.env,
				onstart: body.onstart,
				runtype: body.runtype,
				args_str: body.args_str,
				ssh_direct: body.ssh_direct,
				use_ssh: body.use_ssh,
				extra_filters: body.extra_filters,
				recommended_disk_space: body.recommended_disk_space,
				private: body.private,
			});
			return Response.json({ success: true });
		};
		const messages = { info: [] as string[], error: [] as string[] };
		const logger = {
			info: (message: string) => messages.info.push(message),
			error: (message: string) => messages.error.push(message),
		};
		const noSleep = async () => {};

		await expect(
			syncTemplates(
				{ cu128: 128, cu130: 130 },
				"secret",
				{ cu128, cu130 },
				config,
				environment,
				readme,
				fetcher,
				noSleep,
				logger,
			),
		).rejects.toThrow("could not be published");
		expect(state.get(128)?.tag).toBe("kas-149-abcdefg-cu128");
		expect(state.get(128)?.runtype).toBe("args");
		expect(state.get(128)?.args_str).toBe("");
		expect(state.get(128)?.ssh_direct).toBe(false);
		expect(state.get(128)?.use_ssh).toBe(false);
		expect(state.get(130)?.tag).toBe("old-cu130");
		expect(state.get(130)?.runtype).toBe("ssh");
		expect(messages.info[0]).toContain("cu128");
		expect(messages.error[0]).toContain("cu130");

		rejectCu130 = false;
		messages.info.length = 0;
		messages.error.length = 0;
		await syncTemplates(
			{ cu128: 128, cu130: 130 },
			"secret",
			{ cu128, cu130 },
			config,
			environment,
			readme,
			fetcher,
			noSleep,
			logger,
		);
		expect(updateCount).toBe(3);
		expect(state.get(130)?.runtype).toBe("args");
		expect(state.get(130)?.args_str).toBe("");
		expect(state.get(130)?.ssh_direct).toBe(false);
		expect(state.get(130)?.use_ssh).toBe(false);
		expect(messages.info).toHaveLength(2);
		expect(messages.error).toEqual([]);
	});

	test("fails when the read-back does not match the repository configuration", async () => {
		const current = [template(128, { args_str: "--interactive" }), template(130)];
		const fetcher: Fetcher = async (_input, init) => {
			if (init?.method !== "PUT") {
				return Response.json({ success: true, templates: current });
			}
			return Response.json({
				success: true,
				template: { id: 128, hash_id: "ignored-update" },
			});
		};
		const errors: string[] = [];

		await expect(
			syncTemplates(
				{ cu128: 128, cu130: 130 },
				"secret",
				{ cu128, cu130 },
				config,
				environment,
				readme,
				fetcher,
				async () => {},
				{ info() {}, error: (message: string) => errors.push(message) },
			),
		).rejects.toThrow("could not be published");
		expect(errors[0]).toContain("argsStr");
	});

	test("reports split image fields", () => {
		expect(reportedImage(toVastTemplate(template(128)))).toBe(cu128);
		expect(
			reportedImage(toVastTemplate(template(128, { image: cu128, tag: "stale" }))),
		).toBe(`${cu128}:stale`);
	});
});

function toVastTemplate(value: ReturnType<typeof template>): VastTemplate {
	return {
		id: value.id,
		hashId: String(value.hash_id),
		name: String(value.name),
		desc: String(value.desc),
		readme: typeof value.readme === "string" ? value.readme : "",
		readmeHash: value.readme_hash,
		readmeVisible: value.readme_visible,
		image: String(value.image),
		...(typeof value.tag === "string" ? { tag: value.tag } : {}),
		env: String(value.env),
		onstart: String(value.onstart),
		runtype: String(value.runtype),
		argsStr: typeof value.args_str === "string" ? value.args_str : "",
		sshDirect: value.ssh_direct === true,
		useSsh: value.use_ssh === true,
		extraFilters:
			typeof value.extra_filters === "object"
				? value.extra_filters
				: value.extra_filters === "null"
					? null
					: JSON.parse(value.extra_filters),
		recommendedDiskSpace: Number(value.recommended_disk_space),
		private: value.private === true,
	};
}
