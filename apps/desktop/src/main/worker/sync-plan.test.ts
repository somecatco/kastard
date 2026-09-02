// @vitest-environment node

import { expect, test } from "vitest";
import type { ModelLibraryEntry } from "../../shared/api";
import {
	createCustomNodeSyncPlan,
	createModelSyncPlan,
	createModelSyncTargets,
} from "./sync-plan";

const artifact = {
	provider: "huggingface" as const,
	modelId: "owner/repository",
	versionId: "a".repeat(40),
	versionLabel: "aaaaaaa",
	fileId: "model.safetensors",
	fileName: "model.safetensors",
	sizeBytes: 123,
};

test("includes selected Manager and clean GitHub packages", () => {
	const commit = "a".repeat(40);
	expect(
		createCustomNodeSyncPlan(
			[
				{
					name: "comfyui-kjnodes",
					version: "1.5.0",
					managerId: "comfyui-kjnodes",
					repository: "https://github.com/kijai/ComfyUI-KJNodes",
					sync: true,
				},
				{
					name: "local-git-node",
					version: commit,
					managerId: null,
					repository: "https://github.com/owner/local-git-node.git",
					sync: true,
				},
				{
					name: "manual-node",
					version: "unknown",
					managerId: null,
					workerSyncIssue: "No supported installation source was found.",
					sync: true,
				},
			],
			"4.2.2",
		),
	).toEqual({
		managerVersion: "4.2.2",
		nodes: [
			{ id: "comfyui-kjnodes", version: "1.5.0" },
			{
				id: "owner/local-git-node",
				version: commit,
				repository: "https://github.com/owner/local-git-node.git",
			},
		],
		unsupportedNodes: [
			{
				name: "manual-node",
				reason: "No supported installation source was found.",
			},
		],
	});
});

test("rejects conflicting versions for the same Manager package", () => {
	expect(() =>
		createCustomNodeSyncPlan(
			[
				{
					name: "first-copy",
					version: "1.0.0",
					managerId: "shared-node",
					sync: true,
				},
				{
					name: "second-copy",
					version: "2.0.0",
					managerId: "shared-node",
					sync: true,
				},
			],
			"4.2.2",
		),
	).toThrow("Multiple installed versions were reported for shared-node.");
});

test("includes only selected resolved models and credentials they use", () => {
	const selected: ModelLibraryEntry = {
		id: "selected",
		name: "Selected",
		sourceUrl: "https://huggingface.co/owner/repository",
		path: "checkpoints/model.safetensors",
		sync: true,
		artifact,
	};
	expect(
		createModelSyncPlan(
			[selected, { ...selected, id: "ignored", name: "Ignored", sync: false }],
			{ huggingface: "hf-token", civitai: "civitai-token" },
		),
	).toEqual({
		models: [{ name: selected.name, path: selected.path, artifact }],
		credentials: { huggingface: "hf-token" },
	});
});

test("rejects selected models without a resolved provider file", () => {
	expect(() =>
		createModelSyncPlan(
			[
				{
					id: "unresolved",
					name: "Unresolved model",
					sourceUrl: "https://huggingface.co/owner/repository",
					path: "checkpoints/unresolved.safetensors",
					sync: true,
					artifact: null,
				},
			],
			{},
		),
	).toThrow("Select a provider file for: Unresolved model.");
});

test("allows an empty model selection only for verification targets", () => {
	expect(createModelSyncTargets([])).toEqual([]);
	expect(() => createModelSyncPlan([], {})).toThrow(
		"Select at least one model to synchronize.",
	);
});
