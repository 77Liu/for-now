export type FeishuNotifierOptions = Readonly<{
  webhook: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}>;

export type FeishuNotification = Readonly<{
  title: string;
  lines: readonly string[];
}>;

const ALLOWED_HOSTS = new Set([
  "open.feishu.cn",
  "open.larkoffice.com",
  "open.larksuite.com"
]);

/**
 * 创建飞书自定义机器人通知器；调用会向外部飞书服务发送通知，内容不得包含用户正文或凭据。
 */
export function createFeishuNotifier({
  webhook,
  secret,
  fetchImpl = fetch,
  now = Date.now
}: FeishuNotifierOptions): (message: FeishuNotification) => Promise<void> {
  const endpoint = new URL(webhook);
  if (endpoint.protocol !== "https:"
    || !ALLOWED_HOSTS.has(endpoint.hostname)
    || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+\/?$/.test(endpoint.pathname)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash) {
    throw new Error("飞书通知 Webhook 配置无效");
  }

  return async message => {
    const timestamp = String(Math.floor(now() / 1000));
    // 飞书签名必须使用“秒级时间戳 + 换行 + 密钥”做 HMAC-SHA256；密钥只参与本地签名，永不写入日志或正文。
    const content = [message.title, ...message.lines].join("\n").slice(0, 3500);
    const body: Record<string, unknown> = {
      msg_type: "text",
      content: { text: content }
    };
    if (secret?.trim()) {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(`${timestamp}\n${secret}`),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array()));
      const sign = btoa(Array.from(signature, byte => String.fromCharCode(byte)).join(""));
      Object.assign(body, { timestamp, sign });
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`飞书通知请求失败（HTTP ${response.status}）`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("飞书通知服务返回无效响应");
    }
    const result = payload as { code?: unknown; StatusCode?: unknown } | null;
    if (result?.code !== 0 && result?.StatusCode !== 0) {
      throw new Error("飞书通知服务返回失败状态");
    }
  };
}
