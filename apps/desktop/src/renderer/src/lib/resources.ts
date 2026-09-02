import { createWorkerTemplateLinks, parseResources } from "@kastard/common";
import resourcesSource from "../../../../../../resources.jsonc?raw";

export const resources = parseResources(resourcesSource);

export const workerTemplateLinks = {
	runpod: {
		production: createWorkerTemplateLinks(resources, "runpod", "production"),
		preview: createWorkerTemplateLinks(resources, "runpod", "preview"),
	},
	vastAi: {
		production: createWorkerTemplateLinks(resources, "vastAi", "production"),
		preview: createWorkerTemplateLinks(resources, "vastAi", "preview"),
	},
};
