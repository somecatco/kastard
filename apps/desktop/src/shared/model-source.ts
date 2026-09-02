export type HuggingFaceSourcePath = {
	modelId: string;
	revision: string | null;
	filePath: string | null;
};

const CIVITAI_AIR_PATTERN =
	/^(?:urn:air:[^:\s]+:[^:\s]+:)?civitai:([1-9]\d*)@([1-9]\d*)(?:\+([1-9]\d*))?$/u;

const RESERVED_HUGGING_FACE_NAMESPACES = new Set(["api", "datasets", "spaces"]);
const FILE_PATH_MARKERS = new Set(["blob", "resolve"]);

export function normalizeModelSourceUrl(value: string): string {
	const source = value.trim();
	const air = CIVITAI_AIR_PATTERN.exec(source);
	if (air === null) return source;
	const [, modelId, versionId, fileId] = air;
	return `https://civitai.com/models/${modelId}?modelVersionId=${versionId}${fileId === undefined ? "" : `&modelFileId=${fileId}`}`;
}

export function parseHuggingFaceSourcePath(
	pathname: string,
): HuggingFaceSourcePath | null {
	let segments: string[];
	try {
		segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return null;
	}
	if (
		segments.length === 0 ||
		RESERVED_HUGGING_FACE_NAMESPACES.has(segments[0] ?? "")
	) {
		return null;
	}
	if (segments.length === 1 || segments.length === 2) {
		return {
			modelId: segments.join("/"),
			revision: null,
			filePath: null,
		};
	}

	const markerIndex = FILE_PATH_MARKERS.has(segments[1] ?? "")
		? 1
		: FILE_PATH_MARKERS.has(segments[2] ?? "")
			? 2
			: -1;
	if (markerIndex < 1 || segments.length < markerIndex + 3) return null;

	return {
		modelId: segments.slice(0, markerIndex).join("/"),
		revision: segments[markerIndex + 1] ?? null,
		filePath: segments.slice(markerIndex + 2).join("/"),
	};
}
