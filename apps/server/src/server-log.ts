import { randomUUID } from "node:crypto";
import type {
	ServerLogEntry,
	ServerLogLevel,
	ServerLogSnapshot,
} from "@kastard/common";

export type {
	ServerLogEntry,
	ServerLogLevel,
	ServerLogSnapshot,
} from "@kastard/common";

type ServerLogStoreOptions = {
	maxEntries?: number;
	now?: () => Date;
	instanceId?: string;
};

export const DEFAULT_SERVER_LOG_LIMIT = 1_000;

export class ServerLogStore {
	private readonly entries: Array<ServerLogEntry & { sequence: number }> = [];
	private readonly maxEntries: number;
	private readonly now: () => Date;
	private readonly instanceId: string;
	private sequence = 0;

	constructor(options?: ServerLogStoreOptions) {
		this.maxEntries = options?.maxEntries ?? DEFAULT_SERVER_LOG_LIMIT;
		if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
			throw new Error("Server log limit must be a positive integer.");
		}
		this.now = options?.now ?? (() => new Date());
		this.instanceId = options?.instanceId ?? randomUUID();
	}

	getCursor(): string {
		return this.cursorFor(this.sequence);
	}

	write(level: ServerLogLevel, message: string): void {
		this.sequence += 1;
		this.entries.push({
			id: this.cursorFor(this.sequence),
			sequence: this.sequence,
			timestamp: this.now().toISOString(),
			level,
			message,
		});
		if (this.entries.length > this.maxEntries) this.entries.shift();
	}

	readAfter(cursor: string): ServerLogSnapshot {
		const requested = parseCursor(cursor);
		const sameInstance = requested.instanceId === this.instanceId;
		if (sameInstance && requested.sequence > this.sequence) {
			throw new Error("Invalid server log cursor.");
		}

		const oldestSequence = this.entries[0]?.sequence ?? this.sequence + 1;
		const requestedSequence = sameInstance ? requested.sequence : 0;
		const truncated = requestedSequence < oldestSequence - 1;
		const minimumSequence = truncated ? oldestSequence - 1 : requestedSequence;

		return {
			logs: this.entries
				.filter((entry) => entry.sequence > minimumSequence)
				.map(({ sequence: _sequence, ...entry }) => entry),
			cursor: this.getCursor(),
			truncated,
		};
	}

	private cursorFor(sequence: number): string {
		return `${this.instanceId}:${sequence}`;
	}
}

function parseCursor(cursor: string): { instanceId: string; sequence: number } {
	const separator = cursor.lastIndexOf(":");
	const instanceId = cursor.slice(0, separator);
	const sequence = Number(cursor.slice(separator + 1));
	if (
		separator < 1 ||
		instanceId.length > 128 ||
		!Number.isSafeInteger(sequence) ||
		sequence < 0
	) {
		throw new Error("Invalid server log cursor.");
	}
	return { instanceId, sequence };
}
