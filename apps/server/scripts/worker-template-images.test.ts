import { describe, expect, test } from "bun:test";
import {
	parseImagePairs,
	workerTemplateIdEnvironmentName,
	workerTemplateName,
} from "./worker-template-images";

const cu128 = "ssinss/kastard-worker:kas-111-abcdefg-cu128";
const cu130 = "ssinss/kastard-worker:kas-111-abcdefg-cu130";
const productionCu128 = "somecatco/kastard-worker-cu128:0.1.0-build.7-aaaaaaa";
const productionCu130 = "somecatco/kastard-worker-cu130:0.1.0-build.7-aaaaaaa";

describe("Worker template images", () => {
	test("selects Production and Preview template identities", () => {
		expect(workerTemplateIdEnvironmentName("RUNPOD", "cu128", "production")).toBe(
			"RUNPOD_WORKER_TEMPLATE_ID_CU128",
		);
		expect(workerTemplateIdEnvironmentName("RUNPOD", "cu130", "preview")).toBe(
			"RUNPOD_WORKER_TEMPLATE_ID_PREVIEW_CU130",
		);
		expect(workerTemplateIdEnvironmentName("VAST", "cu128", "preview")).toBe(
			"VAST_WORKER_TEMPLATE_ID_PREVIEW_CU128",
		);
		expect(workerTemplateName("cu128", "production")).toBe("kastard-worker-cu128");
		expect(workerTemplateName("cu130", "preview")).toBe("kastard-worker-preview-cu130");
	});

	test("parses the complete runtime image pair", () => {
		expect(parseImagePairs(`cu128\t${cu128}\ncu130\t${cu130}\n`)).toEqual({
			cu128,
			cu130,
		});
	});

	test("parses runtime names from production image repositories", () => {
		expect(
			parseImagePairs(`cu128\t${productionCu128}\ncu130\t${productionCu130}\n`),
		).toEqual({
			cu128: productionCu128,
			cu130: productionCu130,
		});
	});

	test("rejects missing, duplicate, and mismatched runtime images", () => {
		expect(() => parseImagePairs(`cu128\t${cu128}`)).toThrow("Missing cu130");
		expect(() => parseImagePairs(`cu128\t${cu128}\ncu128\t${cu128}`)).toThrow(
			"unexpected result",
		);
		expect(() => parseImagePairs(`cu128\t${cu130}\ncu130\t${cu128}`)).toThrow(
			"Missing cu128",
		);
		expect(() =>
			parseImagePairs(`cu128\t${productionCu130}\ncu130\t${productionCu128}`),
		).toThrow("Missing cu128");
	});
});
