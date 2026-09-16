import { stripVTControlCharacters } from "node:util";
import type { ComfyStartupFailure } from "../../shared/api";

const MAX_LOG_BYTES = 1024 * 1024;

export class ComfyStartupError extends Error {
	constructor(
		readonly failure: ComfyStartupFailure,
		cause: unknown,
	) {
		super(failure.message, { cause });
	}
}

export class StartupLog {
	private output = Buffer.alloc(0);
	private truncated = false;
	private active = true;

	append(text: string): void {
		if (!this.active) return;
		let output = Buffer.concat([this.output, Buffer.from(text)]);
		if (output.length > MAX_LOG_BYTES) {
			let start = output.length - MAX_LOG_BYTES;
			while (start < output.length && ((output[start] ?? 0) & 0xc0) === 0x80)
				start += 1;
			output = Buffer.from(output.subarray(start));
			this.truncated = true;
		}
		this.output = output;
	}

	failure(message: string, incomplete = false): ComfyStartupFailure {
		return {
			message: stripVTControlCharacters(message),
			logs: stripVTControlCharacters(this.output.toString("utf8")),
			truncated: this.truncated || incomplete,
		};
	}

	clear(): void {
		this.active = false;
		this.output = Buffer.alloc(0);
	}
}
