import { execFileSync } from "node:child_process";

const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;

function validateSourceRevision(sourceRevision) {
	if (!SOURCE_REVISION_PATTERN.test(sourceRevision)) {
		throw new Error("The release source revision must be a full Git commit SHA.");
	}
}

export function readSourceRevision(root) {
	const revision = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	validateSourceRevision(revision);
	return revision;
}

export function readJsonAtRevision(root, path, sourceRevision) {
	validateSourceRevision(sourceRevision);
	let contents;
	try {
		contents = execFileSync("git", ["show", `${sourceRevision}:${path}`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		throw new Error(`Cannot read ${path} at source revision ${sourceRevision}.`);
	}

	try {
		return JSON.parse(contents);
	} catch (error) {
		throw new Error(
			`Cannot parse ${path} at source revision ${sourceRevision}: ${error.message}`,
		);
	}
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
