import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverJsonBundle, mapAccountDocument, rebuildAccountDocument, mapAuthDocument, rebuildAuthDocument
} from "../src/shared/persistence/index.mjs";
import { writeMigrationBundleFixture } from "./fixtures/migration-bundle.mjs";
import { createAttachmentStorage } from "../src/shared/attachments/index.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-documents-"));
try {
  const auth = await writeMigrationBundleFixture(directory);
  assert.deepEqual(rebuildAuthDocument(mapAuthDocument(auth)), auth);
  const bundle = await discoverJsonBundle(directory);
  assert.equal(bundle.accounts.length, 2);
  assert.equal(bundle.aiBudget.reservations[0].id, "synthetic-budget-reservation");
  assert.ok(bundle.sources.some(item => item.file === path.join(directory, "ai-budget.json") && item.sha256?.length === 64));
  assert.equal(bundle.sourceSha256.length, 64);
  assert.equal((await discoverJsonBundle(directory)).sourceSha256, bundle.sourceSha256);
  for (const { plan, documents, inventory } of bundle.accounts) {
    for (const [document, value] of Object.entries(documents)) assert.deepEqual(
      rebuildAccountDocument(mapAccountDocument(plan.accountId, document, value)), value
    );
    const mapping = mapAccountDocument(plan.accountId, "settings", documents.settings);
    assert.equal(mapping.secrets[0].payload, "synthetic-only-key");
    assert.ok(!JSON.stringify({ fields: mapping.fields, records: mapping.records }).includes("synthetic-only-key"));
    assert.ok(inventory.every(item => item.bytes > 0 && item.sha256.length === 64));
    assert.ok(inventory.some(item => item.path === "/attachments/orphan.png"));
  }
  assert.deepEqual(rebuildAccountDocument(mapAccountDocument("a", "settings", {})), {});
  assert.deepEqual(rebuildAccountDocument(mapAccountDocument("a", "settings", { apiKey: null, profiles: {}, extension: null })), { apiKey: null, profiles: {}, extension: null });
  const prototype = JSON.parse('{"__proto__":{"kept":true},"constructor":null}');
  assert.deepEqual(rebuildAccountDocument(mapAccountDocument("a", "settings", prototype)), prototype);
  assert.equal({}.kept, undefined);
  for (const mutate of [
    value => value.users.push(value.users[0]),
    value => { value.users[1].username = value.users[0].username.toUpperCase(); },
    value => { value.users[0].id = "../escape"; },
    value => { value.sessions[0].userId = "missing"; },
    value => value.sessions.push(value.sessions[0])
  ]) {
    const value = structuredClone(auth);
    mutate(value);
    assert.throws(() => mapAuthDocument(value));
  }
  assert.throws(() => mapAccountDocument("a", "usage", { entries: [{ id: "same" }, { id: "same" }] }), /duplicate/);
  assert.throws(() => mapAccountDocument("a", "costPlan", { scenarios: [{ scene: "same" }, { scene: "same" }] }), /duplicate/);
  assert.throws(() => mapAccountDocument("a", "settings", { profiles: [] }), /Invalid/);
  const account = bundle.accounts[0];
  const live = account.plan.business.attachmentRefs.find(ref => ref.fieldName !== "attachmentCleanup");
  const file = path.join(directory, "users", account.plan.accountId, live.path.slice(1));
  const bytes = await fs.readFile(file);
  await fs.unlink(file);
  await assert.rejects(discoverJsonBundle(directory), /Missing referenced attachment/);
  await fs.writeFile(file, bytes);
  const cleanup = account.plan.business.attachmentRefs.find(ref => ref.fieldName === "attachmentCleanup");
  const cleanupFile = path.join(directory, "users", account.plan.accountId, cleanup.path.slice(1));
  await fs.unlink(cleanupFile);
  const cleanupBundle = await discoverJsonBundle(directory);
  assert.equal(cleanupBundle.accounts[0].inventory.find(item => item.path === cleanup.path).state, "missing_cleanup");
  const settingsFile = path.join(path.dirname(path.dirname(file)), "llm-settings.json");
  await fs.writeFile(settingsFile, '{"apiKey":"synthetic-private');
  await assert.rejects(discoverJsonBundle(directory), error => error.message === "Invalid migration document: llm-settings.json");
  await writeMigrationBundleFixture(directory);
  await fs.writeFile(path.join(directory, "ai-budget.json"), "[]");
  await assert.rejects(discoverJsonBundle(directory), error => error.message === "Invalid migration document: ai-budget.json");
  await writeMigrationBundleFixture(directory);
  const mock = createAttachmentStorage({ mode: "mock", testMode: true, mockDir: path.join(directory, "mock") });
  const inspected = await mock.inspect({ ownerId: "bundle-a", name: path.basename(file), localFile: file });
  assert.equal(inspected.storage, "local");
  await mock.put({ ownerId: "bundle-a", name: path.basename(file), data: Buffer.from("remote fixture"), localFile: file });
  assert.equal((await mock.inspect({ ownerId: "bundle-a", name: path.basename(file), localFile: file })).storage, "mock");
  console.log("Document migration checks passed: lossless identities/config/usage/costs/site budget, secret partition, duplicates, missing attachments, hashes and mock fallback.");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
