const CHILD_ENVIRONMENT_KEYS = [
	"PATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"TMP",
	"TEMP",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"UV_CONSTRAINT",
	"UV_CACHE_DIR",
	"UV_LINK_MODE",
	"CC",
	"CXX",
	"CFLAGS",
	"CXXFLAGS",
	"LDFLAGS",
	"CMAKE_PREFIX_PATH",
	"CPATH",
	"LIBRARY_PATH",
	"LD_LIBRARY_PATH",
	"CUDA_HOME",
	"CUDA_PATH",
	"CUDA_VISIBLE_DEVICES",
	"NVIDIA_VISIBLE_DEVICES",
	"NVIDIA_DRIVER_CAPABILITIES",
	"TORCH_CUDA_ARCH_LIST",
	"MAX_JOBS",
] as const;

export function workerChildEnvironment(
	source: NodeJS.ProcessEnv,
	overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of CHILD_ENVIRONMENT_KEYS) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return { ...environment, ...overrides };
}
