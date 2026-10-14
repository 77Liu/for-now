/**
 * 真实浏览器 IndexedDB 业务映射原子提交验证。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：随机命名临时数据库及合成对象，执行结束删除数据库。
 */
export {};
const moduleUrl = "/public/frontend/sync/index.mjs";
const { createIndexedDbSyncStore } = await import(moduleUrl);
const databaseName = `short-id-regression-${crypto.randomUUID()}`;
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
try {
  const first = createIndexedDbSyncStore({ databaseName });
  const second = createIndexedDbSyncStore({ databaseName });
  const parent = { id: "create", owner: "account-a", status: "pending", createdAt: "2026-10-14T00:00:00Z" };
  const child = { id: "child", owner: "account-a", status: "pending", createdAt: "2026-10-14T00:00:01Z", targetId: "AAAAAAAAAAAAAAAA" };
  await first.put(parent);
  await first.put(child);
  await first.put({ ...child, owner: "account-b" });
  const rows = await first.list("account-a");
  const mapping = { accountId: "account-a", operationId: "create", provisionalId: "AAAAAAAAAAAAAAAA", canonicalId: "BBBBBBBBBBBBBBBB" };
  const updated = rows.map((row: typeof child) => row.id === "create" ? { ...row, status: "committed" }
    : { ...row, targetId: mapping.canonicalId });
  check(await first.atomicWrite("account-a", rows, [], updated, [mapping]), "原子提交失败");
  check((await second.readMappings("account-a"))[0].canonicalId === mapping.canonicalId, "第二连接未读到映射");
  const restored = await second.list("account-a");
  check(restored.find((row: typeof child) => row.id === "create").status === "committed", "ACK 未保存");
  check(restored.find((row: typeof child) => row.id === "child").targetId === mapping.canonicalId, "依赖未保存");
  check((await second.list("account-b"))[0].targetId === mapping.provisionalId, "跨账户误改");
  check(!await second.atomicWrite("account-a", rows, [], updated, [mapping]), "过期快照应拒绝");
  const before = await second.list("account-a");
  let aborted = false;
  try {
    await second.atomicWrite("account-a", before, [mapping], [
      { ...before[0], status: "failed" }, { ...before[1], unserializable: () => {} }
    ], []);
  } catch { aborted = true; }
  check(aborted, "非法 IDB 值应触发事务中止");
  check(JSON.stringify(await first.list("account-a")) === JSON.stringify(before), "事务中止后部分 ACK 写入");
  check((await first.readMappings("account-a")).length === 1, "事务中止后映射丢失");
  await first.clear("account-a");
  check((await second.list("account-a")).length === 0 && (await second.readMappings("account-a")).length === 0, "注销未清理映射");
  document.body.textContent = "PASS: IndexedDB 原子 ACK/依赖/映射、跨连接恢复、CAS 冲突、事务中止回滚及账户隔离。";
} catch (error) {
  document.body.textContent = `FAIL: ${error instanceof Error ? error.stack : error}`;
} finally {
  const deletion = indexedDB.deleteDatabase(databaseName);
  deletion.addEventListener("blocked", () => { /* 连接收到 versionchange 后自动关闭。 */ });
  await fetch("/result", { method: "POST", body: document.body.textContent });
}
