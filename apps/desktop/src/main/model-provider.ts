import type { ModelArtifact, ModelProvider } from "../shared/api";
import {
	normalizeModelSourceUrl,
	parseHuggingFaceSourcePath,
} from "../shared/model-source";
import { hasSupportedModelExtension } from "./model-file";

const REQUEST_TIMEOUT_MS = 10_000;
const SECRET_QUERY_KEY = /(?:api.?key|auth|credential|secret|signature|token)/i;

type TokenReader = (provider: ModelProvider) => string | null;

type ProviderSource =
	| {
			provider: "huggingface";
			modelId: string;
			revision: string | null;
			filePath: string | null;
	  }
	| {
			provider: "civitai";
			modelId: string;
			versionId: string | null;
			fileId: string | null;
	  };

type ModelProviderInfo = {
	modelName: string;
	files: ModelArtifact[];
};

export async function resolveModelProviderInfo(
	sourceUrl: string,
	getToken: TokenReader,
	request: typeof fetch = fetch,
): Promise<ModelProviderInfo> {
	const source = parseProviderSource(sourceUrl);
	const response = await fetchProvider(source, getToken, request);
	const data = await responseJson(response, source.provider);
	const info =
		source.provider === "huggingface"
			? huggingFaceInfo(data, source.modelId, source.filePath)
			: civitaiInfo(data, source.modelId, source.versionId, source.fileId);
	if (info.files.length === 0) {
		throw new Error("No supported model files were found at this URL.");
	}
	return info;
}

export async function verifyModelProviderArtifact(
	sourceUrl: string,
	artifact: ModelArtifact | null,
	getToken: TokenReader,
	request: typeof fetch = fetch,
): Promise<void> {
	if (artifact === null) return;
	const info = await resolveModelProviderInfo(sourceUrl, getToken, request);
	if (!info.files.some((file) => modelArtifactsEqual(file, artifact))) {
		throw new Error(
			"The selected model file does not match current provider metadata.",
		);
	}
}

