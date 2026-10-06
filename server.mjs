import { createServerRuntime } from "./src/app/index.mjs";

const runtime = createServerRuntime({ rootUrl: import.meta.url });
await runtime.start();
