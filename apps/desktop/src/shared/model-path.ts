export const MODEL_PATH_CATEGORIES = [
	"audio_encoders",
	"background_removal",
	"checkpoints",
	"classifiers",
	"clip_vision",
	"controlnet",
	"detection",
	"diffusers",
	"diffusion_models",
	"embeddings",
	"frame_interpolation",
	"geometry_estimation",
	"gligen",
	"hypernetworks",
	"latent_upscale_models",
	"LLM",
	"loras",
	"model_patches",
	"optical_flow",
	"photomaker",
	"style_models",
	"text_encoders",
	"unet",
	"upscale_models",
	"vae",
	"vae_approx",
] as const;

export type ModelPathCategory = (typeof MODEL_PATH_CATEGORIES)[number];

export const DEFAULT_MODEL_PATH_CATEGORY: ModelPathCategory = "checkpoints";

const MODEL_PATH_CATEGORY_VALUES = new Set<string>(MODEL_PATH_CATEGORIES);

export function isModelPathCategory(value: string): value is ModelPathCategory {
	return MODEL_PATH_CATEGORY_VALUES.has(value);
}
