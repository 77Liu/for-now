/**
 * 通知领域的只读未读计数，供有界页面装配复用。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只返回当前受信账户计数，不读取通知正文或完整账户。
 */
import type { QueryClient } from "../../shared/persistence/account-unit-of-work.mjs";
/** 与通知领域 notificationUnread 的终态/已读语义一致。 @since unreleased */
export async function readNotificationUnread({ client, accountId }: { client: QueryClient; accountId: string }): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*) AS count FROM for_now.store_objects
    WHERE account_id=$1 AND collection='notifications' AND parent_key IS NULL
      AND status=ANY($2::text[]) AND COALESCE(payload->>'readAt','')=''
  `, [accountId, ["succeeded", "failed", "stale", "cancelled"]]);
  return Number(result.rows[0].count);
}
