import { describe, expect, test } from "bun:test";
import {
	loadWorkerTemplateFiles,
	parseRunpodTemplateConfig,
	parseVastTemplateConfig,
	parseWorkerEnvironmentConfig,
} from "./worker-template-config";

const runpodConfig = {
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
};

const vastConfig = {
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
	private: false,
};

describe("Worker template configuration", () => {
	test("loads the repository-owned template files", async () => {
		const files = await loadWorkerTemplateFiles();

		expect(files.runpod.templates.cu128.name).toBe("kastard-worker-cu128");
		expect(files.resources.workerTemplates.runpod.production.cu128).toMatch(
			/^[a-z0-9]+$/,
		);
		expect(files.resources.workerTemplates.vastAi.preview.cu130).toBeGreaterThan(0);
		expect(files.runpod.volumeInGb).toBe(200);
		expect(files.runpod.isPublic).toBe(true);
		expect(files.vastai.templates.cu130.name).toBe("kastard-worker-cu130");
		expect(files.vastai.recommended_disk_space).toBe(200);
		expect(files.vastai.private).toBe(false);
		expect(files.vastai.templates.cu128.extra_filters).toEqual({
			cuda_max_good: { gte: 12.8 },
		});
		expect(files.vastai.env).toBe("-p 22:22 -p 2222:2222");
		expect(files.vastai.runtype).toBe("args");
		expect(files.vastai.args_str).toBe("");
		expect(files.vastai.ssh_direct).toBe(false);
		expect(files.vastai.use_ssh).toBe(false);
		expect(files.vastai.readme_visible).toBe(true);
		expect(files.runpod.portsConfig).toEqual([
			{ port: 22, name: "SSH Tunnel" },
			{ port: 2222, name: "SSH" },
		]);
		expect(files.environment).toEqual({
			required: [],
			optional: [],
		});
		expect(files.readme).toContain("`SSH_PUBLIC_KEY`");
	});

	test("validates RunPod port labels", () => {
		expect(
			parseRunpodTemplateConfig({
				...runpodConfig,
				portsConfig: [{ port: 22, name: "  SSH Tunnel  " }],
			}).portsConfig,
		).toEqual([{ port: 22, name: "SSH Tunnel" }]);
		expect(
			parseRunpodTemplateConfig({
				...runpodConfig,
				ports: ["8888/http"],
				portsConfig: [{ port: 8888, name: "ComfyUI" }],
			}).portsConfig,
		).toEqual([{ port: 8888, name: "ComfyUI" }]);
		expect(() =>
			parseRunpodTemplateConfig({
				...runpodConfig,
				portsConfig: [{ port: 0, name: "SSH Tunnel" }],
			}),
		).toThrow("portsConfig[0].port must be a positive integer");
		expect(() =>
			parseRunpodTemplateConfig({
				...runpodConfig,
				ports: ["65536/tcp"],
				portsConfig: [{ port: 65_536, name: "Invalid" }],
			}),
		).toThrow("portsConfig[0].port must not exceed 65535");
		expect(() =>
			parseRunpodTemplateConfig({
				...runpodConfig,
				portsConfig: [{ port: 22, name: "" }],
			}),
		).toThrow("portsConfig[0].name must not be empty");
		expect(() =>
			parseRunpodTemplateConfig({
				...runpodConfig,
				portsConfig: [{ port: 22, name: "   " }],
			}),
		).toThrow("portsConfig[0].name must not be empty");
		expect(() =>
			parseRunpodTemplateConfig({
				...runpodConfig,
				portsConfig: [
					{ port: 22, name: "SSH Tunnel" },
					{ port: 22, name: "SSH" },
				],
			}),
		).toThrow("portsConfig ports must be unique");
		expect(() =>
			parseRunpodTemplateConfig({
				...runpodConfig,
				portsConfig: [{ port: 80, name: "HTTP" }],
			}),
		).toThrow("portsConfig port 80 must exist in ports");
	});

	test("requires a minimum CUDA version for each Vast.ai runtime", () => {
		expect(() =>
			parseVastTemplateConfig({
				...vastConfig,
				templates: {
					...vastConfig.templates,
					cu130: {
						name: "kastard-worker-cu130",
						extra_filters: { cuda_max_good: { gte: 0 } },
					},
				},
			}),
		).toThrow("cuda_max_good.gte must be a positive number");
	});

	test("requires both Worker runtimes", () => {
		expect(() =>
			parseRunpodTemplateConfig({
				...runpodConfig,
				templates: { cu128: { name: "kastard-worker-cu128" } },
			}),
		).toThrow("RunPod templates.cu130");
	});

	test("rejects environment values in provider templates", () => {
		expect(() =>
			parseRunpodTemplateConfig({
				...runpodConfig,
				env: { HF_TOKEN: "secret" },
			}),
		).toThrow("when a Pod is created");
		expect(() =>
			parseVastTemplateConfig({
				...vastConfig,
				env: "-e HF_TOKEN=secret -p 22:22",
			}),
		).toThrow("when an instance is created");
	});

	test("requires unique valid environment declarations", () => {
		expect(() =>
			parseWorkerEnvironmentConfig({
				required: ["HF_TOKEN"],
				optional: ["HF_TOKEN"],
			}),
		).toThrow("must be unique");
		expect(() =>
			parseWorkerEnvironmentConfig({ required: ["invalid-name"], optional: [] }),
		).toThrow("invalid environment variable name");
	});
});
