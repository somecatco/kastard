import externalLinksSource from "../../../../../../LINKS.jsonc?raw";
import { parseExternalLinks } from "../../../shared/external-links";

export const externalLinks = parseExternalLinks(externalLinksSource);
