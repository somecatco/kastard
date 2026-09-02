import { describe, expect, test } from "vitest";
import { normalizeModelSourceUrl } from "./model-source";

describe("model source URLs", () => {
	test.each([
		"civitai:1318945@3218603",
		"urn:air:sdxl:checkpoint:civitai:1318945@3218603",
	])("normalizes CivitAI AIR %s to its model version URL", (source) => {
		expect(normalizeModelSourceUrl(source)).toBe(
			"https://civitai.com/models/1318945?modelVersionId=3218603",
		);
	});

	test("trims existing model URLs without changing them", () => {
		expect(
			normalizeModelSourceUrl(
				"  https://huggingface.co/black-forest-labs/FLUX.1-dev  ",
			),
		).toBe("https://huggingface.co/black-forest-labs/FLUX.1-dev");
	});

	test("preserves a CivitAI AIR model file selection", () => {
		expect(
			normalizeModelSourceUrl("urn:air:anima:lora:civitai:599757@3226360+3108500"),
		).toBe(
			"https://civitai.com/models/599757?modelVersionId=3226360&modelFileId=3108500",
		);
	});

	test.each([
		"civitai:1318945",
		"civitai:0@3218603",
		"civitai:1318945@0",
		"civitai:1318945@3218603+0",
		"urn:air:sdxl:checkpoint:huggingface:1318945@3218603",
	])("does not normalize unsupported AIR %s", (source) => {
		expect(normalizeModelSourceUrl(source)).toBe(source);
	});
});
