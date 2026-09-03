import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkRuntimeLayers,
	parseCompiledRequirements,
	renderRuntimeLayers,
	runtimeImageFingerprint,
	writeRuntimeLayers,
} from "./worker-runtime-layers.mjs";

const roots = [];

function requirement(name, version = "1.0.0", via = "fixture") {
	const hash = name.replaceAll("-", "").padEnd(64, "0").slice(0, 64);
	return [
		`${name}==${version} \\`,
		`    --hash=sha256:${hash}`,
		`    # via ${via}`,
		"",
	].join("\n");
}

function compiledLock(applicationVersion = "1.0.0", cudaVia = "fixture") {
	return `# Generated fixture.\n${requirement(
		"nvidia-cublas-cu12",
		"1.0.0",
		cudaVia,
	)}${requirement(
		"nvidia-cudnn-cu12",
	)}${requirement("nvidia-nccl-cu12")}${requirement("torch")}${requirement(
		"triton",
	)}${requirement("Comfy_Name", applicationVersion)}`;
}

function prebundleLock() {
	return `# Generated fixture.\n${requirement("onnxruntime")}${requirement(
		"onnxruntime-gpu",
	)}${requirement("opencv-python")}`;
}

function createRoot() {
	const root = mkdtempSync(join(tmpdir(), "kastard-runtime-layers-"));
	roots.push(root);
	mkdirSync(join(root, "vendor"));
	writeFileSync(
		join(root, "vendor/comfyui-worker-prebundle-lock.txt"),
		prebundleLock(),
	);
	for (const profile of ["cu128", "cu130"]) {
		writeFileSync(
			join(root, "vendor", `comfyui-worker-${profile}-lock.txt`),
			compiledLock(),
		);
	}
	return root;
}

function writeRuntimeImageInputs(root) {
	mkdirSync(join(root, "apps/server"), { recursive: true });
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "apps/server/Dockerfile.runtime"), "FROM fixture\n");
	writeFileSync(join(root, "scripts/verify-worker-runtime.py"), "# fixture\n");
	for (const profile of ["cu128", "cu130"]) {
		writeFileSync(
			join(root, "vendor", `comfyui-worker-runtime-${profile}.json`),
			`${JSON.stringify({ profile })}\n`,
		);
		writeFileSync(
			join(root, "vendor", `comfyui-worker-constraints-${profile}.txt`),
			`${profile}\n`,
		);
	}
	writeRuntimeLayers(root);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Worker runtime layers", () => {
	test("preserves hashed requirements without dependency comments", () => {
		const requirements = parseCompiledRequirements(compiledLock(), "fixture.txt");

		expect(requirements.map(({ name }) => name)).toEqual([
			"nvidia-cublas-cu12",
			"nvidia-cudnn-cu12",
			"nvidia-nccl-cu12",
			"torch",
			"triton",
			"comfy-name",
		]);
		expect(requirements[0].block).toContain("--hash=sha256:");
		expect(requirements[0].block).not.toContain("# via fixture");
	});

	test("partitions every requirement into one stable layer", () => {
		const layers = renderRuntimeLayers(compiledLock(), "cu128", "fixture.txt");

		expect(layers["cuda-core"]).toContain("nvidia-cublas-cu12");
		expect(layers["cuda-core"]).toContain("nvidia-cudnn-cu12");
		expect(layers["cuda-auxiliary"]).toContain("nvidia-nccl-cu12");
		expect(layers.framework).toContain("torch==");
		expect(layers.framework).toContain("triton==");
		expect(layers.application).toContain("Comfy_Name==");

		const partitioned = Object.values(layers).flatMap((content) =>
			parseCompiledRequirements(content).map(({ name }) => name),
		);
		expect(partitioned.sort()).toEqual(
			parseCompiledRequirements(compiledLock())
				.map(({ name }) => name)
				.sort(),
		);
	});

	test("keeps expensive layers stable when only an application package changes", () => {
		const before = renderRuntimeLayers(compiledLock("1.0.0"), "cu128");
		const after = renderRuntimeLayers(
			compiledLock("2.0.0", "fixture and application-package"),
			"cu128",
		);

		expect(after["cuda-core"]).toBe(before["cuda-core"]);
		expect(after["cuda-auxiliary"]).toBe(before["cuda-auxiliary"]);
		expect(after.framework).toBe(before.framework);
		expect(after.application).not.toBe(before.application);
	});

	test("rejects duplicate normalized package names", () => {
		expect(() =>
			parseCompiledRequirements(
				`# Fixture.\n${requirement("same-name")}${requirement("same_name")}`,
			),
		).toThrow("duplicate requirement same-name");
	});

	test("writes and validates both runtime profiles", () => {
		const root = createRoot();

		expect(writeRuntimeLayers(root)).toHaveLength(8);
		expect(checkRuntimeLayers(root)).toHaveLength(8);

		const path = join(root, "vendor", "comfyui-worker-cu128-layer-framework.txt");
		writeFileSync(path, `${readFileSync(path, "utf8")}stale\n`);
		expect(() => checkRuntimeLayers(root)).toThrow(
			"vendor/comfyui-worker-cu128-layer-framework.txt",
		);

		const obsolete = join(root, "vendor", "comfyui-worker-cu128-layer-obsolete.txt");
		writeFileSync(obsolete, "obsolete\n");
		writeRuntimeLayers(root);
		expect(existsSync(obsolete)).toBe(false);
		expect(checkRuntimeLayers(root)).toHaveLength(8);
	});

	test("fingerprints only the selected runtime image inputs", () => {
		const root = createRoot();
		writeRuntimeImageInputs(root);
		const cu128 = runtimeImageFingerprint(root, "cu128");
		const cu130 = runtimeImageFingerprint(root, "cu130");
		expect(cu128).toMatch(/^[0-9a-f]{64}$/);
		expect(cu130).toMatch(/^[0-9a-f]{64}$/);

		writeFileSync(join(root, "unrelated.txt"), "changed\n");
		expect(runtimeImageFingerprint(root, "cu128")).toBe(cu128);
		expect(runtimeImageFingerprint(root, "cu130")).toBe(cu130);

		const prebundleLockPath = join(root, "vendor/comfyui-worker-prebundle-lock.txt");
		const originalPrebundleLock = readFileSync(prebundleLockPath, "utf8");
		writeFileSync(prebundleLockPath, `${originalPrebundleLock}# changed\n`);
		expect(runtimeImageFingerprint(root, "cu128")).not.toBe(cu128);
		expect(runtimeImageFingerprint(root, "cu130")).not.toBe(cu130);
		writeFileSync(prebundleLockPath, originalPrebundleLock);

		writeFileSync(
			join(root, "vendor/comfyui-worker-runtime-cu128.json"),
			'{"profile":"cu128","changed":true}\n',
		);
		expect(runtimeImageFingerprint(root, "cu128")).not.toBe(cu128);
		expect(runtimeImageFingerprint(root, "cu130")).toBe(cu130);
	});
});
