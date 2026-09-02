import { execFileSync } from "node:child_process";

const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;

export function readSourceRevision(root) {
	const revision = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	if (!SOURCE_REVISION_PATTERN.test(revision)) {
		throw new Error("The release source revision must be a full Git commit SHA.");
	}
	return revision;
}

export function verifyProductionLineage(root, release) {
	if (release.channel !== "production") return;

	let previewRevision;
	try {
		previewRevision = execFileSync(
			"git",
			["rev-parse", `refs/tags/${release.previewTag}^{commit}`],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
	} catch {
		throw new Error(
			`Production requires ${release.previewTag} on the same source revision.`,
		);
	}
	if (previewRevision !== release.sourceRevision) {
		throw new Error(
			`${release.previewTag} must point to the Production source revision ${release.sourceRevision}.`,
		);
	}
}
