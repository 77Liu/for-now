import { promises as fs } from "node:fs";
import path from "node:path";
import { migrationStore } from "./migration-store.mjs";

export async function writeMigrationBundleFixture(directory) {
  const auth = {
    version: 1, extension: { retained: true },
    users: ["bundle-a", "bundle-b"].map((id, position) => ({
      id, username: `user-${position}`, passwordHash: "scrypt$synthetic-salt$synthetic-hash",
      createdAt: "2026-09-28T01:02:03.000Z", roles: ["member"], extension: null
    })),
    sessions: ["bundle-a", "bundle-b"].map((userId, position) => ({
      userId, tokenHash: `synthetic-digest-${position}`, createdAt: "2026-09-28T01:02:03.000Z",
      expiresAt: "2026-10-28T01:02:03.000Z", extension: ["preserve"]
    }))
  };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  await fs.writeFile(path.join(directory, "ai-budget.json"), JSON.stringify({
    version: 1,
    periods: [{ key: "2026-10-02", knownCostMicros: 12_340_000 }],
    reservations: [{ id: "synthetic-budget-reservation", accountId: "bundle-a" }],
    extension: { retained: true }
  }), { mode: 0o600 });
  for (const user of auth.users) {
    const root = path.join(directory, "users", user.id);
    await fs.mkdir(path.join(root, "attachments"), { recursive: true, mode: 0o700 });
    const store = migrationStore();
    store.captures[0].content = user.id;
    const values = {
      "store.json": store,
      "llm-settings.json": {
        version: 3, apiKey: "synthetic-only-key", assistantName: "神鸡",
        profiles: { lite: { model: "deepseek-flash", effort: "none", extension: 3 } },
        scenarios: { thoughtAnswer: "lite" }, responseStyles: { thoughtAnswer: "concise" },
        unknown: [null, {}, []]
      },
      "ai-usage.json": {
        version: 3, trackingStartedAt: "2026-09-28T01:02:03.000Z",
        entries: [{
          id: "call-1", callId: "call-1", model: "deepseek-flash", scene: "thoughtAnswer",
          status: "success", tokens: { input: 100, output: 42 }, costsUsd: { total: 0.0021 },
          ratesUsdPerMillion: { output: 1.2 }, rawUsage: { extension: 5 }, unknown: false
        }], extension: { empty: [] }
      },
      "ai-cost-plan.json": {
        version: 1, monthlyBudgetCny: 30, cnyPerUsd: 7.2,
        scenarios: [{ scene: "thoughtAnswer", model: "deepseek-flash", callsPerMonth: 11, extension: null }]
      }
    };
    for (const [name, value] of Object.entries(values)) await fs.writeFile(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
    const names = new Set(JSON.stringify(store).match(/\/attachments\/[\w.-]+/g));
    for (const resourcePath of names) await fs.writeFile(path.join(root, resourcePath.slice(1)), `synthetic attachment ${resourcePath}`, { mode: 0o600 });
    await fs.writeFile(path.join(root, "attachments/orphan.png"), "unreferenced recovery asset", { mode: 0o600 });
  }
  return auth;
}
