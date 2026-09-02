import { isRecord } from "./validation";

type TransformResult = { value: unknown; replacements: number };
type JsonPatch = { start: number; end: number; value: string };
type JsonTransformResult = TransformResult & { value: string; patches: JsonPatch[] };

export function collectWorkflowInputStringLeaves(value: unknown): string[] {
	const leaves: string[] = [];
	transformWorkflowInputStringLeaves(value, (leaf) => {
		leaves.push(leaf);
		return undefined;
	});
	return leaves;
}

export function rewriteWorkflowInputStringLeaves(
	value: unknown,
	from: string,
	to: string,
): TransformResult {
	return transformWorkflowInputStringLeaves(value, (leaf) =>
		leaf === from ? to : undefined,
	);
}

function transformWorkflowInputStringLeaves(
	value: unknown,
	transform: (value: string) => string | undefined,
): TransformResult {
	if (typeof value === "string") {
		const replacement = transform(value);
		if (replacement !== undefined) {
			return { value: replacement, replacements: 1 };
		}
		if (!isJsonContainer(value)) return { value, replacements: 0 };
		const transformed = transformJsonStringLeaves(value, transform);
		return { value: transformed.value, replacements: transformed.replacements };
	}
	if (Array.isArray(value)) {
		let replacements = 0;
		const next = value.map((item) => {
			const result = transformWorkflowInputStringLeaves(item, transform);
			replacements += result.replacements;
			return result.value;
		});
		return { value: replacements === 0 ? value : next, replacements };
	}
	if (isRecord(value)) {
		let replacements = 0;
		const next: Record<string, unknown> = Object.create(null);
		for (const [key, item] of Object.entries(value)) {
			const result = transformWorkflowInputStringLeaves(item, transform);
			replacements += result.replacements;
			next[key] = result.value;
		}
		return { value: replacements === 0 ? value : next, replacements };
	}
	return { value, replacements: 0 };
}

// Replacing only matching string spans preserves every unrelated JSON byte.
function transformJsonStringLeaves(
	raw: string,
	transform: (value: string) => string | undefined,
): JsonTransformResult {
	const patches: JsonPatch[] = [];
	let replacements = 0;
	for (const token of stringTokens(raw).reverse()) {
		if (token.key) continue;
		const decoded = parseJsonString(raw.slice(token.start, token.end));
		if (decoded === null) continue;
		const replacement = transform(decoded);
		if (replacement !== undefined) {
			patches.push({
				start: token.start,
				end: token.end,
				value: JSON.stringify(replacement),
			});
			replacements += 1;
			continue;
		}
		if (!isJsonContainer(decoded)) continue;
		const nested = transformJsonStringLeaves(decoded, transform);
		if (nested.replacements > 0) {
			const offsets = jsonStringOffsets(raw.slice(token.start, token.end));
			for (const patch of nested.patches) {
				const start = offsets[patch.start];
				const end = offsets[patch.end];
				if (start === undefined || end === undefined) {
					throw new Error("Invalid nested JSON string offset.");
				}
				patches.push({
					start: token.start + start,
					end: token.start + end,
					value: JSON.stringify(patch.value).slice(1, -1),
				});
			}
			replacements += nested.replacements;
		}
	}
	let value = raw;
	for (const patch of patches.sort((left, right) => right.start - left.start)) {
		value = `${value.slice(0, patch.start)}${patch.value}${value.slice(patch.end)}`;
	}
	return { value, replacements, patches };
}

function jsonStringOffsets(raw: string): number[] {
	const offsets = [1];
	let index = 1;
	while (index < raw.length - 1) {
		index += raw.charAt(index) === "\\" ? (raw.charAt(index + 1) === "u" ? 6 : 2) : 1;
		offsets.push(index);
	}
	return offsets;
}

function stringTokens(raw: string): { start: number; end: number; key: boolean }[] {
	const tokens: { start: number; end: number; key: boolean }[] = [];
	let index = 0;
	while (index < raw.length) {
		if (raw.charAt(index) !== '"') {
			index += 1;
			continue;
		}
		const start = index;
		index += 1;
		while (index < raw.length && raw.charAt(index) !== '"') {
			if (raw.charAt(index) === "\\") index += 1;
			index += 1;
		}
		index += 1;
		let cursor = index;
		while (cursor < raw.length && " \t\n\r".includes(raw.charAt(cursor))) {
			cursor += 1;
		}
		tokens.push({ start, end: index, key: raw.charAt(cursor) === ":" });
	}
	return tokens;
}

function parseJsonString(raw: string): string | null {
	try {
		const value: unknown = JSON.parse(raw);
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function isJsonContainer(value: string): boolean {
	const trimmed = value.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) || Array.isArray(parsed);
	} catch {
		return false;
	}
}
