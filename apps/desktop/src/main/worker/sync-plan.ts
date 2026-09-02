import {
	type CustomNodeSyncTarget,
	isCustomNodeManagerVersion,
	isGitCommit,
	normalizeGitHubRepository,
} from "@kastard/common";
import type {
	CustomNodeEntry,
	ModelLibraryEntry,
	ModelProvider,
	ModelSyncRequest,
	UnsupportedCustomNode,
} from "../../shared/api";

export type CustomNodeSyncPlan = {
	managerVersion: string;
	nodes: CustomNodeSyncTarget[];
	unsupportedNodes: UnsupportedCustomNode[];
};

const INVALID_SYNC_METADATA =
	"No reproducible Registry package or GitHub repository commit was found.";

export function createCustomNodeSyncPlan(
	entries: readonly CustomNodeEntry[],
	managerVersion: string,
): CustomNodeSyncPlan {
	if (!isCustomNodeManagerVersion(managerVersion)) {
		throw new Error("ComfyUI Manager returned an invalid version.");
	}
	const nodes: CustomNodeSyncTarget[] = [];
	const unsupportedNodes: UnsupportedCustomNode[] = [];
	const selectedVersions = new Map<string, string>();
	for (const node of entries) {
		if (!node.sync) continue;
		if (node.workerSyncIssue !== undefined) {
			unsupportedNodes.push({ name: node.name, reason: node.workerSyncIssue });
			continue;
		}
		if (node.managerId !== null) {
			addTarget({ id: node.managerId, version: node.version });
			continue;
		}
		if (node.repository !== undefined) {
			const repository = normalizeGitHubRepository(node.repository);
			if (
				repository === null ||
				repository.url !== node.repository ||
				!isGitCommit(node.version)
			) {
				unsupportedNodes.push({ name: node.name, reason: INVALID_SYNC_METADATA });
				continue;
			}
			addTarget({
				id: repository.id,
				version: node.version,
				repository: repository.url,
			});
			continue;
		}
		unsupportedNodes.push({ name: node.name, reason: INVALID_SYNC_METADATA });
	}
	return { managerVersion, nodes, unsupportedNodes };

	function addTarget(target: CustomNodeSyncTarget): void {
		const existingVersion = selectedVersions.get(target.id);
		if (existingVersion === target.version) return;
		if (existingVersion !== undefined) {
			throw new Error(`Multiple installed versions were reported for ${target.id}.`);
		}
		selectedVersions.set(target.id, target.version);
		nodes.push(target);
	}
}

export function createModelSyncPlan(
	entries: readonly ModelLibraryEntry[],
	tokens: Partial<Record<ModelProvider, string | null>>,
): ModelSyncRequest {
	const models = createModelSyncTargets(entries);
	if (models.length === 0) throw new Error("Select at least one model to synchronize.");
	const providers = new Set(models.map((model) => model.artifact.provider));
	const credentials: ModelSyncRequest["credentials"] = {};
	for (const provider of providers) {
		const token = tokens[provider];
		if (token !== null && token !== undefined) credentials[provider] = token;
	}
	return { models, credentials };
}

export function createModelSyncTargets(
	entries: readonly ModelLibraryEntry[],
): ModelSyncRequest["models"] {
	const selected = entries.filter((entry) => entry.sync);
	const unresolved = selected.filter((entry) => entry.artifact === null);
	if (unresolved.length > 0) {
		throw new Error(
			`Select a provider file for: ${unresolved
				.slice(0, 5)
				.map((entry) => entry.name)
				.join(", ")}.`,
		);
	}

	return selected.map((entry) => {
		if (entry.artifact === null) throw new Error("Model artifact is unavailable.");
		return { name: entry.name, path: entry.path, artifact: entry.artifact };
	});
}
