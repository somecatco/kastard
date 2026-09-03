const MODEL_EXTENSIONS = [
	".bin",
	".ckpt",
	".gguf",
	".onnx",
	".pt",
	".pth",
	".safetensors",
	".sft",
] as const;

export function hasSupportedModelExtension(value: string): boolean {
	const filename = value.toLowerCase();
	return MODEL_EXTENSIONS.some((extension) => filename.endsWith(extension));
}
