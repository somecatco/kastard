import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	createWorkerAuthenticationChallenge,
	createWorkerClientProof,
	createWorkerSessionCapability,
	deriveWorkerAuthenticationKey,
	normalizeWorkerAuthenticationCode,
	parseWorkerAuthenticationChallenge,
	serializeWorkerAuthenticationChallenge,
	verifyWorkerClientProof,
	verifyWorkerServerProof,
	verifyWorkerSessionCapability,
} from "./session-auth";

describe("Worker session authentication", () => {
	test("normalizes the sixteen-character code", () => {
		expect(normalizeWorkerAuthenticationCode("7m4kq2pxabcd6789")).toBe(
			"7M4K-Q2PX-ABCD-6789",
		);
		expect(normalizeWorkerAuthenticationCode("7M4K-Q2PX-ABCD-6789")).toBe(
			"7M4K-Q2PX-ABCD-6789",
		);
		expect(normalizeWorkerAuthenticationCode("short")).toBeNull();
	});

	test("binds both proofs to the code and observed host key", () => {
		const code = "7M4K-Q2PX-ABCD-6789";
		const hostKey = randomBytes(104);
		const nonce = randomBytes(32);
		const authenticationKey = deriveWorkerAuthenticationKey(code, hostKey);
		const challenge = createWorkerAuthenticationChallenge(
			authenticationKey,
			hostKey,
			nonce,
		);
		const parsed = parseWorkerAuthenticationChallenge(
			serializeWorkerAuthenticationChallenge(challenge),
		);
		expect(parsed).not.toBeNull();
		if (parsed === null) return;

		expect(verifyWorkerServerProof(parsed, authenticationKey, hostKey)).toBe(true);
		expect(
			verifyWorkerServerProof(
				parsed,
				deriveWorkerAuthenticationKey("AAAA-BBBB-CCCC-DDDD", hostKey),
				hostKey,
			),
		).toBe(false);
		expect(verifyWorkerServerProof(parsed, authenticationKey, randomBytes(104))).toBe(
			false,
		);

		const clientProof = createWorkerClientProof(authenticationKey, hostKey, nonce);
		expect(
			verifyWorkerClientProof(clientProof, authenticationKey, hostKey, nonce),
		).toBe(true);
		expect(
			verifyWorkerClientProof(clientProof, authenticationKey, hostKey, randomBytes(32)),
		).toBe(false);

		const capability = createWorkerSessionCapability(authenticationKey, hostKey, nonce);
		expect(verifyWorkerSessionCapability(capability, capability)).toBe(true);
		expect(
			verifyWorkerSessionCapability(
				createWorkerSessionCapability(authenticationKey, hostKey, randomBytes(32)),
				capability,
			),
		).toBe(false);
		expect(verifyWorkerSessionCapability(`${capability}!`, capability)).toBe(false);
	});
});
