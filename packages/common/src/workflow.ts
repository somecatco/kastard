import { isCanonicalUuid, isRecord, isSha256 } from "./validation";

export type WorkflowInputReference = {
	nodeId: string;
	inputName: string;
	value: string;
};

export type WorkflowInputManifestEntry = {
	id: string;
	name: string;
	size: number;
	sha256: string;
	references: WorkflowInputReference[];
};

export type WorkflowInputProblem = {
	reason:
		| "missing"
		| "too-large"
		| "invalid-reference"
		| "snapshot-failed"
		| "transfer-failed"
		| "checksum-mismatch";
	name: string;
	nodeId?: string;
	inputName?: string;
};

export type WorkflowInputFailure = {
	code: "input_failed";
	message: string;
	problems: WorkflowInputProblem[];
};

export type WorkflowPreflightProblem = {
	kind: "core" | "model" | "custom_node" | "node";
	reason:
		| "not-ready"
		| "version-mismatch"
		| "missing"
		| "conflict"
		| "stale"
		| "unexpected"
		| "unsupported"
		| "syncing"
		| "unavailable"
		| "invalid";
	name: string;
	expected: string | null;
	actual: string | null;
	nodeId?: string;
	inputName?: string;
};

export type WorkflowJobFailure =
	| {
			code: "preflight_failed";
			message: string;
			problems: WorkflowPreflightProblem[];
	  }
	| WorkflowInputFailure
	| {
			code: "connection_lost" | "execution_failed" | "result_failed";
			message: string;
	  };

export type WorkflowJobState =
	| { id: string; status: "running" }
	| { id: string; status: "canceling" }
	| { id: string; status: "canceled" }
	| { id: string; status: "completed" }
	| {
			id: string;
			status: "failed";
			error: string;
			failure: WorkflowJobFailure;
	  };

export type ParsedWorkflowJobState =
	| Exclude<WorkflowJobState, { status: "failed" }>
	| { id: string; status: "failed"; error: WorkflowJobFailure };

export type WorkflowJobRequest = {
	prompt: unknown;
	inputs: WorkflowInputManifestEntry[];
	extra_data: unknown;
};

type WorkflowJobRequestIssue = "request" | "inputs";

type WorkflowJobRequestParseResult =
	| { ok: true; value: WorkflowJobRequest }
	| { ok: false; issue: WorkflowJobRequestIssue };

export type WorkflowJobRejection = {
	accepted: false;
	error: string;
	retryable: boolean;
};

export type WorkflowResultFile = {
	id: string;
	filename: string;
	subfolder: string;
	type: "input" | "output" | "temp";
	size: number;
	sha256: string;
	contentType: string;
};

export type WorkflowResultManifest = {
	id: string;
	outputs: unknown;
	files: WorkflowResultFile[];
};

export function isWorkflowJobId(value: unknown): value is string {
	return isCanonicalUuid(value);
}

export function parseWorkflowJobRequest(
	jobId: unknown,
	value: unknown,
): WorkflowJobRequestParseResult {
	if (!isWorkflowJobId(jobId) || !isRecord(value) || !("prompt" in value)) {
		return { ok: false, issue: "request" };
	}
	const extraData = "extra_data" in value ? value.extra_data : {};
	const inputs = parseWorkflowInputs("inputs" in value ? value.inputs : []);
	if (inputs === null) return { ok: false, issue: "inputs" };
	return {
		ok: true,
		value: { prompt: value.prompt, inputs, extra_data: extraData },
	};
}

export function parseWorkflowJobState(value: unknown): ParsedWorkflowJobState | null {
	if (!isRecord(value) || typeof value.id !== "string") return null;
	if (
		value.status === "running" ||
		value.status === "canceling" ||
		value.status === "canceled" ||
		value.status === "completed"
	) {
		return { id: value.id, status: value.status };
	}
	if (value.status !== "failed") return null;
	if (typeof value.error !== "string") return null;
	const failure = parseWorkflowJobFailure(value.failure);
	return failure === null ? null : { id: value.id, status: "failed", error: failure };
}

