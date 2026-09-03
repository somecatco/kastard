import type { NotarizeOptions } from "@electron/notarize";

interface RetryOptions {
	environment?: Record<string, string | undefined>;
	notarizeArtifact?: (options: NotarizeOptions) => Promise<void>;
	wait?: (milliseconds: number) => Promise<void>;
	warn?: (message: string) => void;
}

export declare function notarizeWithRetry(
	artifactPath: string,
	options?: RetryOptions,
): Promise<void>;
