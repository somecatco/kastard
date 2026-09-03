import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";

const AUTH_PROTOCOL = "KASTARD-AUTH-V1";
const SERVER_PROOF_CONTEXT = "kastard-worker-server-v1";
const CLIENT_PROOF_CONTEXT = "kastard-editor-client-v1";
const SESSION_CAPABILITY_CONTEXT = "kastard-worker-session-capability-v1";
const CODE_PATTERN = /^(?:[A-Z0-9]{4}-){3}[A-Z0-9]{4}$/;

export type WorkerAuthenticationChallenge = {
	nonce: Buffer;
	serverProof: Buffer;
};

export function deriveWorkerAuthenticationKey(code: string, hostKey: Buffer): Buffer {
	if (!CODE_PATTERN.test(code)) throw new Error("Invalid Worker authentication code.");
	return scryptSync(code, hostKeyHash(hostKey), 32, {
		N: 16_384,
		r: 8,
		p: 1,
		maxmem: 64 * 1024 * 1024,
	});
}

export function normalizeWorkerAuthenticationCode(value: string): string | null {
	const compact = value.trim().toUpperCase().replaceAll("-", "");
	if (!/^[A-Z0-9]{16}$/.test(compact)) return null;
	return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12)}`;
}

export function createWorkerAuthenticationChallenge(
	authenticationKey: Buffer,
	hostKey: Buffer,
	nonce: Buffer,
): WorkerAuthenticationChallenge {
	return {
		nonce,
		serverProof: proof(SERVER_PROOF_CONTEXT, authenticationKey, hostKey, nonce),
	};
}

export function serializeWorkerAuthenticationChallenge(
	challenge: WorkerAuthenticationChallenge,
): string {
	return `${AUTH_PROTOCOL} ${challenge.nonce.toString("base64url")} ${challenge.serverProof.toString("base64url")}`;
}

export function parseWorkerAuthenticationChallenge(
	value: string,
): WorkerAuthenticationChallenge | null {
	const [protocol, nonceValue, proofValue, ...rest] = value.trim().split(/\s+/);
	if (
		protocol !== AUTH_PROTOCOL ||
		nonceValue === undefined ||
		proofValue === undefined ||
		rest.length !== 0
	) {
		return null;
	}
	try {
		const nonce = Buffer.from(nonceValue, "base64url");
		const serverProof = Buffer.from(proofValue, "base64url");
		return nonce.length === 32 && serverProof.length === 32
			? { nonce, serverProof }
			: null;
	} catch {
		return null;
	}
}

export function verifyWorkerServerProof(
	challenge: WorkerAuthenticationChallenge,
	authenticationKey: Buffer,
	hostKey: Buffer,
): boolean {
	return safeEqual(
		challenge.serverProof,
		proof(SERVER_PROOF_CONTEXT, authenticationKey, hostKey, challenge.nonce),
	);
}

export function createWorkerClientProof(
	authenticationKey: Buffer,
	hostKey: Buffer,
	nonce: Buffer,
): string {
	return proof(CLIENT_PROOF_CONTEXT, authenticationKey, hostKey, nonce).toString(
		"base64url",
	);
}

export function verifyWorkerClientProof(
	value: string,
	authenticationKey: Buffer,
	hostKey: Buffer,
	nonce: Buffer,
): boolean {
	let received: Buffer;
	try {
		received = Buffer.from(value, "base64url");
	} catch {
		return false;
	}
	return safeEqual(
		received,
		proof(CLIENT_PROOF_CONTEXT, authenticationKey, hostKey, nonce),
	);
}

export function createWorkerSessionCapability(
	authenticationKey: Buffer,
	hostKey: Buffer,
	nonce: Buffer,
): string {
	return proof(SESSION_CAPABILITY_CONTEXT, authenticationKey, hostKey, nonce).toString(
		"base64url",
	);
}

export function verifyWorkerSessionCapability(
	value: string,
	expected: string,
): boolean {
	let received: Buffer;
	let expectedBytes: Buffer;
	try {
		received = Buffer.from(value, "base64url");
		expectedBytes = Buffer.from(expected, "base64url");
	} catch {
		return false;
	}
	if (
		received.toString("base64url") !== value ||
		expectedBytes.toString("base64url") !== expected
	) {
		return false;
	}
	return safeEqual(received, expectedBytes);
}

function proof(
	context: string,
	authenticationKey: Buffer,
	hostKey: Buffer,
	nonce: Buffer,
): Buffer {
	if (authenticationKey.length !== 32) {
		throw new Error("Invalid Worker authentication key.");
	}
	const keyHash = hostKeyHash(hostKey);
	return createHmac("sha256", authenticationKey)
		.update(context)
		.update(keyHash)
		.update(nonce)
		.digest();
}

function hostKeyHash(hostKey: Buffer): Buffer {
	return createHash("sha256").update(hostKey).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
	return left.length === right.length && timingSafeEqual(left, right);
}
