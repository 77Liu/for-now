/**
 * 正式 HTTP 思绪子项删除恢复及账户隔离验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：由隔离 PostgreSQL 应用夹具提供会话，无供应商调用。
 */
import assert from "node:assert/strict";
type Response = {
  status: number;
  body: { id?: string; content?: string; version?: number; trashId?: string; items?: { id: string; type: string }[] };
};
type Request = (
  base: string,
  route: string,
  options?: { method?: string; cookie?: string; body?: unknown }
) => Promise<Response>;

/** 覆盖正式装配入口、跨账户拒绝和一次恢复回收项消费。 @since unreleased */
export async function runThoughtTrashHttpChecks({
  base, request, cookie, otherCookie
}: { base: string; request: Request; cookie: string; otherCookie: string }) {
  const created = await request(base, "/api/thought-chains", {
    method: "POST", cookie,
    body: { question: "HTTP 回收恢复问题", idea: "HTTP 回收恢复内容", clientRequestId: "http-trash-root" }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const items = created.body.items || [];
  const root = items.find(item => item.type === "question");
  const block = items.find(item => item.type === "idea");
  assert.ok(root && block);
  const editRoute = `/api/thoughts/${block.id}`;
  assert.equal((await request(base, editRoute, {
    method: "PATCH", cookie: otherCookie, body: { content: "跨账户禁止修改" }
  })).status, 404);
  const edited = await request(base, editRoute, {
    method: "PATCH", cookie, body: { content: "HTTP 精准内容块修改", expectedVersion: 1 }
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.content, "HTTP 精准内容块修改");
  assert.equal(edited.body.version, 2);
  const staleEdit = await request(base, editRoute, {
    method: "PATCH", cookie, body: { content: "旧版本不可覆盖", expectedVersion: 1 }
  });
  assert.equal(staleEdit.status, 409);
  const remark = await request(base, `/api/thoughts/${block.id}/remarks`, {
    method: "POST", cookie, body: { text: "HTTP 块内备注" }
  });
  assert.equal(remark.status, 201);
  const followUp = await request(base, `/api/thoughts/${root.id}/follow-ups`, {
    method: "POST", cookie, body: { question: "HTTP 追问", answer: "" }
  });
  assert.equal(followUp.status, 201);
  for (const route of [
    `/api/thoughts/${block.id}/remarks/${remark.body.id}`,
    `/api/thoughts/${root.id}/follow-ups/${followUp.body.id}`,
    `/api/thoughts/${block.id}`
  ]) {
    assert.equal((await request(base, route, { method: "DELETE", cookie: otherCookie })).status, 404);
    const removed = await request(base, route, { method: "DELETE", cookie });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const restoreRoute = `/api/trash/${removed.body.trashId}/restore`;
    assert.equal((await request(base, restoreRoute, { method: "POST", cookie: otherCookie })).status, 404);
    const restored = await request(base, restoreRoute, { method: "POST", cookie });
    assert.equal(restored.status, 200, JSON.stringify({ route, body: restored.body }));
    assert.equal((await request(base, restoreRoute, { method: "POST", cookie })).status, 404);
  }
  const deletedRoot = await request(base, `/api/thought-chains/${root.id}`, { method: "DELETE", cookie });
  assert.equal(deletedRoot.status, 200);
  assert.equal((await request(base, `/api/trash/${deletedRoot.body.trashId}/restore`, {
    method: "POST", cookie
  })).status, 200);
  console.log("Thought trash HTTP passed: block/remark/follow-up/chain restoration and account isolation.");
}
