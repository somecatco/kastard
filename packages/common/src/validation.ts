export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isNonNegativeNumberOrNull(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isFinite(value) && value >= 0)
	);
}

export function isPercentageOrNull(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
	);
}

export function isBoundedString(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		value.trim() === value
	);
}

export function isCanonicalUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			value,
		)
	);
}

export function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
