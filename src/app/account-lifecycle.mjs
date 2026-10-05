import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const LEGACY_FILES = ["store.json", "llm-settings.json", "ai-usage.json"];
const LEGACY_DIRECTORIES = ["attachments", "logs"];

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function copyLegacyFile(source, target) {
  try {
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
  }
}

async function copyLegacyDirectory(source, target) {
  try {
    await fs.cp(source, target, { recursive: true, errorOnExist: false });
    await fs.chmod(target, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function createAccountLifecycle({
  dataDir,
  usersDir = path.join(dataDir, "users"),
  authRequired = false,
  postgresRuntime = null,
  requestStorage,
  emptyStore,
  normalizeStore,
  normalizeLlmSettings,
  normalizeAiUsage,
  ensureStore,
  ensureLlmSettings,
  ensureAiUsage,
  ensureAuditLogs,
  resumeAttachmentCleanup,
  backgroundAi,
  keepsakeMediaWorkflows,
  localTestRuntime = null,
  readUsers = null
}) {
  const userDataDir = user => {
    if (!user?.id) throw new TypeError("Account lifecycle requires a user id");
    return path.join(usersDir, user.id);
  };

  async function recoverCurrentStorage() {
    await ensureStore();
    await ensureLlmSettings();
    await ensureAiUsage();
    await ensureAuditLogs();
    await resumeAttachmentCleanup();
    await backgroundAi.resume();
    await keepsakeMediaWorkflows.resume();
  }

  async function initializeUserStorage(user, importLegacy = false) {
    const target = userDataDir(user);
    const existed = Boolean(await fs.stat(target).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    }));
    const rollback = async () => {
      if (!existed) await fs.rm(target, { recursive: true, force: true });
    };
    try {
      await ensurePrivateDirectory(target);

      // PostgreSQL queues provisioning in the surrounding auth transaction.
      if (postgresRuntime) {
        postgresRuntime.auth.provision(
          user.id,
          normalizeStore(structuredClone(emptyStore)),
          {
            settings: normalizeLlmSettings({}),
            usage: normalizeAiUsage({})
          }
        );
        await ensurePrivateDirectory(path.join(target, "attachments"));
        await requestStorage.run(
          { ...(requestStorage.getStore() || {}), user, dataDir: target },
          ensureAuditLogs
        );
        return rollback;
      }

      if (importLegacy) {
        for (const name of LEGACY_FILES) {
          await copyLegacyFile(path.join(dataDir, name), path.join(target, name));
        }
        for (const name of LEGACY_DIRECTORIES) {
          await copyLegacyDirectory(path.join(dataDir, name), path.join(target, name));
        }
      }

      await requestStorage.run(
        { ...(requestStorage.getStore() || {}), user, dataDir: target },
        async () => {
          await ensureStore();
          await ensureLlmSettings();
          await ensureAiUsage();
          await ensureAuditLogs();
        }
      );
      return rollback;
    } catch (error) {
      await rollback().catch(() => {});
      throw error;
    }
  }

  async function recoverUser(user) {
    const target = userDataDir(user);
    await ensurePrivateDirectory(target);
    return requestStorage.run({ user, dataDir: target }, recoverCurrentStorage);
  }

  async function recoverAtStartup(options = {}) {
    const startupLocalTestRuntime = options.localTestRuntime ?? localTestRuntime;
    const startupReadUsers = options.readUsers ?? readUsers;
    let localTestInitialized = false;

    if (startupLocalTestRuntime) {
      if (typeof startupLocalTestRuntime.initialize !== "function") {
        throw new TypeError("Local-test runtime requires an initialize callback");
      }
      localTestInitialized = await startupLocalTestRuntime.initialize(recoverCurrentStorage) === true;
    }
    if (!localTestInitialized && !authRequired) {
      await recoverCurrentStorage();
    }

    await ensurePrivateDirectory(usersDir);
    if (!authRequired) return;
    if (typeof startupReadUsers !== "function") {
      throw new TypeError("Authenticated startup requires readUsers");
    }

    const users = await startupReadUsers();
    if (!Array.isArray(users)) throw new TypeError("readUsers must return an array");
    for (const user of users) await recoverUser(user);
  }

  return {
    userDataDir,
    initializeUserStorage,
    recoverCurrentStorage,
    recoverUser,
    recoverAtStartup
  };
}
