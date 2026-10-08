import assert from "node:assert/strict";
import path from "node:path";
import { createReleaseFence } from "./lib/release-fence.mjs";
const [command, ...arguments_] = process.argv.slice(2);
const options = {};
for (let index = 0; index < arguments_.length; index += 2) {
  assert.match(arguments_[index], /^--[a-z-]+$/); assert.ok(arguments_[index + 1] && !arguments_[index + 1].startsWith("--"));
  const key = arguments_[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  assert.ok(!Object.hasOwn(options, key), "Duplicate option"); options[key] = arguments_[index + 1];
}
const allowed = new Set(["directory", "target", "candidateSha", "baselineSha", "action", "expectedAttemptId", "attemptId", "pid", "actualSha", "ttlSeconds"]);
assert.ok(Object.keys(options).every(key => allowed.has(key)), "Unknown option");
const directory = path.resolve(options.directory || "/var/lib/for-now-release"); delete options.directory;
options.pid = Number(options.pid || process.ppid); options.ttlSeconds = Number(options.ttlSeconds || 3600);
const fence = createReleaseFence({ directory });
try {
  let result;
  if (command === "read") result = await fence.read(options.target);
  else if (command === "observe") result = await fence.verify({ ...options, observe: true });
  else {
    assert.ok(["issue", "invalidate", "claim", "verify", "rollback", "complete", "abandon"].includes(command), "Unknown command");
    result = await fence[command](options);
  }
  if (command === "rollback") console.log(`${result.attemptId} ${result.candidateSha}`);
  else if (["issue", "invalidate", "read"].includes(command)) console.log(JSON.stringify(result));
} catch (error) { console.error(error.code || "RELEASE_FENCE_REJECTED", error.message); process.exitCode = 1; }
