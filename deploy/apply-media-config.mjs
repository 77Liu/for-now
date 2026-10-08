#!/usr/bin/env node
// Run on the trusted server. No secret in arguments, stdout, or local profile.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";

const expected = {
  schemaVersion: 1,
  MEDIA_DELIVERY_MODE: "cdn-signed",
  MEDIA_DELIVERY_BUCKET: "for-now-distribution",
  MEDIA_DELIVERY_OSS_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com",
  MEDIA_CDN_ORIGIN: "https://media.77liu.top"
};
const fenceLibrary = "/usr/local/lib/for-now-release/lib/release-fence.mjs";
const fenceDirectory = "/var/lib/for-now-release";
const persistentProfile = "/etc/for-now-media-delivery.json";
const managed = [...Object.keys(expected).filter(key => key !== "schemaVersion"), "MEDIA_CDN_AUTH_KEY"];

function readTrusted(file, privateFile = false) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & (privateFile ? 0o077 : 0o022))) {
      throw new Error("Unsafe file ownership or permissions");
    }
    return fs.readFileSync(handle, "utf8");
  } finally { fs.closeSync(handle); }
}

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) result[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return result;
}

try {
  const args = process.argv.slice(2);
  const [profilePath, envPath, keyPath, releasePath, flag, target, attemptId, candidateSha, actualSha, parentPid] = args;
  const checking = flag === "--check" && args.length === 5;
  const applying = flag === "--apply-fenced" && args.length === 10 && target === "production" &&
    /^[a-f0-9]{32}$/.test(attemptId) && /^[a-f0-9]{40}$/.test(candidateSha) &&
    /^[a-f0-9]{40}$/.test(actualSha) && /^[1-9][0-9]*$/.test(parentPid) && Number.isSafeInteger(Number(parentPid));
  if (!releasePath || (!checking && !applying)) throw new Error("Invalid arguments");
  const profileText = readTrusted(profilePath);
  const profile = JSON.parse(profileText);
  if (Object.keys(profile).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => profile[key] !== value)) throw new Error("Unapproved media profile");
  const original = readTrusted(envPath, true);
  const key = readTrusted(keyPath, true).trim();
  if (!/^[A-Za-z0-9]{6,128}$/.test(key)) throw new Error("Invalid protected signing key");
  const env = { ...parseEnv(original), ...profile, MEDIA_CDN_AUTH_KEY: key };
  // Validate the actual candidate's environment mapping AND delivery validator.
  const configModule = await import(pathToFileURL(path.join(releasePath, "src/config/index.mjs")));
  const deliveryModule = await import(pathToFileURL(path.join(releasePath, "src/shared/attachments/delivery.mjs")));
  const config = configModule.loadAttachmentConfig(env);
  if (config.mode !== "oss" || config.bucket !== "for-now" || !config.roleName ||
      config.region !== "cn-beijing" || config.delivery?.mode !== "cdn-signed" ||
      config.delivery.bucket !== profile.MEDIA_DELIVERY_BUCKET ||
      config.delivery.endpoint !== profile.MEDIA_DELIVERY_OSS_ENDPOINT ||
      config.delivery.cdnOrigin !== profile.MEDIA_CDN_ORIGIN || config.delivery.cdnKey !== key) {
    throw new Error("Candidate or source storage is incompatible with the media profile");
  }
  deliveryModule.validateDeliveryConfig(config.delivery, config.bucket);
  if (checking) {
    console.log("Media profile and candidate validated; environment unchanged.");
  } else {
    const kept = original.split(/\r?\n/).filter(line => !managed.some(name => new RegExp(`^(?:export\\s+)?${name}\\s*=`).test(line.trimStart())));
    while (kept.at(-1) === "") kept.pop();
    const contents = [...kept, ...managed.map(name => `${name}=${env[name]}`), ""].join("\n");
    // Import the independently installed guard, never a candidate-controlled guard.
    // Candidate imports and staging remain outside the short decision-lock section.
    const { createReleaseFence } = await import(pathToFileURL(fenceLibrary));
    const staged = [];
    const stage = (destination, text) => {
      const temp = path.join(path.dirname(destination), `.for-now-media.${crypto.randomUUID()}`);
      const entry = { temp, destination }; staged.push(entry);
      let fd;
      try {
        fd = fs.openSync(temp, "wx", 0o600);
        fs.writeFileSync(fd, text); fs.fsyncSync(fd);
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    };
    try {
      stage(envPath, contents);
      if (profilePath !== persistentProfile) stage(persistentProfile, profileText);
      await createReleaseFence({ directory: fenceDirectory }).effect({
        target, attemptId, candidateSha, actualSha, action: "deploy", pid: Number(parentPid)
      }, () => {
        // Invalidation and new decisions use the same lock, so neither can win
        // between the final authorization check and these synchronous renames.
        for (const { temp, destination } of staged) fs.renameSync(temp, destination);
        for (const dirPath of new Set(staged.map(({ destination }) => path.dirname(destination)))) {
          const dir = fs.openSync(dirPath, "r");
          try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        }
      });
    } finally {
      for (const { temp } of staged) fs.rmSync(temp, { force: true });
    }
    console.log("Media environment and profile committed under the release decision lock (secret redacted).");
  }
} catch {
  // Deliberately suppress parser/import errors that could include secret data.
  console.error("Media configuration rejected; check trusted files, approved profile, and candidate compatibility. No secret logged.");
  process.exitCode = 1;
}
