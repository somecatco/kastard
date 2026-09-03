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

	const escapedPreviewTag = release.previewTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const previewTagPattern = new RegExp(`^${escapedPreviewTag}(?:-[1-9]\\d*)?$`);
	const previewTags = execFileSync(
		"git",
		["tag", "--list", release.previewTag, `${release.previewTag}-*`],
		{ cwd: root, encoding: "utf8" },
	)
		.split("\n")
		.filter((tag) => previewTagPattern.test(tag));

	if (previewTags.length === 0) {
		throw new Error(
			`Production requires ${release.previewTag} or a numbered suffix on the same source revision.`,
		);
	}

	for (const previewTag of previewTags) {
		const previewRevision = execFileSync(
			"git",
			["rev-parse", `refs/tags/${previewTag}^{commit}`],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		if (previewRevision === release.sourceRevision) return;
	}

	throw new Error(
		`${previewTags.join(", ")} must point to the Production source revision ${release.sourceRevision}.`,
	);
}
