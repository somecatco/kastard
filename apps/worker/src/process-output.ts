const MAX_PROCESS_OUTPUT_LINE_LENGTH = 4_000;
const ESCAPE_CODE_POINT = 27;
const BELL_CODE_POINT = 7;
const STRING_TERMINATOR_CODE_POINT = 0x9c;

type AnsiState =
	| "text"
	| "escape"
	| "escape-intermediates"
	| "csi-parameters"
	| "csi-intermediates"
	| "osc-string"
	| "osc-string-escape"
	| "control-string"
	| "control-string-escape";

export type ProcessOutputStream = "stdout" | "stderr";

export class ProcessOutputLineBuffer {
	private pending = "";
	private ansiState: AnsiState = "text";

	constructor(private readonly onLine: (line: string) => void) {}

	write(value: string): void {
		this.pending = emitLines(this.pending + this.sanitize(value), this.onLine, false);
	}

	flush(): void {
		this.ansiState = "text";
		this.pending = emitLines(this.pending, this.onLine, true);
	}

	private sanitize(value: string): string {
		let output = "";
		for (const character of value) {
			const codePoint = character.codePointAt(0) ?? 0;
			if (this.ansiState !== "text" && this.consumeAnsi(character, codePoint)) continue;
			if (codePoint === ESCAPE_CODE_POINT) {
				this.ansiState = "escape";
				continue;
			}
			if (codePoint === 0x9b) {
				this.ansiState = "csi-parameters";
				continue;
			}
			if (codePoint === 0x9d) {
				this.ansiState = "osc-string";
				continue;
			}
			if (
				codePoint === 0x90 ||
				codePoint === 0x98 ||
				codePoint === 0x9e ||
				codePoint === 0x9f
			) {
				this.ansiState = "control-string";
				continue;
			}
			if (
				codePoint === 9 ||
				codePoint === 10 ||
				codePoint === 13 ||
				(codePoint >= 32 && (codePoint < 127 || codePoint > 159))
			) {
				output += character;
			}
		}
		return output;
	}

	private consumeAnsi(character: string, codePoint: number): boolean {
		if (this.ansiState === "escape") {
			if (character === "[") this.ansiState = "csi-parameters";
			else if (character === "]") this.ansiState = "osc-string";
			else if ("PX^_".includes(character)) this.ansiState = "control-string";
			else if (codePoint >= 0x20 && codePoint <= 0x2f)
				this.ansiState = "escape-intermediates";
			else if (codePoint === ESCAPE_CODE_POINT) this.ansiState = "escape";
			else if (codePoint >= 0x30 && codePoint <= 0x7e) this.ansiState = "text";
			else {
				this.ansiState = "text";
				return false;
			}
			return true;
		}
		if (this.ansiState === "escape-intermediates") {
			if (codePoint >= 0x20 && codePoint <= 0x2f) return true;
			if (codePoint === ESCAPE_CODE_POINT) this.ansiState = "escape";
			else if (codePoint >= 0x30 && codePoint <= 0x7e) this.ansiState = "text";
			else {
				this.ansiState = "text";
				return false;
			}
			return true;
		}
		if (this.ansiState === "csi-parameters") {
			if (codePoint >= 0x30 && codePoint <= 0x3f) return true;
			if (codePoint >= 0x20 && codePoint <= 0x2f) this.ansiState = "csi-intermediates";
			else if (codePoint === ESCAPE_CODE_POINT) this.ansiState = "escape";
			else if (codePoint >= 0x40 && codePoint <= 0x7e) this.ansiState = "text";
			else {
				this.ansiState = "text";
				return false;
			}
			return true;
		}
		if (this.ansiState === "csi-intermediates") {
			if (codePoint >= 0x20 && codePoint <= 0x2f) return true;
			if (codePoint === ESCAPE_CODE_POINT) this.ansiState = "escape";
			else if (codePoint >= 0x40 && codePoint <= 0x7e) this.ansiState = "text";
			else {
				this.ansiState = "text";
				return false;
			}
			return true;
		}
		if (this.ansiState === "osc-string") {
			if (codePoint === BELL_CODE_POINT || codePoint === STRING_TERMINATOR_CODE_POINT)
				this.ansiState = "text";
			else if (codePoint === ESCAPE_CODE_POINT) this.ansiState = "osc-string-escape";
			return true;
		}
		if (this.ansiState === "control-string") {
			if (codePoint === STRING_TERMINATOR_CODE_POINT) this.ansiState = "text";
			else if (codePoint === ESCAPE_CODE_POINT)
				this.ansiState = "control-string-escape";
			return true;
		}
		if (this.ansiState === "osc-string-escape") {
			if (
				character === "\\" ||
				codePoint === BELL_CODE_POINT ||
				codePoint === STRING_TERMINATOR_CODE_POINT
			)
				this.ansiState = "text";
			else if (codePoint === ESCAPE_CODE_POINT) this.ansiState = "osc-string-escape";
			else this.ansiState = "osc-string";
			return true;
		}
		if (character === "\\" || codePoint === STRING_TERMINATOR_CODE_POINT)
			this.ansiState = "text";
		else if (codePoint === ESCAPE_CODE_POINT) this.ansiState = "control-string-escape";
		else this.ansiState = "control-string";
		return true;
	}
}

function emitLines(
	value: string,
	onLine: (line: string) => void,
	flush: boolean,
): string {
	const lines = value.split(/\r\n|[\r\n]/u);
	const pending = flush ? "" : (lines.pop() ?? "");
	for (const line of lines) emitLine(line, onLine);
	if (pending.length < MAX_PROCESS_OUTPUT_LINE_LENGTH) return pending;

	const retainedLength = pending.length % MAX_PROCESS_OUTPUT_LINE_LENGTH;
	let boundary = pending.length - retainedLength;
	if (
		isHighSurrogate(pending.charCodeAt(boundary - 1)) &&
		(boundary === pending.length || isLowSurrogate(pending.charCodeAt(boundary)))
	) {
		boundary -= 1;
	}
	emitChunks(pending.slice(0, boundary), onLine);
	return pending.slice(boundary);
}

function emitLine(value: string, onLine: (line: string) => void): void {
	emitChunks(value.trimEnd(), onLine);
}

function emitChunks(value: string, onLine: (line: string) => void): void {
	for (let start = 0; start < value.length; ) {
		let end = Math.min(start + MAX_PROCESS_OUTPUT_LINE_LENGTH, value.length);
		if (
			end < value.length &&
			isHighSurrogate(value.charCodeAt(end - 1)) &&
			isLowSurrogate(value.charCodeAt(end))
		) {
			end -= 1;
		}
		onLine(value.slice(start, end));
		start = end;
	}
}

function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