function parseWorkflowJobFailure(value: unknown): WorkflowJobFailure | null {
	if (!isRecord(value) || typeof value.message !== "string") return null;
	if (
		value.code === "connection_lost" ||
		value.code === "execution_failed" ||
		value.code === "result_failed"
	) {
		return { code: value.code, message: value.message };
	}
	if (value.code === "input_failed") {
		return Array.isArray(value.problems) && value.problems.every(isWorkflowInputProblem)
			? { code: "input_failed", message: value.message, problems: value.problems }
			: null;
	}
	return value.code === "preflight_failed" &&
		Array.isArray(value.problems) &&
		value.problems.every(isWorkflowPreflightProblem)
		? { code: "preflight_failed", message: value.message, problems: value.problems }
		: null;
}

export function parseWorkflowJobRejection(value: unknown): WorkflowJobRejection | null {
	return isRecord(value) &&
		value.accepted === false &&
		typeof value.error === "string" &&
		typeof value.retryable === "boolean"
		? { accepted: false, error: value.error, retryable: value.retryable }
		: null;
}

export function parseWorkflowResultManifest(
	value: unknown,
): WorkflowResultManifest | null {
	return isRecord(value) &&
		isWorkflowJobId(value.id) &&
		Array.isArray(value.files) &&
		value.files.every(isWorkflowResultFile) &&
		"outputs" in value
		? { id: value.id, outputs: value.outputs, files: value.files }
		: null;
}

export function isWorkflowResultFile(value: unknown): value is WorkflowResultFile {
	return (
		isRecord(value) &&
		isSha256(value.id) &&
		typeof value.filename === "string" &&
		isBasename(value.filename) &&
		typeof value.subfolder === "string" &&
		(value.type === "input" || value.type === "output" || value.type === "temp") &&
		typeof value.size === "number" &&
		Number.isSafeInteger(value.size) &&
		value.size >= 0 &&
		isSha256(value.sha256) &&
		typeof value.contentType === "string" &&
		!/[\r\n]/u.test(value.contentType)
	);
}

function parseWorkflowInputs(value: unknown): WorkflowInputManifestEntry[] | null {
	if (!Array.isArray(value)) return null;
	const inputs: WorkflowInputManifestEntry[] = [];
	for (const input of value) {
		if (
			!isRecord(input) ||
			typeof input.id !== "string" ||
			typeof input.name !== "string" ||
			typeof input.size !== "number" ||
			typeof input.sha256 !== "string" ||
			!Array.isArray(input.references) ||
			!input.references.every(isWorkflowInputReference)
		) {
			return null;
		}
		inputs.push({
			id: input.id,
			name: input.name,
			size: input.size,
			sha256: input.sha256,
			references: input.references,
		});
	}
	return inputs;
}

function isWorkflowInputReference(value: unknown): value is WorkflowInputReference {
	return (
		isRecord(value) &&
		typeof value.nodeId === "string" &&
		typeof value.inputName === "string" &&
		typeof value.value === "string"
	);
}

function isWorkflowInputProblem(value: unknown): value is WorkflowInputProblem {
	return (
		isRecord(value) &&
		(value.reason === "missing" ||
			value.reason === "too-large" ||
			value.reason === "invalid-reference" ||
			value.reason === "snapshot-failed" ||
			value.reason === "transfer-failed" ||
			value.reason === "checksum-mismatch") &&
		typeof value.name === "string" &&
		(value.nodeId === undefined || typeof value.nodeId === "string") &&
		(value.inputName === undefined || typeof value.inputName === "string")
	);
}

function isWorkflowPreflightProblem(value: unknown): value is WorkflowPreflightProblem {
	return (
		isRecord(value) &&
		(value.kind === "core" ||
			value.kind === "model" ||
			value.kind === "custom_node" ||
			value.kind === "node") &&
		(value.reason === "not-ready" ||
			value.reason === "version-mismatch" ||
			value.reason === "missing" ||
			value.reason === "conflict" ||
			value.reason === "stale" ||
			value.reason === "unexpected" ||
			value.reason === "unsupported" ||
			value.reason === "syncing" ||
			value.reason === "unavailable" ||
			value.reason === "invalid") &&
		typeof value.name === "string" &&
		(typeof value.expected === "string" || value.expected === null) &&
		(typeof value.actual === "string" || value.actual === null) &&
		(value.nodeId === undefined || typeof value.nodeId === "string") &&
		(value.inputName === undefined || typeof value.inputName === "string")
	);
}

function isBasename(value: string): boolean {
	return value.length > 0 && !value.includes("/");
}
