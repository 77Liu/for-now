import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`认证测试服务提前退出：${child.exitCode}`);
    try {
      if ((await fetch(`${url}/now/healthz`)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error("认证测试服务启动超时");
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-auth-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const invitation = "regression-invitation";
const invitationHash = crypto.createHash("sha256").update(invitation).digest("hex");
const platformToken = "platform-regression-token-with-32-characters";
const platformTokenHash = crypto.createHash("sha256").update(platformToken).digest("hex");
const legacyStore = {
  version: 12,
  checkins: [],
  dailyRecords: [],
  captures: [{ id: "legacy", content: "legacy-owner-data", createdAt: "2026-09-27T00:00:00.000Z", occurredAt: "2026-09-27T00:00:00.000Z", occurredOn: "2026-09-27" }],
  journals: [],
  thoughts: [],
  chats: [],
  books: [],
  keepsakes: [],
  quotes: [],
  experiments: [],
  analyses: [],
  customMetrics: []
};
await fs.writeFile(path.join(dataDir, "store.json"), `${JSON.stringify(legacyStore)}\n`);

let providerCalls = 0;
const provider = http.createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  providerCalls += 1;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: "isolated response" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
let errors = "";
const startApp = () => {
  const app = spawn(globalThis.process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...globalThis.process.env, NODE_ENV: "test", DATA_DIR: dataDir, PORT: String(port), APP_BASE_PATH: "/now", INVITE_CODE_HASH: invitationHash, COOKIE_SECURE: "1", UPSTREAM_ORIGIN: "", PLATFORM_SERVICE_TOKEN_HASH: platformTokenHash, BACKUP_STATUS_FILE: path.join(dataDir, "missing-backup-marker"), DEEPSEEK_API_URL: `http://127.0.0.1:${provider.address().port}` },
    stdio: ["ignore", "pipe", "pipe"]
  });
  app.stderr.on("data", chunk => { errors += chunk; });
  return app;
};
let child = startApp();

try {
  await waitForServer(base, child);
  assert.equal((await fetch(`${base}/now`, { redirect: "manual" })).status, 308);
  assert.equal((await fetch(`${base}/now/styles.css`)).status, 200);
  const clientModule = await fetch(`${base}/now/frontend/api/index.mjs`);
  assert.equal(clientModule.status, 200);
  assert.match(clientModule.headers.get("content-type") || "", /^text\/javascript/);
  const manifestResponse = await fetch(`${base}/now/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get("content-type") || "", /^application\/manifest\+json/);
  assert.equal((await manifestResponse.json()).start_url, ".");
  assert.equal((await fetch(`${base}/now/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/now/api/admin/v1/snapshot`)).status, 401);
  assert.equal((await fetch(`${base}/now/api/admin/v1/snapshot`, {
    headers: { authorization: `Bearer ${platformToken}`, "x-forwarded-for": "203.0.113.4" }
  })).status, 403);

  const crossSite = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    headers: { "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ username: "attacker", password: "cross-site-password-1", invitation })
  });
  assert.equal(crossSite.response.status, 403);

  const rejected = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "correct-horse-battery-1", invitation: "wrong" })
  });
  assert.equal(rejected.response.status, 403);

  const weakPassword = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "letters-only", invitation })
  });
  assert.equal(weakPassword.response.status, 400);

  const registered = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "correct-horse-battery-1", invitation })
  });
  assert.equal(registered.response.status, 201);
  const ownerSetCookie = registered.response.headers.get("set-cookie");
  assert.match(ownerSetCookie, /;\s*Secure(?:;|$)/i);
  const ownerCookie = ownerSetCookie.split(";")[0];
  const ownerState = await jsonRequest(`${base}/now/api/state`, { headers: { cookie: ownerCookie } });
  assert.equal(ownerState.body.captures[0].content, "legacy-owner-data");

  const second = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "second", password: "another-long-password-2", invitation })
  });
  assert.equal(second.response.status, 201);
  const secondCookie = second.response.headers.get("set-cookie").split(";")[0];
  const secondState = await jsonRequest(`${base}/now/api/state`, { headers: { cookie: secondCookie } });
  assert.deepEqual(secondState.body.captures, []);
  const ownerCommercialization = await jsonRequest(`${base}/now/api/commercialization`, {
    method: "PATCH",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ assumptions: { validation: { participants: 11, rewardPerParticipantCny: 199 } } })
  });
  assert.equal(ownerCommercialization.response.status, 200);
  assert.equal(ownerCommercialization.body.assumptions.validation.participants, 11);
  assert.equal(ownerCommercialization.body.assumptions.validation.rewardPerParticipantCny, 199);
  assert.equal((await jsonRequest(`${base}/now/api/state`, { headers: { cookie: secondCookie } })).body.commercialization.assumptions.validation.participants, 5);
  const secondDir = path.join(dataDir, "users", second.body.user.id);
  assert.equal((await fs.stat(secondDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(secondDir, "attachments"))).mode & 0o777, 0o700);
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const uploaded = await jsonRequest(`${base}/now/api/images/upload`, {
    method: "POST", headers: { cookie: secondCookie }, body: JSON.stringify({ image: pixel })
  });
  assert.equal(uploaded.response.status, 201);
  assert.equal((await fs.stat(path.join(secondDir, uploaded.body.attachmentPath.replace("/attachments/", "attachments/")))).mode & 0o777, 0o600);
  const attachmentUrl = `${base}/now${uploaded.body.attachmentPath}`;
  const image = await fetch(attachmentUrl, { headers: { cookie: secondCookie } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(pixel.split(",")[1], "base64"));
  const imageHead = await fetch(attachmentUrl, { method: "HEAD", headers: { cookie: secondCookie } });
  assert.equal(imageHead.status, 200);
  assert.equal((await imageHead.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(attachmentUrl)).status, 401);
  assert.equal((await fetch(attachmentUrl, { method: "HEAD", headers: { cookie: ownerCookie } })).status, 404);
  assert.equal((await fetch(attachmentUrl, { method: "DELETE", headers: { cookie: secondCookie } })).status, 405);
  assert.equal((await fetch(`${base}/now/attachments/forbidden%2Fname`, { headers: { cookie: secondCookie } })).status, 403);
  const m4a = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  const audioDataUrl = `data:audio/mp4;base64,${m4a.toString("base64")}`;
  const audioUpload = await jsonRequest(`${base}/now/api/audio/upload`, {
    method: "POST",
    headers: { cookie: secondCookie, "idempotency-key": "auth-audio-upload-1" },
    body: JSON.stringify({ audio: audioDataUrl, durationMs: 1250 })
  });
  assert.equal(audioUpload.response.status, 201);
  assert.equal(audioUpload.body.audio.mimeType, "audio/mp4");
  assert.equal(audioUpload.body.audio.bytes, m4a.length);
  const audioUrl = `${base}/now${audioUpload.body.audio.attachmentPath}`;
  const audioResponse = await fetch(audioUrl, { headers: { cookie: secondCookie } });
  assert.equal(audioResponse.status, 200);
  assert.equal(audioResponse.headers.get("content-type"), "audio/mp4");
  assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), m4a);
  assert.equal((await fetch(audioUrl, { headers: { cookie: ownerCookie } })).status, 404);
  const audioCapture = await jsonRequest(`${base}/now/api/v1/captures`, {
    method: "POST",
    headers: { cookie: secondCookie, "idempotency-key": "auth-audio-capture-1" },
    body: JSON.stringify({
      content: "",
      attachmentPaths: [],
      audio: { ...audioUpload.body.audio, bytes: 999 },
      transcription: { status: "ready", rawText: "伪造转写", polishedText: "伪造整理" },
      timeMode: "now"
    })
  });
  assert.equal(audioCapture.response.status, 201);
  assert.equal(audioCapture.body.data.audio.attachmentPath, audioUpload.body.audio.attachmentPath);
  assert.equal(audioCapture.body.data.audio.bytes, m4a.length);
  assert.equal(audioCapture.body.data.transcription.status, "unconfigured");
  assert.equal(audioCapture.body.data.transcription.rawText, "");
  assert.equal(audioCapture.body.data.transcription.errorCode, "ASR_NOT_CONFIGURED");
  const audioRemoved = await jsonRequest(`${base}/now/api/v1/captures/${audioCapture.body.data.id}`, {
    method: "PATCH",
    headers: { cookie: secondCookie, "if-match": "\"1\"" },
    body: JSON.stringify({ content: "保留文字，移除语音", audio: null })
  });
  assert.equal(audioRemoved.response.status, 200);
  assert.equal(audioRemoved.body.data.audio, null);
  assert.equal((await fetch(audioUrl, { headers: { cookie: secondCookie } })).status, 200);
  const audioTrash = (await jsonRequest(`${base}/now/api/trash`, { headers: { cookie: secondCookie } })).body.items
    .find(item => item.type === "captureAudio");
  assert.ok(audioTrash);
  assert.equal((await jsonRequest(`${base}/now/api/trash/${audioTrash.id}/restore`, {
    method: "POST", headers: { cookie: secondCookie }, body: "{}"
  })).response.status, 200);
  const restoredAudioCapture = (await jsonRequest(`${base}/now/api/state`, { headers: { cookie: secondCookie } })).body.captures
    .find(item => item.id === audioCapture.body.data.id);
  assert.equal(restoredAudioCapture.audio.attachmentPath, audioUpload.body.audio.attachmentPath);
  assert.equal((await jsonRequest(`${base}/now/api/captures/legacy`, {
    method: "PATCH", headers: { cookie: secondCookie }, body: JSON.stringify({ content: "cross-account-change" })
  })).response.status, 404);
  assert.equal((await jsonRequest(`${base}/now/api/captures/legacy`, { method: "DELETE", headers: { cookie: ownerCookie } })).response.status, 200);
  const ownerTrash = await jsonRequest(`${base}/now/api/trash`, { headers: { cookie: ownerCookie } });
  const secondTrash = await jsonRequest(`${base}/now/api/trash`, { headers: { cookie: secondCookie } });
  assert.equal(ownerTrash.body.items.length, 1);
  assert.equal(secondTrash.body.items.length, 0);
  assert.equal((await jsonRequest(`${base}/now/api/trash/${ownerTrash.body.items[0].id}/restore`, { method: "POST", headers: { cookie: secondCookie }, body: "{}" })).response.status, 404);
  assert.equal((await jsonRequest(`${base}/now/api/trash`, { headers: { cookie: ownerCookie } })).body.items.length, 1);
  assert.equal((await jsonRequest(`${base}/now/api/trash/${ownerTrash.body.items[0].id}/restore`, { method: "POST", headers: { cookie: ownerCookie }, body: "{}" })).response.status, 200);
  assert.equal((await jsonRequest(`${base}/now/api/state`, { headers: { cookie: ownerCookie } })).body.captures[0].content, "legacy-owner-data");
  const keepsake = await jsonRequest(`${base}/now/api/keepsakes`, {
    method: "POST", headers: { cookie: secondCookie },
    body: JSON.stringify({ title: "账户二小物", occurredAt: "2026-09-29T00:10:20.000Z", originalPath: uploaded.body.attachmentPath, cutoutPath: uploaded.body.attachmentPath, tags: ["纪念"] })
  });
  assert.equal(keepsake.response.status, 201);
  const keepsakeUrl = `${base}/now/api/keepsakes/${keepsake.body.id}`;
  assert.equal((await jsonRequest(keepsakeUrl, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ title: "越权" }) })).response.status, 404);
  assert.equal((await jsonRequest(keepsakeUrl, { method: "DELETE", headers: { cookie: ownerCookie } })).response.status, 404);
  const editedKeepsake = await jsonRequest(keepsakeUrl, { method: "PATCH", headers: { cookie: secondCookie }, body: JSON.stringify({ title: "新名称", occurredOn: "2026-10-01" }) });
  assert.equal(editedKeepsake.response.status, 200);
  assert.equal(editedKeepsake.body.createdAt, keepsake.body.createdAt);
  assert.equal(editedKeepsake.body.occurredOn, "2026-10-01");
  assert.equal(editedKeepsake.body.originalPath, undefined);
  assert.equal((await jsonRequest(`${keepsakeUrl}/original`, { headers: { cookie: secondCookie } })).body.originalPath, uploaded.body.attachmentPath);
  const deletedKeepsake = await jsonRequest(keepsakeUrl, { method: "DELETE", headers: { cookie: secondCookie } });
  const restoredKeepsake = await jsonRequest(`${base}/now/api/trash/${deletedKeepsake.body.trashId}/restore`, { method: "POST", headers: { cookie: secondCookie }, body: "{}" });
  assert.equal(restoredKeepsake.response.status, 200);
  const afterKeepsakeRestore = (await jsonRequest(`${base}/now/api/state`, { headers: { cookie: secondCookie } })).body.keepsakes[0];
  assert.equal(afterKeepsakeRestore.title, "新名称");
  assert.equal(afterKeepsakeRestore.createdAt, keepsake.body.createdAt);
  assert.ok(afterKeepsakeRestore.version > editedKeepsake.body.version);
  assert.deepEqual((await jsonRequest(`${base}/now/api/state`, { headers: { cookie: ownerCookie } })).body.keepsakes, []);
  assert.equal((await jsonRequest(`${base}/now/api/onboarding/schema`)).response.status, 401);
  const onboardingSchema = (await jsonRequest(`${base}/now/api/onboarding/schema`, { headers: { cookie: ownerCookie } })).body;
  const answers = Object.fromEntries(onboardingSchema.questions.filter(item => item.tier === "quick").map(item => [item.id, item.options[0].value]));
  await Promise.all([[ownerCookie, "ONBOARDING_OWNER"], [secondCookie, "ONBOARDING_SECOND"]].map(async ([cookie, material]) => {
    const saved = await jsonRequest(`${base}/now/api/onboarding`, {
      method: "PATCH", headers: { cookie }, body: JSON.stringify({ status: "completed", answers, material })
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.material, material);
    const state = await jsonRequest(`${base}/now/api/state`, { headers: { cookie } });
    assert.equal(state.body.onboarding.material, material);
  }));
  await Promise.all([[ownerCookie, "OWNER_PRIVATE"], [secondCookie, "SECOND_PRIVATE"]].map(async ([cookie, question]) => {
    assert.equal((await jsonRequest(`${base}/now/api/settings`, {
      method: "POST", headers: { cookie }, body: JSON.stringify({ apiKey: "audit-test-key" })
    })).response.status, 200);
    assert.equal((await jsonRequest(`${base}/now/api/answer-drafts`, {
      method: "POST", headers: { cookie }, body: JSON.stringify({ question, requestId: `auth-${question}`, targetId: "auth-regression", inputVersion: 1 })
    })).response.status, 200);
  }));
  const readLogs = async userId => {
    const dir = path.join(dataDir, "users", userId, "logs");
    return (await Promise.all((await fs.readdir(dir)).map(name => fs.readFile(path.join(dir, name), "utf8")))).join("\n");
  };
  const ownerLogs = await readLogs(registered.body.user.id), secondLogs = await readLogs(second.body.user.id);
  assert.match(ownerLogs, /OWNER_PRIVATE/);
  assert.match(ownerLogs, /ONBOARDING_OWNER/);
  assert.doesNotMatch(ownerLogs, /SECOND_PRIVATE|ONBOARDING_SECOND|audit-test-key/);
  assert.match(secondLogs, /SECOND_PRIVATE/);
  assert.match(secondLogs, /ONBOARDING_SECOND/);
  assert.doesNotMatch(secondLogs, /OWNER_PRIVATE|ONBOARDING_OWNER|legacy-owner-data|audit-test-key/);
  for (const userId of [registered.body.user.id, second.body.user.id]) {
    const entries = JSON.parse(await fs.readFile(path.join(dataDir, "users", userId, "ai-usage.json"))).entries;
    assert.equal(entries.length, 1);
  }
  const platformSnapshot = await jsonRequest(`${base}/now/api/admin/v1/snapshot`, {
    headers: { authorization: `Bearer ${platformToken}` }
  });
  assert.equal(platformSnapshot.response.status, 200);
  assert.equal(platformSnapshot.body.meta.source, "live-aggregate");
  assert.equal(platformSnapshot.body.users.length, 2);
  assert.equal(platformSnapshot.body.privacy.containsRecordContent, false);
  assert.equal(platformSnapshot.body.privacy.containsPromptOrResponse, false);
  assert.doesNotMatch(JSON.stringify(platformSnapshot.body), /OWNER_PRIVATE|SECOND_PRIVATE|legacy-owner-data|passwordHash|audit-test-key/);

  const duplicateRename = await jsonRequest(`${base}/now/api/auth/username`, {
    method: "PATCH",
    headers: { cookie: secondCookie },
    body: JSON.stringify({ username: "OWNER" })
  });
  assert.equal(duplicateRename.response.status, 409);

  const renamed = await jsonRequest(`${base}/now/api/auth/username`, {
    method: "PATCH",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ username: "keeper" })
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.user.username, "keeper");

  const wrongCurrentPassword = await jsonRequest(`${base}/now/api/auth/password`, {
    method: "PATCH",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ currentPassword: "wrong-password-1", newPassword: "new-secure-password-2" })
  });
  assert.equal(wrongCurrentPassword.response.status, 403);

  const changedPassword = await jsonRequest(`${base}/now/api/auth/password`, {
    method: "PATCH",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ currentPassword: "correct-horse-battery-1", newPassword: "new-secure-password-2" })
  });
  assert.equal(changedPassword.response.status, 200);
  assert.equal((await fetch(`${base}/now/api/state`, { headers: { cookie: ownerCookie } })).status, 200);

  const oldPasswordLogin = await jsonRequest(`${base}/now/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username: "keeper", password: "correct-horse-battery-1" })
  });
  assert.equal(oldPasswordLogin.response.status, 401);
  const newPasswordLogin = await jsonRequest(`${base}/now/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username: "keeper", password: "new-secure-password-2" })
  });
  assert.equal(newPasswordLogin.response.status, 200);

  const validAuthFile = await fs.readFile(path.join(dataDir, "auth.json"), "utf8");
  assert.doesNotMatch(validAuthFile, /correct-horse-battery|another-long-password|new-secure-password|regression-invitation/);
  assert.equal((await fs.stat(path.join(dataDir, "auth.json"))).mode & 0o777, 0o600);

  const loggedOut = await jsonRequest(`${base}/now/api/auth/logout`, { method: "POST", headers: { cookie: ownerCookie }, body: "{}" });
  const clearedCookie = loggedOut.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/now/api/state`, { headers: { cookie: clearedCookie } })).status, 401);
  await sleep(100);
  const logs = [await readLogs(registered.body.user.id), await readLogs(second.body.user.id),
    ...(await Promise.all((await fs.readdir(path.join(dataDir, "logs"))).map(name => fs.readFile(path.join(dataDir, "logs", name), "utf8"))))].join("\n");
  assert.doesNotMatch(logs, /correct-horse-battery|another-long-password|new-secure-password|regression-invitation|scrypt\$/);
  assert.ok(logs.includes('"passwordHash"')); // Field name is useful; credential value is not.

  const oldStore = JSON.parse(await fs.readFile(path.join(secondDir, "store.json"), "utf8"));
  const oldSettings = JSON.parse(await fs.readFile(path.join(secondDir, "llm-settings.json"), "utf8"));
  const oldUsage = JSON.parse(await fs.readFile(path.join(secondDir, "ai-usage.json"), "utf8"));
  const queuedQuestion = { id: "restart-question", type: "question", content: "账户任务重启恢复", tags: [], relatedTo: null, remarks: [], followUps: [], annotations: [], annotationDrift: [], disposition: "kept", authorType: "user", version: 1, createdAt: "2026-09-27T18:00:00.000Z", occurredAt: "2026-09-27T18:00:00.000Z", occurredOn: "2026-09-28" };
  const queuedFollowUp = { id: "restart-follow-up", question: "服务器重启后继续回答追问", answer: "", version: 1, createdAt: "2026-09-27T18:01:00.000Z" };
  const queuedFollowUpQuestion = { ...queuedQuestion, id: "restart-follow-up-question", content: "账户追问任务重启恢复", followUps: [queuedFollowUp], createdAt: "2026-09-27T18:01:00.000Z" };
  const queuedAnnotation = { id: "restart-annotation", kind: "highlight", targetKey: "question:restart-annotation-question", start: 2, end: 6, quote: "批注任务", text: "", createdAt: "2026-09-27T18:02:00.000Z", replies: [], shenji: [] };
  const queuedAnnotationQuestion = { ...queuedQuestion, id: "restart-annotation-question", content: "服务器批注任务重启恢复", annotations: [queuedAnnotation], createdAt: "2026-09-27T18:02:00.000Z" };
  const queuedTasks = [
    { id: "restart-queued-task", kind: "thoughtAnswer", resourceType: "thought", targetId: queuedQuestion.id, inputVersion: 1, clientRequestId: "restart-queued-request", requestHash: crypto.createHash("sha256").update(JSON.stringify({ kind: "thoughtAnswer", targetId: queuedQuestion.id, inputVersion: 1 })).digest("hex"), status: "queued", createdAt: "2026-09-27T18:00:01.000Z", updatedAt: "2026-09-27T18:00:01.000Z", attempt: 0 },
    { id: "restart-follow-up-task", kind: "followUpAnswer", resourceType: "thought", targetId: queuedFollowUpQuestion.id, subtargetId: queuedFollowUp.id, inputVersion: 1, subtargetVersion: 1, payload: {}, clientRequestId: "restart-follow-up-request", requestHash: "restart-follow-up-hash", status: "queued", createdAt: "2026-09-27T18:01:01.000Z", updatedAt: "2026-09-27T18:01:01.000Z", attempt: 0 },
    { id: "restart-annotation-task", kind: "annotationShenji", resourceType: "thought", targetId: queuedAnnotationQuestion.id, subtargetId: queuedAnnotation.id, inputVersion: 1, subtargetVersion: 0, payload: { message: "重启后继续批注分析" }, clientRequestId: "restart-annotation-request", requestHash: "restart-annotation-hash", status: "queued", createdAt: "2026-09-27T18:02:01.000Z", updatedAt: "2026-09-27T18:02:01.000Z", attempt: 0 }
  ];
  queuedTasks.push({ ...queuedTasks[2], id: "legacy-unversioned-annotation", inputVersion: 0, clientRequestId: "legacy-unversioned-request" });
  await fs.writeFile(path.join(secondDir, "store.json"), JSON.stringify({ ...oldStore, version: 11, thoughts: [queuedQuestion, queuedFollowUpQuestion, queuedAnnotationQuestion, ...(oldStore.thoughts || [])], aiTasks: [...queuedTasks, ...(oldStore.aiTasks || [])], notifications: [] }));
  await fs.writeFile(path.join(secondDir, "llm-settings.json"), JSON.stringify({ ...oldSettings, version: 3 }));
  await fs.writeFile(path.join(secondDir, "ai-usage.json"), JSON.stringify({ ...oldUsage, version: 1 }));
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  child = startApp();
  await waitForServer(base, child);
  const migratedNames = await fs.readdir(secondDir);
  assert.ok(migratedNames.some(name => /store\.json\.v11-pre-v15.*\.bak$/.test(name)));
  assert.ok(migratedNames.some(name => /llm-settings\.json\.v3-pre-v7.*\.bak$/.test(name)));
  assert.ok(migratedNames.some(name => /ai-usage\.json\.v1-pre-v3.*\.bak$/.test(name)));
  for (const name of migratedNames.filter(name => name.endsWith(".bak"))) {
    assert.equal((await fs.stat(path.join(secondDir, name))).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(secondDir, "ai-usage.json"), "utf8")).version, 3);
  const resumedTasks = new Map();
  for (const queuedTask of queuedTasks) {
    let resumedTask;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      resumedTask = (await jsonRequest(`${base}/now/api/ai-tasks/${queuedTask.id}`, { headers: { cookie: secondCookie } })).body;
      if (!["queued", "running"].includes(resumedTask.status)) break;
      await sleep(50);
    }
    assert.equal(resumedTask.status, queuedTask.inputVersion ? "succeeded" : "stale");
    resumedTasks.set(queuedTask.id, resumedTask);
  }
  const resumedState = (await jsonRequest(`${base}/now/api/state`, { headers: { cookie: secondCookie } })).body;
  assert.equal(resumedState.thoughts.filter(item => item.sourceTaskId === queuedTasks[0].id).length, 1);
  assert.equal(resumedState.thoughts.find(item => item.id === queuedFollowUpQuestion.id).followUps[0].sourceTaskId, queuedTasks[1].id);
  assert.equal(resumedState.thoughts.find(item => item.id === queuedAnnotationQuestion.id).annotations[0].shenji[0].sourceTaskId, queuedTasks[2].id);
  assert.equal(resumedState.notifications.filter(item => queuedTasks.some(task => task.id === item.taskId) && item.status === "succeeded").length, 3);
  const callsAfterResume = providerCalls;
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  child = startApp();
  await waitForServer(base, child);
  await sleep(150);
  assert.equal(providerCalls, callsAfterResume);
  const stateAfterSecondRestart = (await jsonRequest(`${base}/now/api/state`, { headers: { cookie: secondCookie } })).body;
  assert.equal(stateAfterSecondRestart.thoughts.filter(item => item.sourceTaskId === queuedTasks[0].id).length, 1);
  assert.equal(stateAfterSecondRestart.thoughts.find(item => item.id === queuedFollowUpQuestion.id).followUps.filter(item => item.sourceTaskId === queuedTasks[1].id).length, 1);
  assert.equal(stateAfterSecondRestart.thoughts.find(item => item.id === queuedAnnotationQuestion.id).annotations[0].shenji.filter(item => item.sourceTaskId === queuedTasks[2].id).length, 1);

  await fs.writeFile(path.join(dataDir, "auth.json"), "{PRIVATE_CORRUPT_AUTH");
  const damaged = await jsonRequest(`${base}/now/api/auth/me`, { headers: { cookie: secondCookie } });
  assert.equal(damaged.response.status, 500);
  assert.doesNotMatch(JSON.stringify(damaged.body) + errors, /PRIVATE_CORRUPT_AUTH/);
  assert.equal(await fs.readFile(path.join(dataDir, "auth.json"), "utf8"), "{PRIVATE_CORRUPT_AUTH");
  console.log("Auth checks passed: access boundaries, guessed-resource rejection, secure sessions, per-user AI/operation isolation, queued-task restart recovery, credential redaction and corrupt-auth preservation.");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  await new Promise(resolve => provider.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
}

if (errors) process.stderr.write(errors);
