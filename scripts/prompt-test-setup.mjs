import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPromptCatalog } from "../src/infrastructure/prompt-catalog/index.mjs";
import { installPromptCatalog } from "../src/shared/prompts/index.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
installPromptCatalog(await loadPromptCatalog({ rootDir: root }));
