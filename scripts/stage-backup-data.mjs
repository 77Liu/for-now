import path from "node:path";
import { loadAttachmentConfig } from "../src/config/index.mjs";
import {
  createAttachmentStorage,
  stageAttachmentCompleteBackup
} from "../src/shared/attachments/index.mjs";

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  if (["--allow-remote-attachments", "--materialized"].includes(key)) options[key] = true;
  else if (["--source-dir", "--output-dir", "--source-storage"].includes(key)
    && args[index + 1] && !args[index + 1].startsWith("--")) {
    options[key] = args[++index];
  } else {
    throw new Error("Usage: stage-backup-data --source-dir PATH --output-dir NEW_PATH [--allow-remote-attachments | --materialized] [--source-storage NAME]");
  }
}
if (!options["--source-dir"] || !options["--output-dir"]) {
  throw new Error("Explicit --source-dir and --output-dir are required");
}

const configured = loadAttachmentConfig();
if (configured.mode === "oss" && !options["--allow-remote-attachments"] && !options["--materialized"]) {
  throw new Error("OSS reads require explicit --allow-remote-attachments");
}
const storage = createAttachmentStorage(options["--materialized"] ? { mode: "local" } : configured);
const manifest = await stageAttachmentCompleteBackup({
  sourceDir: path.resolve(options["--source-dir"]),
  outputDir: path.resolve(options["--output-dir"]),
  storage,
  sourceAttachmentStorage: options["--source-storage"] || (options["--materialized"] ? "materialized" : configured.mode)
});
console.log(JSON.stringify({ status: "staged", ...manifest.summary }));
