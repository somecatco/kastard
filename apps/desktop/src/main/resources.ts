import { parseResources } from "@kastard/common";
import resourcesSource from "../../../../resources.jsonc?raw";

export const resources = parseResources(resourcesSource);
