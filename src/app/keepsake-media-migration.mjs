import crypto from "node:crypto";

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);
const errorCode = error => String(error?.code || error?.name || "KEEPSAKE_MEDIA_MIGRATION_FAILED").slice(0, 120);
const legacyCandidate = item => (
  item?.derivativeState === "legacy"
  && /^\/attachments\/[\w.-]+$/.test(item.originalPath || "")
  && /^\/attachments\/[\w.-]+$/.test(item.cutoutPath || "")
);
const identity = item => ({
  id: item.id,
  originalPath: item.originalPath,
  cutoutPath: item.cutoutPath,
  version: Math.max(1, Math.round(Number(item.version) || 1)),
  mediaVersion: Math.max(0, Math.round(Number(item.mediaVersion) || 0))
});
const planDigest = plan => sha256(JSON.stringify({
  version: plan.version,
  accountId: plan.accountId,
  items: plan.items
}));
const mediaDigest = value => sha256(JSON.stringify({
  source: value?.source || {},
  derivatives: value?.derivatives || {}
}));

export function createKeepsakeMediaMigration({
  repository,
  attachments,
  accountId,
  now = () => new Date().toISOString()
}) {
  if (!repository?.read || !repository?.update
    || !attachments?.previewKeepsakeSet || !attachments?.deriveKeepsakeSet
    || !attachments?.discard || !accountId) {
    throw new TypeError("Keepsake media migration requires an account repository and attachment workflow");
  }

  async function plan({ keepsakeIds = [], requirePrimaryStorage = false } = {}) {
    const selected = new Set(keepsakeIds.map(String).filter(Boolean));
    const store = await repository.read();
    const records = (store.keepsakes || [])
      .filter(item => legacyCandidate(item) && (!selected.size || selected.has(item.id)))
      .sort((left, right) => left.id.localeCompare(right.id));
    const items = [];
    for (const item of records) {
      const base = identity(item);
      try {
        const preview = await attachments.previewKeepsakeSet({
          originalPath: item.originalPath,
          alphaMaskPath: item.cutoutPath,
          requirePrimaryStorage
        });
        items.push({
          ...base,
          status: "ready",
          mediaSha256: mediaDigest(preview),
          source: preview.source,
          derivatives: preview.derivatives
        });
      } catch (error) {
        items.push({ ...base, status: "blocked", errorCode: errorCode(error) });
      }
    }
    const result = {
      version: 1,
      accountId,
      createdAt: now(),
      items,
      summary: {
        planned: items.filter(item => item.status === "ready").length,
        blocked: items.filter(item => item.status === "blocked").length
      }
    };
    result.planSha256 = planDigest(result);
    return result;
  }

  async function apply(planValue, { expectedPlanSha256 } = {}) {
    const migrationPlan = clone(planValue);
    if (migrationPlan?.version !== 1 || migrationPlan.accountId !== accountId || !Array.isArray(migrationPlan.items)) {
      throw Object.assign(new Error("小物媒体迁移计划无效"), { code: "INVALID_MIGRATION_PLAN" });
    }
    const actualPlanSha256 = planDigest(migrationPlan);
    if (!/^[a-f0-9]{64}$/.test(expectedPlanSha256 || "") || expectedPlanSha256 !== actualPlanSha256
      || migrationPlan.planSha256 !== actualPlanSha256) {
      throw Object.assign(new Error("小物媒体迁移计划哈希不匹配"), { code: "MIGRATION_PLAN_MISMATCH" });
    }
    if (migrationPlan.items.some(item => item.status !== "ready")) {
      throw Object.assign(new Error("小物媒体迁移计划包含阻断项"), { code: "MIGRATION_PLAN_BLOCKED" });
    }

    const results = [];
    for (const planned of migrationPlan.items) {
      let generatedPaths = [];
      try {
        const derived = await attachments.deriveKeepsakeSet({
          originalPath: planned.originalPath,
          alphaMaskPath: planned.cutoutPath
        });
        generatedPaths = Object.values(derived.paths || {})
          .filter(value => value && value !== planned.originalPath);
        if (mediaDigest(derived) !== planned.mediaSha256) {
          await attachments.discard(generatedPaths);
          generatedPaths = [];
          results.push({ id: planned.id, status: "conflicted", errorCode: "MIGRATION_MEDIA_CHANGED" });
          continue;
        }
        const updated = await repository.update(store => {
          const current = (store.keepsakes || []).find(item => item.id === planned.id);
          if (!current || !legacyCandidate(current)
            || current.originalPath !== planned.originalPath
            || current.cutoutPath !== planned.cutoutPath
            || Math.max(1, Math.round(Number(current.version) || 1)) !== planned.version
            || Math.max(0, Math.round(Number(current.mediaVersion) || 0)) !== planned.mediaVersion) {
            return { conflict: true };
          }
          Object.assign(current, derived.paths, {
            cutoutPath: current.cutoutPath,
            derivativeState: "ready",
            mediaVersion: planned.mediaVersion + 1,
            version: planned.version + 1,
            updatedAt: now()
          });
          return { value: identity(current) };
        });
        if (updated?.conflict) {
          await attachments.discard(generatedPaths);
          results.push({ id: planned.id, status: "conflicted" });
        } else {
          results.push({ id: planned.id, status: "migrated" });
        }
      } catch (error) {
        if (generatedPaths.length) await attachments.discard(generatedPaths).catch(() => {});
        results.push({ id: planned.id, status: "failed", errorCode: errorCode(error) });
      }
    }
    return {
      version: 1,
      accountId,
      planSha256: actualPlanSha256,
      completedAt: now(),
      results,
      summary: {
        migrated: results.filter(item => item.status === "migrated").length,
        conflicted: results.filter(item => item.status === "conflicted").length,
        failed: results.filter(item => item.status === "failed").length
      }
    };
  }

  return { plan, apply };
}