function parseProviderSource(value: string): ProviderSource {
	let url: URL;
	try {
		url = new URL(normalizeModelSourceUrl(value));
	} catch {
		throw new Error("Enter a supported model URL.");
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error("Model URLs must use HTTPS without embedded credentials.");
	}
	for (const key of url.searchParams.keys()) {
		if (SECRET_QUERY_KEY.test(key)) {
			throw new Error("Model URLs cannot contain access tokens or credentials.");
		}
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	if (host === "huggingface.co") return parseHuggingFaceSource(url);
	if (host === "civitai.com" || host === "civit.ai") return parseCivitaiSource(url);
	throw new Error("Model URLs must use Hugging Face or CivitAI.");
}

function parseHuggingFaceSource(url: URL): ProviderSource {
	try {
		decodeURIComponent(url.pathname);
	} catch {
		throw new Error("Enter a supported model URL.");
	}
	const source = parseHuggingFaceSourcePath(url.pathname);
	if (source === null) {
		throw new Error("Enter a Hugging Face model repository URL.");
	}
	return { provider: "huggingface", ...source };
}

function parseCivitaiSource(url: URL): ProviderSource {
	const segments = pathSegments(url);
	if (segments[0] !== "models" || !isPositiveInteger(segments[1])) {
		throw new Error("Enter a CivitAI model page URL.");
	}
	const versionId = url.searchParams.get("modelVersionId");
	if (versionId !== null && !isPositiveInteger(versionId)) {
		throw new Error("The CivitAI model version is invalid.");
	}
	const fileId = url.searchParams.get("modelFileId");
	if (fileId !== null && !isPositiveInteger(fileId)) {
		throw new Error("The CivitAI model file is invalid.");
	}
	return { provider: "civitai", modelId: segments[1], versionId, fileId };
}

async function fetchProvider(
	source: ProviderSource,
	getToken: TokenReader,
	request: typeof fetch,
): Promise<Response> {
	let response = await requestProvider(source, null, request);
	if (response.status === 401 || response.status === 403) {
		const token = getToken(source.provider);
		if (token !== null) response = await requestProvider(source, token, request);
	}
	if (response.ok) return response;
	if (response.status === 401 || response.status === 403) {
		throw new Error(
			`Access to this model requires a valid ${providerLabel(source.provider)} token.`,
		);
	}
	if (response.status === 404) {
		throw new Error(`The ${providerLabel(source.provider)} model could not be found.`);
	}
	if (response.status === 429) {
		throw new Error(`The ${providerLabel(source.provider)} rate limit was reached.`);
	}
	throw new Error(`${providerLabel(source.provider)} could not provide model files.`);
}

async function requestProvider(
	source: ProviderSource,
	token: string | null,
	request: typeof fetch,
): Promise<Response> {
	const url = providerApiUrl(source);
	const allowsCanonicalRedirect =
		source.provider === "huggingface" && !source.modelId.includes("/");
	const response = await sendProviderRequest(
		source,
		url,
		token,
		request,
		allowsCanonicalRedirect ? "manual" : "error",
	);
	if (!allowsCanonicalRedirect) return response;
	const canonicalUrl = huggingFaceCanonicalRedirect(response, url, source);
	return canonicalUrl === null
		? response
		: sendProviderRequest(source, canonicalUrl, token, request, "error");
}

async function sendProviderRequest(
	source: ProviderSource,
	url: URL,
	token: string | null,
	request: typeof fetch,
	redirect: "error" | "manual",
): Promise<Response> {
	const headers = new Headers({ Accept: "application/json" });
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);
	try {
		return await request(url, {
			headers,
			redirect,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			throw new Error(`The ${providerLabel(source.provider)} request timed out.`);
		}
		throw new Error(`Could not reach ${providerLabel(source.provider)}.`);
	}
}

function providerApiUrl(source: ProviderSource): URL {
	if (source.provider === "huggingface") {
		const modelPath = source.modelId.split("/").map(encodeURIComponent).join("/");
		const revisionPath =
			source.revision === null
				? ""
				: `/revision/${encodeURIComponent(source.revision)}`;
		return new URL(
			`https://huggingface.co/api/models/${modelPath}${revisionPath}?blobs=true`,
		);
	}
	return new URL(`https://civitai.com/api/v1/models/${source.modelId}`);
}

function huggingFaceCanonicalRedirect(
	response: Response,
	requestUrl: URL,
	source: Extract<ProviderSource, { provider: "huggingface" }>,
): URL | null {
	if (![301, 302, 307, 308].includes(response.status)) return null;
	const location = response.headers.get("location");
	if (location === null) return null;
	let target: URL;
	try {
		target = new URL(location, requestUrl);
	} catch {
		return null;
	}
	if (
		target.origin !== requestUrl.origin ||
		target.username ||
		target.password ||
		target.hash ||
		target.search !== "?blobs=true"
	) {
		return null;
	}
	const segments = pathSegments(target);
	const matchesRevision =
		source.revision === null
			? segments.length === 4
			: segments.length === 6 &&
				segments[4] === "revision" &&
				segments[5] === source.revision;
	return matchesRevision &&
		segments[0] === "api" &&
		segments[1] === "models" &&
		segments[3] === source.modelId
		? target
		: null;
}

async function responseJson(
	response: Response,
	provider: ModelProvider,
): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${providerLabel(provider)} returned invalid model metadata.`);
	}
}

function huggingFaceInfo(
	value: unknown,
	modelId: string,
	selectedFilePath: string | null,
): ModelProviderInfo {
	if (typeof value !== "object" || value === null) throw invalidMetadata("huggingface");
	const response = value as {
		id?: unknown;
		modelId?: unknown;
		sha?: unknown;
		siblings?: unknown;
	};
	const providerModelId =
		typeof response.modelId === "string" ? response.modelId : response.id;
	if (
		typeof providerModelId !== "string" ||
		typeof response.sha !== "string" ||
		!Array.isArray(response.siblings)
	) {
		throw invalidMetadata("huggingface");
	}
	const files: ModelArtifact[] = [];
	for (const sibling of response.siblings) {
		if (typeof sibling !== "object" || sibling === null) continue;
		const file = sibling as { rfilename?: unknown; size?: unknown };
		if (
			typeof file.rfilename !== "string" ||
			(selectedFilePath !== null && file.rfilename !== selectedFilePath) ||
			!hasSupportedModelExtension(file.rfilename) ||
			!isPositiveSafeInteger(file.size)
		) {
			continue;
		}
		files.push({
			provider: "huggingface",
			modelId,
			versionId: response.sha,
			versionLabel: response.sha.slice(0, 7),
			fileId: file.rfilename,
			fileName: file.rfilename,
			sizeBytes: file.size,
		});
	}
	const modelName = modelNameFromId(providerModelId);
	return {
		modelName:
			selectedFilePath === null
				? modelName
				: (modelNameFromFilePath(selectedFilePath) ?? modelName),
		files,
	};
}

function civitaiInfo(
	value: unknown,
	modelId: string,
	selectedVersionId: string | null,
	selectedFileId: string | null,
): ModelProviderInfo {
	if (typeof value !== "object" || value === null) throw invalidMetadata("civitai");
	const response = value as { id?: unknown; name?: unknown; modelVersions?: unknown };
	if (
		String(response.id) !== modelId ||
		typeof response.name !== "string" ||
		response.name.trim().length === 0 ||
		!Array.isArray(response.modelVersions)
	) {
		throw invalidMetadata("civitai");
	}
	const files: ModelArtifact[] = [];
	for (const candidateVersion of response.modelVersions) {
		if (typeof candidateVersion !== "object" || candidateVersion === null) continue;
		const version = candidateVersion as {
			id?: unknown;
			name?: unknown;
			files?: unknown;
		};
		const versionId = String(version.id);
		if (
			!isPositiveInteger(versionId) ||
			typeof version.name !== "string" ||
			!Array.isArray(version.files) ||
			(selectedVersionId !== null && versionId !== selectedVersionId)
		) {
			continue;
		}
		for (const candidateFile of version.files) {
			if (typeof candidateFile !== "object" || candidateFile === null) continue;
			const file = candidateFile as { id?: unknown; name?: unknown; sizeKB?: unknown };
			const fileId = String(file.id);
			if (
				!isPositiveInteger(fileId) ||
				(selectedFileId !== null && fileId !== selectedFileId) ||
				typeof file.name !== "string" ||
				!hasSupportedModelExtension(file.name) ||
				typeof file.sizeKB !== "number" ||
				!Number.isFinite(file.sizeKB) ||
				file.sizeKB <= 0
			) {
				continue;
			}
			const sizeBytes = Math.round(file.sizeKB * 1024);
			if (!isPositiveSafeInteger(sizeBytes)) continue;
			files.push({
				provider: "civitai",
				modelId,
				versionId,
				versionLabel: version.name,
				fileId,
				fileName: file.name,
				sizeBytes,
			});
		}
	}
	const modelName = response.name.trim();
	const onlyFile = files.length === 1 ? files.at(0) : undefined;
	return {
		modelName: onlyFile
			? (modelNameFromFilePath(onlyFile.fileName) ?? modelName)
			: modelName,
		files,
	};
}

function modelNameFromId(value: string): string {
	const name = value.split("/").filter(Boolean).at(-1)?.trim();
	if (!name) throw invalidMetadata("huggingface");
	return name;
}

function modelNameFromFilePath(value: string): string | null {
	const fileName = value.split("/").at(-1)?.trim();
	const extensionIndex = fileName?.lastIndexOf(".") ?? -1;
	return extensionIndex > 0
		? fileName?.slice(0, extensionIndex).replaceAll("_", " ").trim() || null
		: null;
}

function pathSegments(url: URL): string[] {
	try {
		return url.pathname
			.split("/")
			.filter(Boolean)
			.map((segment) => decodeURIComponent(segment));
	} catch {
		throw new Error("Enter a supported model URL.");
	}
}

function isPositiveInteger(value: string | undefined): value is string {
	return value !== undefined && /^[1-9]\d*$/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function providerLabel(provider: ModelProvider): string {
	return provider === "huggingface" ? "Hugging Face" : "CivitAI";
}

function invalidMetadata(provider: ModelProvider): Error {
	return new Error(`${providerLabel(provider)} returned invalid model metadata.`);
}

export function modelArtifactsEqual(
	left: ModelArtifact | null,
	right: ModelArtifact | null,
): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.provider === right.provider &&
		left.modelId === right.modelId &&
		left.versionId === right.versionId &&
		left.versionLabel === right.versionLabel &&
		left.fileId === right.fileId &&
		left.fileName === right.fileName &&
		left.sizeBytes === right.sizeBytes
	);
}
